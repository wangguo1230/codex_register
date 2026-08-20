// @ts-nocheck
// 官方换绑子进程适配器：管理临时任务文件、阶段事件、超时和进程清理。
import {unlinkSync, writeFileSync} from "node:fs";
import {spawn} from "node:child_process";
import os from "node:os";
import path from "node:path";
import {attachBoundedStdio} from "../bounded-stdio.js";
import {cleanSpawnEnv} from "../strip-env-proxy.js";
import {terminateChildProcess} from "./child-process-control.js";
import {resolveWorkerCommand} from "../runtime-root.js";

const NETWORK_FAILURE = /fetch failed|timeout|timed out|ECONN|ENOTFOUND|EPIPE|socket|TLS|disconnected|Proxy connection/i;

export function createGmailRebindChangeWorker({
    root,
    tsxBin,
    timeoutMs,
    pickProxy,
    leaseImapProxy = null,
    maskProxy,
    spawnProcess = spawn,
    clock = globalThis,
    graceMs = 5_000,
} = {}) {
    const worker = resolveWorkerCommand(
        import.meta.url,
        root,
        "scripts/worker-change-email.ts",
        "bundle/workers/worker-change-email.mjs",
    );
    if (tsxBin && !worker.bundled) {
        worker.command = tsxBin;
        worker.args = [];
    }

    function spawnWorker({accessToken, accountId, cookie, newEmail, imapPassword, mailPassword, totpSecret, proxyUrl, imapProxyUrl = "", imapProxyJump = "", note, onStage, signal}) {
        if (signal?.aborted) {
            return Promise.resolve({ok: false, cancelled: true, indeterminate: false, reason: "已取消换绑", stage: "precheck"});
        }
        const jobFile = path.join(os.tmpdir(), `change-email-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`);
        writeFileSync(jobFile, JSON.stringify({
            accessToken,
            accountId,
            cookie: cookie || "",
            newEmail,
            imapPassword: imapPassword || "",
            mailPassword: mailPassword || "",
            totpSecret: totpSecret || "",
        }));

        return new Promise((resolve) => {
            let settled = false;
            let lastStage = "precheck";
            let child;
            let cancelForcedKill = null;
            try {
                child = spawnProcess(worker.command, [...worker.args, jobFile], {
                    cwd: root,
                    env: cleanSpawnEnv({
                        PROXY_URL: proxyUrl || "",
                        MAIL_PROXY_JUMP: "",
                        IMAP_PROXY: imapProxyUrl || "",
                        IMAP_PROXY_JUMP: imapProxyJump || "",
                        ...(imapProxyUrl && imapProxyJump ? {ALLOW_LOCAL_SOCKS_RELAY: "1"} : {}),
                    }),
                    stdio: ["ignore", "pipe", "pipe"],
                });
            } catch (error) {
                try { unlinkSync(jobFile); } catch { /* */ }
                resolve({ok: false, reason: String(error?.message || error).slice(0, 160), stage: lastStage});
                return;
            }
            const finish = (result) => {
                if (settled) return;
                settled = true;
                clock.clearTimeout(timer);
                signal?.removeEventListener?.("abort", onAbort);
                try { unlinkSync(jobFile); } catch { /* */ }
                cancelForcedKill = terminateChildProcess(child, {graceMs, clock});
                resolve({stage: lastStage, ...result});
            };
            const lost = (reason) => finish({
                ok: false,
                reason,
                indeterminate: lastStage === "verify",
            });
            const onAbort = () => finish({
                ok: false,
                cancelled: true,
                reason: "已取消换绑",
                indeterminate: lastStage === "verify",
            });
            signal?.addEventListener?.("abort", onAbort, {once: true});
            const timer = clock.setTimeout(() => {
                lost(`官方换绑超时 ${Math.round(timeoutMs / 1000)}s（停在 ${lastStage} 阶段）`);
            }, timeoutMs);
            timer?.unref?.();

            attachBoundedStdio(child, {
                onLine: (line) => note(String(line || "").slice(0, 200)),
                onEvent: (event) => {
                    if (!event || event.type === "progress") {
                        if (event?.stage) {
                            lastStage = String(event.stage);
                            try { onStage(lastStage); } catch { /* 阶段观测不影响换绑 */ }
                            note(`阶段 → ${lastStage}`);
                        }
                        if (event?.message) note(event.message);
                        return;
                    }
                    if (event.stage) {
                        lastStage = String(event.stage);
                        try { onStage(lastStage); } catch { /* */ }
                    }
                    const reason = event.reason || event.error || "";
                    const stage = String(event.stage || lastStage || "");
                    finish({
                        ok: !!event.ok,
                        reason,
                        needReauth: !!event.needReauth,
                        alreadyLinked: !!event.alreadyLinked,
                        badTarget: !!event.badTarget,
                        rateLimited: !!event.rateLimited,
                        capped24h: !!event.capped24h,
                        pwdWindowExpired: !!event.pwdWindowExpired,
                        code: event.code || "",
                        indeterminate: !!(event.indeterminate
                            || (!event.ok && (stage === "verify" || /^verify\b/i.test(reason))
                                && NETWORK_FAILURE.test(String(reason)))),
                    });
                },
            });
            child.on("error", (error) => lost(String(error?.message || error).slice(0, 160)));
            child.on("close", () => {
                cancelForcedKill?.();
                if (!settled) lost("官方换绑子进程无结果");
            });
            if (signal?.aborted) onAbort();
        });
    }

    return async function runChangeEmail({
        accessToken,
        accountId = "",
        cookie = "",
        newEmail,
        imapPassword,
        mailPassword = "",
        totpSecret = "",
        log = () => {},
        onStage = () => {},
        signal,
    } = {}) {
        const note = (message) => { try { log(message); } catch { /* 观测不影响换绑 */ } };
        if (signal?.aborted) return {ok: false, cancelled: true, indeterminate: false, reason: "已取消换绑", stage: "precheck"};
        const proxyUrl = await pickProxy() || "";
        if (signal?.aborted) return {ok: false, cancelled: true, indeterminate: false, reason: "已取消换绑", stage: "precheck"};
        if (!proxyUrl) return {ok: false, reason: "官方换绑需要本机 10808（chatgpt.com HTTP）"};
        note(`官方换绑走 ${maskProxy(proxyUrl)}（chatgpt.com HTTP，不走 kookeey）`);
        const runWorker = (imapProxyUrl = "", imapProxyJump = "") => spawnWorker({
            accessToken,
            accountId,
            cookie,
            newEmail,
            imapPassword,
            mailPassword,
            totpSecret,
            proxyUrl,
            imapProxyUrl,
            imapProxyJump,
            note,
            onStage,
            signal,
        });
        const needsImapProxy = /@(gmail|googlemail)\.com$/i.test(String(newEmail || ""));
        if (needsImapProxy && typeof leaseImapProxy === "function") {
            return leaseImapProxy(`imap:${newEmail}`, (imapProxyUrl, imapProxyJump) => runWorker(imapProxyUrl, imapProxyJump));
        }
        return runWorker();
    };
}
