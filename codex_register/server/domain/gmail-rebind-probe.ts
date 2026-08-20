// @ts-nocheck
// 换绑探 Gmail 登录。必须在子进程跑：比特 CDP 挂在 :3100 会把整站内存打到几十 GB。
import {spawn} from "node:child_process";
import {unlinkSync, writeFileSync} from "node:fs";
import os from "node:os";
import path from "node:path";
import {ensureGoogleLoggedIn} from "../../src/mail/google-auth.js";
import {withGoogleBitSession} from "../../src/mail/google-secure.js";
import {isCredentialDead, isHardenIpError, isHardenLoginDead} from "../../src/mail/google-state.js";
import {mailJumpPool, mailProxyPool, maskProxyUrl, JUMP_MAX_EXITS} from "../../src/mail/proxy-pool.js";
import {scheduler} from "../scheduler.js";
import {cleanSpawnEnv} from "../strip-env-proxy.js";
import {attachBoundedStdio} from "../bounded-stdio.js";
import {signalChildProcess, terminateChildProcess} from "./child-process-control.js";
import {createMailProxyLease} from "./mail-proxy-lease.js";
import {resolveProjectRoot, resolveWorkerCommand} from "../runtime-root.js";

const ROOT = resolveProjectRoot(import.meta.url);
const WORKER = resolveWorkerCommand(
    import.meta.url,
    ROOT,
    "scripts/worker-gmail-login.ts",
    "bundle/workers/worker-gmail-login.mjs",
);
// 跳板+池链式很慢：探出口 20–30s、开窗、登录页模块、换 session 再来一轮，180s 经常刚登到一半就被掐。
const GMAIL_PROBE_MS = Math.max(180_000, Number(process.env.GMAIL_PROBE_TIMEOUT_MS || 480_000));

function googleBitName(prefix, email) {
    return `${prefix}-${String(email || "").split("@")[0].slice(0, 12)}`;
}

function gmailLoginDead(err) {
    const s = String(err || "");
    if (isHardenIpError(s)) return false;
    if (isCredentialDead(s) || isHardenLoginDead(s)) return true;
    return /Wrong password|Wrong code|incorrect code|that code didn.?t work|密码错误|验证码有误|账号已停用|account has been disabled|Couldn't find your Google/i.test(s);
}

function isGmailLoginProxyError(err) {
    const s = String(err || "");
    if (isHardenIpError(s)) return true;
    return /signin\/rejected|出口已被风控|换 session 重开窗|代理中断|ERR_PROXY|ERR_TUNNEL|ERR_CONNECTION|ERR_SSL|代理不通|比特已退出|未登录|端口不通|ConnectionRefused|跳板连不上|ECONNREFUSED|has been closed|Target page|browser has been closed|窗口被关|operation was aborted|比特API .+ 超时|开窗超时/i.test(s);
}

const withLeasedMailProxy = createMailProxyLease({
    proxyPool: mailProxyPool,
    jumpPool: mailJumpPool,
    getFallbackProxy: () => scheduler.mailProxyFallback(),
    getFallbackJump: () => scheduler.mailProxyJump || "",
    getMaxPerTemplate: () => 1,
    maxPerJump: JUMP_MAX_EXITS,
    resolveJumpUrl: async (fallback) => {
        try {
            const {liveJumpSocks} = await import("../xray-proxy.js");
            return await liveJumpSocks() || fallback;
        } catch {
            return fallback;
        }
    },
});

export async function probeGmailWebLogin(mb, log = () => {}, onVerdict = null, lease = {}) {
    const email = String(mb?.email || "").trim();
    const password = String(mb?.password || "").trim();
    const totpSecret = String(mb?.totp_secret || mb?.mailbox_totp || "").trim();
    const recoveryEmail = String(mb?.recovery_email || "").trim();
    if (!email) return {ok: false, error: "无邮箱", dead: true};
    if (!password) return {ok: false, error: "无登录密码", dead: true};
    if (!totpSecret) return {ok: false, error: "无 Gmail 2FA", dead: true};

    const notes = [];
    const write = (m) => {
        const s = String(m || "");
        notes.push(s);
        try { log(s); } catch { /* */ }
    };
    let verdictSent = false;
    const emitVerdict = (r) => {
        if (verdictSent || typeof onVerdict !== "function") return r;
        verdictSent = true;
        try { onVerdict(r); } catch { /* */ }
        return r;
    };

    const runOnPage = async (page, sess) => {
        page.setDefaultTimeout(45000);
        const r = await ensureGoogleLoggedIn(
            page,
            "https://myaccount.google.com/security?hl=en",
            {email, password, totpSecret, recoveryEmail, requireInbox: false},
            write,
        );
        if (r) {
            try { sess?.markLoggedIn?.(); } catch { /* */ }
            // 登录成败先报，关窗挂住不能把成功改成超时。
            emitVerdict({ok: true});
        }
        return r;
    };

    const runWithProxy = async (proxyUrl, jumpUrl) => {
        write(`  比特 · 出口 ${maskProxyUrl(proxyUrl) || "无"}${jumpUrl ? " · 跳板 " + maskProxyUrl(jumpUrl) + "（链式）" : " · 无跳板"}`);
        return withGoogleBitSession({
            proxyUrl, jumpUrl, name: googleBitName("rebind", email),
            remark: "gmail-rebind-probe", log: write,
        }, runOnPage);
    };

    // 传入 lease 时由父进程统一分配资源；独立脚本调用时保留旧的自租约兼容。
    try {
        write("  网页登录探活：链式（跳板 + 邮箱代理池，同邮箱管理）");
        const ok = lease.hasLease
            ? await runWithProxy(String(lease.proxyUrl), String(lease.jumpUrl || ""))
            : await withLeasedMailProxy(email, runWithProxy, mb);
        if (ok) return emitVerdict({ok: true});
        const joined = notes.join("\n");
        if (isGmailLoginProxyError(joined)) {
            return emitVerdict({
                ok: false,
                error: String(notes.find((l) => /拒绝|rejected|代理|风控|不通|跳板/i.test(l)) || "出口被风控").slice(0, 160),
                dead: false,
                proxyDead: true,
            });
        }
        const hint = notes.find((l) => /Wrong|错误|失败|disabled|停用|找不到|code|密码/i.test(l)) || "登录失败";
        return emitVerdict({ok: false, error: String(hint).slice(0, 160), dead: gmailLoginDead(joined), proxyDead: false});
    } catch (e) {
        const err = String(e?.message || e).slice(0, 160);
        return emitVerdict({ok: false, error: err, dead: gmailLoginDead(err), proxyDead: isGmailLoginProxyError(err) || /代理池全忙|超时|lease/i.test(err)});
    }
}

/** 父进程调用：开子进程探登录，CDP 崩溃也只死孩子。 */
function spawnGmailLoginWorker(mb, log = () => {}, lease = {}, {signal} = {}) {
    if (signal?.aborted) {
        return Promise.resolve({ok: false, error: "已取消换绑", dead: false, proxyDead: false, cancelled: true});
    }
    const jobFile = path.join(os.tmpdir(), `gmail-probe-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`);
    writeFileSync(jobFile, JSON.stringify({
        email: mb?.email || "",
        password: mb?.password || "",
        totp_secret: mb?.totp_secret || mb?.mailbox_totp || "",
        mailbox_totp: mb?.mailbox_totp || mb?.totp_secret || "",
        recovery_email: mb?.recovery_email || "",
        proxy_url: mb?.proxy_url || "",
        probe_proxy_url: lease.proxyUrl || "",
        probe_jump_url: lease.jumpUrl || "",
        probe_has_lease: lease.hasLease === true,
    }));
    return new Promise((resolve) => {
        let child;
        let settled = false;
        let gotResult = false;
        let timer = null;
        let graceTimer = null;
        let cancelForcedKill = null;
        const tail = [];
        const normalizeResult = (result) => ({
            ok: !!result?.ok,
            error: result?.error || "",
            dead: !!result?.dead,
            proxyDead: !!result?.proxyDead,
        });
        const finish = (result, {gracefulResult = false} = {}) => {
            if (settled) return;
            settled = true;
            if (timer) clearTimeout(timer);
            signal?.removeEventListener?.("abort", onAbort);
            try { unlinkSync(jobFile); } catch { /* */ }
            if (gracefulResult) {
                graceTimer = setTimeout(() => signalChildProcess(child, "SIGKILL", {tree: true}), 12_000);
                graceTimer?.unref?.();
            } else {
                cancelForcedKill = terminateChildProcess(child, {graceMs: 5_000, tree: true});
            }
            resolve(result);
        };
        const acceptResult = (result) => {
            gotResult = true;
            finish(normalizeResult(result), {gracefulResult: true});
        };
        const onAbort = () => finish({
            ok: false,
            error: "已取消换绑",
            dead: false,
            proxyDead: false,
            cancelled: true,
        });
        signal?.addEventListener?.("abort", onAbort, {once: true});
        try {
            child = spawn(WORKER.command, [...WORKER.args, jobFile], {
                cwd: ROOT,
                env: cleanSpawnEnv({
                    MAIL_PROXY_JUMP: scheduler.mailProxyJump || scheduler.gptProxyJump || "",
                    GMAIL_WORKER: "1",
                }),
                stdio: ["ignore", "pipe", "pipe"],
                detached: process.platform !== "win32",
            });
        } catch (error) {
            finish({ok: false, error: String(error?.message || error).slice(0, 160), dead: false, proxyDead: true});
            return;
        }
        const pending = attachBoundedStdio(child, {
            maxBuf: 512 * 1024,
            lineLimit: 220,
            onLine: (line) => {
                tail.push(String(line));
                if (tail.length > 20) tail.shift();
                try { log(String(line)); } catch { /* */ }
            },
            onEvent: acceptResult,
        });
        timer = setTimeout(() => {
            // 已有 RESULT 就只杀进程，不再把成功改成超时。
            if (gotResult) {
                signalChildProcess(child, "SIGKILL", {tree: true});
                return;
            }
            finish({ok: false, error: `探登录超时 ${Math.round(GMAIL_PROBE_MS / 1000)}s`, dead: false, proxyDead: true});
        }, GMAIL_PROBE_MS);
        timer?.unref?.();
        child.on("error", (e) => finish({ok: false, error: String(e?.message || e).slice(0, 160), dead: false, proxyDead: true}));
        child.on("close", () => {
            if (graceTimer) clearTimeout(graceTimer);
            cancelForcedKill?.();
            pending.flush?.();
            if (!settled) finish({
                ok: false,
                error: (tail.join(" ") || "探登录子进程无结果").replace(/\s+/g, " ").slice(-200),
                dead: false,
                proxyDead: true,
            });
        });
        if (signal?.aborted) onAbort();
    });
}

/** 父进程统一持有邮箱/跳板租约，子进程只负责浏览器和 CDP。 */
export async function runGmailLoginWorker(mb, log = () => {}, {signal} = {}) {
    if (signal?.aborted) return {ok: false, error: "已取消换绑", dead: false, proxyDead: false, cancelled: true};
    try {
        return await withLeasedMailProxy(
        `gmail-probe:${mb?.email || mb?.id || ""}`,
        (proxyUrl, jumpUrl) => spawnGmailLoginWorker(mb, log, {proxyUrl, jumpUrl, hasLease: true}, {signal}),
        mb,
        {signal},
        );
    } catch (error) {
        if (signal?.aborted || error?.name === "AbortError") {
            return {ok: false, error: "已取消换绑", dead: false, proxyDead: false, cancelled: true};
        }
        return {ok: false, error: String(error?.message || error).slice(0, 160), dead: false, proxyDead: true};
    }
}
