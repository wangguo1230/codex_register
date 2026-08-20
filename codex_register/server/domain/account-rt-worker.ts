// @ts-nocheck
import {mkdtempSync, rmSync} from "node:fs";
import os from "node:os";
import path from "node:path";

export function createAccountRtWorker({runtime, store, files, settings, proxy, effects, credentials, timeouts = {}} = {}) {
    const idleDefaultMs = Math.max(60_000, Number(timeouts.idleMs || process.env.RT_WORKER_IDLE_MS || 180_000));
    const maxMs = Math.max(idleDefaultMs * 2, Number(timeouts.maxMs || process.env.RT_WORKER_MAX_MS || 1_200_000));
    const graceMs = Math.max(3_000, Number(timeouts.graceMs || process.env.RT_WORKER_GRACE_MS || 12_000));

    async function run(account, preferPhone, {onProgress, timeoutMs = 0, onChild} = {}) {
        const idleMs = Math.max(idleDefaultMs, Number(timeoutMs) || 0);
        const note = (message) => {
            try { onProgress?.(String(message || "").slice(0, 160)); } catch { /* */ }
        };
        try {
            return await proxy.withLease(`rt-acquire:${account.email || account.id}`, async (exit, jump) => {
                let proxyUrl = String(exit || "").trim();
                if (!proxyUrl) {
                    proxyUrl = settings.rtProxy() || settings.regProxy();
                    note(`GPT 池空，回退 ${proxy.mask(proxyUrl) || "无代理"}`);
                } else {
                    note(`GPT 池 ${proxy.mask(proxyUrl)}${jump ? " +跳板 " + proxy.mask(jump) : ""}（转发在子进程，不进 3100）`);
                }
                const configuredMailProxy = settings.mailProxyEnabled() ? settings.mailProxy() : "";
                const mailProxy = await proxy.pickXray(configuredMailProxy, settings.rechargeProxy(), settings.rtProxy())
                    || proxy.pickMailBrowser(configuredMailProxy, settings.rechargeProxy(), settings.rtProxy());

                let tempDir;
                let child;
                try {
                    tempDir = mkdtempSync(path.join(os.tmpdir(), "codex-rt-"));
                    const credentialFile = path.join(tempDir, `mc-${account.id}.txt`);
                    files.writeCredential(credentialFile, {
                        email: account.email,
                        password: account.password,
                        mailboxTotp: account.mailbox_totp || "",
                        recoveryEmail: account.recovery_email || "",
                        imapPassword: account.mailbox_imap || "",
                    });
                    const useSessionRt = !!String(account.totp_secret || "").trim()
                        || account.provider === "mailcom"
                        || /pro|plus|team/i.test(String(account.plan || ""));
                    const headless = process.env.MAILCOM_HEADED === "1" ? "0" : "1";
                    note(`启动 worker 获取 refresh_token${useSessionRt ? "(会话换rt,不接码)" : ""}${preferPhone ? `(复用绑定号 +${preferPhone})` : ""}${account.mailbox_imap ? " +IMAP" : ""}…`);
                    note(`GPT 协议代理=${proxy.mask(proxyUrl) || "直连"} · mail.com 收码=${proxy.mask(mailProxy) || "直连"}`);
                    child = runtime.spawn([useSessionRt ? "scripts/worker-rt-nosms.ts" : "src/worker-rt.ts"], runtime.cleanEnv({
                        REG_EMAIL: account.email,
                        MAIL_PROVIDER: account.provider || "mailcom",
                        MAILCOM_TOKENS_FILE: credentialFile,
                        ICLOUD_TOKENS_FILE: credentialFile,
                        MAILCOM_HEADLESS: headless,
                        SMS_LINK_TEMPLATE: settings.smsLinkTemplate(),
                        SMS_MAX_BIND: String(settings.smsMaxBind()),
                        RT_PREFER_PHONE: preferPhone || "",
                        PROXY_URL: proxyUrl,
                        MAIL_PROXY_JUMP: jump || "",
                        MAILCOM_PROXY: mailProxy,
                        GPT_PASSWORD: String(account.gpt_password || settings.defaultPassword() || "").trim(),
                        TOTP_SECRET: account.totp_secret || "",
                    }));
                } catch (error) {
                    try { if (tempDir) rmSync(tempDir, {recursive: true, force: true}); } catch { /* */ }
                    const reason = `启动 rt worker 失败: ${String(error?.message || error).slice(0, 140)}`;
                    await effects.setStatus(account.id, "rt", "❌启动失败:" + reason.slice(0, 60));
                    return {ok: false, reason};
                }
                try { onChild?.(child); } catch { /* 子进程跟踪失败不改变 RT 获取 */ }

                return new Promise((resolve) => {
                    let settled = false;
                    let timedOut = false;
                    let terminalPending = false;
                    let result = null;
                    let persistPromise = null;
                    let idleTimer = null;
                    let capTimer = null;
                    let graceTimer = null;
                    let hardTimer = null;
                    const cleanup = () => {
                        for (const timer of [idleTimer, capTimer, graceTimer, hardTimer]) if (timer) clearTimeout(timer);
                        try { rmSync(tempDir, {recursive: true, force: true}); } catch { /* */ }
                    };
                    const finish = (value) => {
                        if (settled) return;
                        settled = true;
                        cleanup();
                        try { if (!child.killed) child.kill("SIGKILL"); } catch { /* */ }
                        resolve(value);
                    };
                    const persistSuccess = () => {
                        if (persistPromise) return persistPromise;
                        persistPromise = (async () => {
                            try {
                                const rtData = files.readJson(result.rtFile);
                                await store.setRtFile(account.id, result.rtFile || "", rtData);
                                if (result.phone) await store.setPhone(account.id, result.phone);
                                if (result.card) await store.setCard(account.id, result.card);
                                await effects.setStatus(account.id, "rt", "✅已获取rt");
                                await effects.emitSmsStats();
                                const tokens = credentials.extract(rtData);
                                const plan = await effects.syncPlan(account, tokens?.accessToken, tokens?.accountId);
                                if (plan) note(`套餐 → ${plan}`);
                                finish({ok: true, refresh_token: result.rt, plan_type: plan || ""});
                            } catch (error) {
                                const reason = String(error?.message || error).slice(0, 120);
                                note(`rt 已拿到但写库失败: ${reason}（文件 ${result?.rtFile || "无"}）`);
                                finish({ok: false, reason: `rt 已拿到但写库失败: ${reason}`});
                            }
                        })();
                        return persistPromise;
                    };
                    const wrapUp = (reason) => {
                        if (settled || timedOut) return;
                        timedOut = true;
                        note(`${reason}，SIGTERM 收尾，留 ${Math.round(graceMs / 1000)}s 让已拿到的 rt 落库…`);
                        try { child.kill("SIGTERM"); } catch { /* */ }
                        graceTimer = setTimeout(() => { try { child.kill("SIGKILL"); } catch { /* */ } }, graceMs);
                        hardTimer = setTimeout(() => {
                            if (settled) return;
                            if (result?.status === "success") {
                                void persistSuccess();
                                return;
                            }
                            void effects.setStatus(account.id, "rt", "❌获取失败:" + reason);
                            finish({ok: false, reason});
                        }, graceMs + 3_000);
                    };
                    const armIdle = () => {
                        if (idleTimer) clearTimeout(idleTimer);
                        if (!settled && !timedOut) {
                            idleTimer = setTimeout(() => wrapUp(`连续 ${Math.round(idleMs / 1000)}s 无新日志，判定取码/OAuth卡住`), idleMs);
                        }
                    };

                    armIdle();
                    capTimer = setTimeout(() => wrapUp(`已跑满 ${Math.round(maxMs / 60_000)} 分钟上限`), maxMs);
                    runtime.pipeOutput(child, {
                        onLine: (line) => { armIdle(); note(line); },
                        onEvent: (event) => {
                            armIdle();
                            if (event?.type === "progress") note(event.message);
                            else if (event?.type === "result") result = event;
                        },
                    });
                    child.once("error", (error) => {
                        if (settled) return;
                        terminalPending = true;
                        const reason = String(error?.message || error);
                        void (async () => {
                            await effects.setStatus(account.id, "rt", "❌启动失败:" + reason);
                            finish({ok: false, reason});
                        })();
                    });
                    child.once("close", () => {
                        cleanup();
                        if (settled || terminalPending) return;
                        if (result?.status === "success") {
                            void persistSuccess();
                            return;
                        }
                        const reason = result?.error || (timedOut ? "取码/OAuth卡住，已收尾" : "获取失败");
                        terminalPending = true;
                        void (async () => {
                            await effects.setStatus(account.id, "rt", "❌获取失败:" + String(reason).slice(0, 60));
                            finish({ok: false, reason});
                        })();
                    });
                });
            }, {timeoutMs: 45_000, log: note});
        } catch (error) {
            const reason = String(error?.message || error).slice(0, 160);
            await effects.setStatus(account.id, "rt", "❌获取失败:" + reason.slice(0, 60));
            return {ok: false, reason};
        }
    }

    return {run};
}
