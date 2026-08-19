// @ts-nocheck
// 换绑探 Gmail 登录。必须在子进程跑：比特 CDP 挂在 :3100 会把整站内存打到几十 GB。
import {spawn} from "node:child_process";
import {existsSync, unlinkSync, writeFileSync} from "node:fs";
import os from "node:os";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {ensureGoogleLoggedIn} from "../../src/mail/google-auth.js";
import {withGoogleBitSession} from "../../src/mail/google-secure.js";
import {isCredentialDead, isHardenIpError, isHardenLoginDead} from "../../src/mail/google-state.js";
import {mailJumpPool, mailProxyPool, maskProxyUrl, JUMP_MAX_EXITS} from "../../src/mail/proxy-pool.js";
import {scheduler} from "../scheduler.js";
import {cleanSpawnEnv} from "../strip-env-proxy.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const TSX_BIN = existsSync(path.join(ROOT, "node_modules", ".bin", "tsx"))
    ? path.join(ROOT, "node_modules", ".bin", "tsx")
    : "tsx";
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

async function withLeasedMailProxy(owner, fn, mb = null, opts = {}) {
    const who = String(owner || "gmail-probe");
    const prefer = String(mb?.proxy_url || "").trim();
    const skipJump = opts?.skipJump === true;
    let jumpLease = null;
    let lease = null;
    // 两个租约共用一个 finally：出口池全忙时下面那行会抛，跳板租约不归还就是永久泄漏。
    try {
        if (!skipJump && mailJumpPool.urls.length) {
            jumpLease = await mailJumpPool.lease(who, {timeoutMs: 45_000, maxPerJump: JUMP_MAX_EXITS});
        }
        lease = await mailProxyPool.lease(who, {
            fallback: scheduler.mailProxyFallback(),
            maxPerTemplate: 1,
            freshSession: !prefer,
            preferUrl: prefer,
        });
        let jumpUrl = skipJump ? "" : (jumpLease?.url || scheduler.mailProxyJump || "");
        if (!skipJump) {
            try {
                const {liveJumpSocks} = await import("../xray-proxy.js");
                const live = await liveJumpSocks();
                if (live) jumpUrl = live;
            } catch { /* 子进程没起 fleet 就用上面的 jumpUrl */ }
        }
        return await fn(lease.url, jumpUrl);
    } finally {
        try { lease?.release(); } catch { /* */ }
        try { jumpLease?.release(); } catch { /* */ }
    }
}

export async function probeGmailWebLogin(mb, log = () => {}, onVerdict = null) {
    const email = String(mb?.email || "").trim();
    const password = String(mb?.password || "").trim();
    const totpSecret = String(mb?.totp_secret || mb?.mailbox_totp || "").trim();
    const recoveryEmail = String(mb?.recovery_email || "").trim();
    if (!email) return {ok: false, error: "无邮箱", dead: true};
    if (!password) return {ok: false, error: "无登录密码", dead: true};
    if (!totpSecret) return {ok: false, error: "无 Gmail 2FA", dead: true};

    let lastErr = "";
    let sawProxyDead = false;
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

    // 和邮箱管理同一条：邮箱代理池 + 跳板池，withGoogleBitSession 自己套链。
    try {
        write("  网页登录探活：链式（跳板 + 邮箱代理池，同邮箱管理）");
        const ok = await withLeasedMailProxy(email, async (proxyUrl, jumpUrl) => {
            write(`  比特 · 出口 ${maskProxyUrl(proxyUrl) || "无"}${jumpUrl ? " · 跳板 " + maskProxyUrl(jumpUrl) + "（链式）" : " · 无跳板"}`);
            return withGoogleBitSession({
                proxyUrl, jumpUrl, name: googleBitName("rebind", email),
                remark: "gmail-rebind-probe", log: write,
            }, runOnPage);
        }, mb);
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
export function runGmailLoginWorker(mb, log = () => {}) {
    const jobFile = path.join(os.tmpdir(), `gmail-probe-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`);
    writeFileSync(jobFile, JSON.stringify({
        email: mb?.email || "",
        password: mb?.password || "",
        totp_secret: mb?.totp_secret || mb?.mailbox_totp || "",
        mailbox_totp: mb?.mailbox_totp || mb?.totp_secret || "",
        recovery_email: mb?.recovery_email || "",
        proxy_url: mb?.proxy_url || "",
    }));
    return new Promise((resolve) => {
        const child = spawn(TSX_BIN, ["scripts/worker-gmail-login.ts", jobFile], {
            cwd: ROOT,
            env: cleanSpawnEnv({
                MAIL_PROXY_JUMP: scheduler.mailProxyJump || scheduler.gptProxyJump || "",
                GMAIL_WORKER: "1",
            }),
            stdio: ["ignore", "pipe", "pipe"],
            detached: process.platform !== "win32",
        });
        const killChild = () => {
            try {
                if (process.platform !== "win32" && child.pid) process.kill(-child.pid, "SIGKILL");
                else child.kill("SIGKILL");
            } catch {
                try { child.kill("SIGKILL"); } catch { /* */ }
            }
        };
        let out = "";
        const pump = (buf) => {
            const s = String(buf || "");
            out += s;
            if (out.length > 512 * 1024) out = out.slice(-256 * 1024);
            for (const line of s.split(/\r?\n/)) {
                const t = line.trim();
                if (!t) continue;
                if (t.startsWith("@@RESULT@@")) {
                    try {
                        const r = JSON.parse(t.slice("@@RESULT@@".length));
                        gotResult = true;
                        finish({
                            ok: !!r.ok,
                            error: r.error || "",
                            dead: !!r.dead,
                            proxyDead: !!r.proxyDead,
                        });
                    } catch { /* */ }
                    continue;
                }
                try { log(t.slice(0, 220)); } catch { /* */ }
            }
        };
        child.stdout?.on("data", pump);
        child.stderr?.on("data", pump);
        let settled = false;
        let gotResult = false;
        let graceTimer = null;
        const timer = setTimeout(() => {
            // 已有 RESULT 就只杀进程，不再把成功改成超时。
            if (gotResult) {
                try { killChild(); } catch { /* */ }
                return;
            }
            finish({ok: false, error: `探登录超时 ${Math.round(GMAIL_PROBE_MS / 1000)}s`, dead: false, proxyDead: true});
        }, GMAIL_PROBE_MS);
        const finish = (r) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            if (graceTimer) clearTimeout(graceTimer);
            try { unlinkSync(jobFile); } catch { /* */ }
            if (gotResult) {
                // RESULT 已定：给关窗 12s，再杀。
                graceTimer = setTimeout(() => { try { killChild(); } catch { /* */ } }, 12_000);
            } else {
                try { killChild(); } catch { /* */ }
            }
            resolve(r);
        };
        child.on("error", (e) => finish({ok: false, error: String(e?.message || e).slice(0, 160), dead: false, proxyDead: true}));
        child.on("close", () => {
            const hit = out.split(/\r?\n/).reverse().find((l) => l.startsWith("@@RESULT@@"));
            if (hit) {
                try {
                    const r = JSON.parse(hit.slice("@@RESULT@@".length));
                    gotResult = true;
                    finish({
                        ok: !!r.ok,
                        error: r.error || "",
                        dead: !!r.dead,
                        proxyDead: !!r.proxyDead,
                    });
                    return;
                } catch { /* */ }
            }
            finish({ok: false, error: (out || "探登录子进程无结果").replace(/\s+/g, " ").slice(-200), dead: false, proxyDead: true});
        });
    });
}
