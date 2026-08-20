// @ts-nocheck
// 独立 Token Worker 运行器：负责临时凭证、子进程、超时和强制停止。
import {mkdtempSync, rmSync} from "node:fs";
import os from "node:os";
import path from "node:path";
import {terminateChildProcess} from "./child-process-control.js";

export function createTokenWorkerRunner({store, runtime, settings, files, withProxy, pickMailProxy, effects, timeouts = {}, clock = globalThis} = {}) {
    const idleMs = Math.max(60_000, Number(timeouts.idleMs || process.env.RT_WORKER_IDLE_MS || 180_000));
    const maxMs = Math.max(idleMs * 2, Number(timeouts.maxMs || process.env.RT_WORKER_MAX_MS || 1_200_000));
    const graceMs = Math.max(3_000, Number(timeouts.graceMs || process.env.RT_WORKER_GRACE_MS || 12_000));
    const atIdleMs = Math.max(60_000, Number(timeouts.atIdleMs || process.env.AT_WORKER_IDLE_MS || idleMs));
    const atMaxMs = Math.max(atIdleMs * 2, Number(timeouts.atMaxMs || process.env.AT_WORKER_MAX_MS || maxMs));
    let currentRtChild = null;
    let currentRtAbort = null;
    let currentAtStop = null;
    let currentAtAbort = null;

    function createCredentialFile(prefix, email, credential) {
        const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
        const file = path.join(dir, "mailbox.txt");
        files.writeCredential(file, {email, ...credential});
        return {
            file,
            cleanup: () => {
                try { rmSync(dir, {force: true, recursive: true}); } catch { /* */ }
            },
        };
    }

    async function runAt(email, password) {
        const abortController = new AbortController();
        currentAtAbort = abortController;
        return withProxy(`at-sa:${email}`, async (exit, jump) => {
            let temp;
            try {
                const mailbox = await store.getMailbox(email);
                const account = await store.getAccount(email);
                temp = createCredentialFile("codex-relogin-sa-", email, {
                    password: password || mailbox?.password || "",
                    mailboxTotp: mailbox?.totp_secret || "",
                    recoveryEmail: mailbox?.recovery_email || "",
                    imapPassword: mailbox?.imap_password || "",
                });
                effects.log("AT", email, "走协议登录获取 at…");
                return await new Promise((resolve) => {
                    let settled = false;
                    let stopping = false;
                    let stopReason = "";
                    let result = null;
                    let child = null;
                    let idleTimer = null;
                    let capTimer = null;
                    let hardTimer = null;
                    let cancelForcedKill = null;
                    const finish = (value) => {
                        if (settled) return;
                        settled = true;
                        for (const timer of [idleTimer, capTimer, hardTimer]) {
                            if (timer) clock.clearTimeout(timer);
                        }
                        cancelForcedKill?.();
                        if (currentAtStop === stopWorker) currentAtStop = null;
                        temp.cleanup();
                        resolve(value);
                    };
                    const stopWorker = (reason = "已停止") => {
                        if (settled || stopping) return;
                        stopping = true;
                        stopReason = reason;
                        effects.log("AT", email, `${reason}，终止 worker`);
                        cancelForcedKill = terminateChildProcess(child, {graceMs, clock});
                        hardTimer = clock.setTimeout(() => finish({ok: false, reason}), graceMs + 1_000);
                        hardTimer?.unref?.();
                    };
                    const armIdle = () => {
                        if (idleTimer) clock.clearTimeout(idleTimer);
                        if (!settled && !stopping) {
                            idleTimer = clock.setTimeout(
                                () => stopWorker(`连续 ${Math.round(atIdleMs / 1000)}s 无新日志，判定登录卡住`),
                                atIdleMs,
                            );
                            idleTimer?.unref?.();
                        }
                    };
                    child = runtime.spawn(["src/worker-login-http.ts"], runtime.cleanEnv({
                        REG_EMAIL: email,
                        MAIL_PROVIDER: mailbox?.provider || settings.providerOf(email),
                        MAILCOM_TOKENS_FILE: temp.file,
                        ICLOUD_TOKENS_FILE: temp.file,
                        MAILCOM_HEADLESS: "1",
                        PROXY_URL: exit || settings.regProxy(),
                        MAIL_PROXY_JUMP: jump || "",
                        MAILCOM_PROXY: settings.mailProxy(),
                        REG_SIMULATE_CHAT: "",
                        REG_TRY_RT: "0",
                        GPT_PASSWORD: (account?.gpt_password || settings.defaultPassword()).trim(),
                        TOTP_SECRET: account?.totp_secret || "",
                        REG_TRY_MFA: account?.totp_secret ? "0" : "1",
                    }));
                    currentAtStop = stopWorker;
                    armIdle();
                    capTimer = clock.setTimeout(
                        () => stopWorker(`已跑满 ${Math.round(atMaxMs / 60_000)} 分钟上限`),
                        atMaxMs,
                    );
                    capTimer?.unref?.();
                    child.once("error", (error) => {
                        effects.log("AT", email, `worker 启动失败: ${error?.message || error}`);
                        finish({ok: false, reason: String(error?.message || error)});
                    });
                    runtime.pipeOutput(child, {
                        onLine: (line) => {
                            armIdle();
                            effects.log("AT", email, line);
                        },
                        onEvent: (event) => {
                            armIdle();
                            if (event?.type === "result") result = event;
                            else if (event?.message) effects.log("AT", email, event.message);
                        },
                    });
                    child.once("exit", () => {
                        if (!stopping && result?.status === "success" && result.authFile) {
                            const tokens = files.readTokens(result.authFile);
                            finish({ok: true, accessToken: tokens?.accessToken || "", authFile: result.authFile});
                        } else {
                            finish({ok: false, reason: stopReason || result?.error || "浏览器登录失败"});
                        }
                    });
                    if (abortController.signal.aborted) stopWorker("已停止");
                });
            } catch (error) {
                temp?.cleanup();
                return {ok: false, reason: String(error?.message || error)};
            }
        }, {timeoutMs: 45_000, signal: abortController.signal})
            .catch((error) => ({ok: false, reason: abortController.signal.aborted ? "已停止" : String(error?.message || error)}))
            .finally(() => {
                if (currentAtAbort === abortController) currentAtAbort = null;
                currentAtStop = null;
            });
    }

    async function runRt(email, mailPassword, gptPassword, onProgress) {
        const abortController = new AbortController();
        currentRtAbort = abortController;
        return withProxy(`rt-sa:${email}`, async (exit, jump) => {
            let temp;
            let settled = false;
            let timedOut = false;
            let child = null;
            let idleTimer = null;
            let capTimer = null;
            let graceTimer = null;
            let hardTimer = null;
            let result = null;
            try {
                const mailbox = await store.getMailbox(email);
                const account = await store.getAccount(email);
                temp = createCredentialFile("codex-rt-sa-", email, {
                    password: mailPassword || mailbox?.password || "",
                    mailboxTotp: mailbox?.totp_secret || "",
                    recoveryEmail: mailbox?.recovery_email || "",
                    imapPassword: mailbox?.imap_password || "",
                });
                const mailProxy = await pickMailProxy();
                return await new Promise((resolve) => {
                    const finish = (value) => {
                        if (settled) return;
                        settled = true;
                        for (const timer of [idleTimer, capTimer, graceTimer, hardTimer]) {
                            if (timer) clearTimeout(timer);
                        }
                        if (currentRtChild === child) currentRtChild = null;
                        temp.cleanup();
                        resolve(value);
                    };
                    const takeResult = () => {
                        const tokens = result.rtFile ? files.readTokens(result.rtFile) : null;
                        finish({
                            ok: true,
                            rt: result.rt,
                            accessToken: tokens?.accessToken || "",
                            rtFile: result.rtFile || "",
                        });
                    };
                    const wrapUp = (reason) => {
                        if (settled || timedOut) return;
                        timedOut = true;
                        onProgress?.(`${reason}，SIGTERM 收尾，留 ${Math.round(graceMs / 1000)}s 让已拿到的 rt 上报…`);
                        try { child.kill("SIGTERM"); } catch { /* */ }
                        graceTimer = setTimeout(() => { try { child.kill("SIGKILL"); } catch { /* */ } }, graceMs);
                        hardTimer = setTimeout(() => {
                            if (result?.status === "success" && result.rt) return takeResult();
                            finish({ok: false, reason});
                        }, graceMs + 3_000);
                    };
                    const armIdle = () => {
                        if (idleTimer) clearTimeout(idleTimer);
                        if (!settled && !timedOut) {
                            idleTimer = setTimeout(() => wrapUp(`连续 ${Math.round(idleMs / 1000)}s 无新日志，判定 OAuth/取码卡住`), idleMs);
                        }
                    };
                    child = runtime.spawn(["scripts/worker-rt-nosms.ts"], runtime.cleanEnv({
                        REG_EMAIL: email,
                        MAIL_PROVIDER: mailbox?.provider || settings.providerOf(email),
                        MAILCOM_TOKENS_FILE: temp.file,
                        ICLOUD_TOKENS_FILE: temp.file,
                        MAILCOM_HEADLESS: "1",
                        PROXY_URL: exit || settings.rechargeProxy(),
                        MAIL_PROXY_JUMP: jump || "",
                        MAILCOM_PROXY: mailProxy,
                        GPT_PASSWORD: (gptPassword || account?.gpt_password || mailPassword || settings.defaultPassword()).trim(),
                        TOTP_SECRET: account?.totp_secret || "",
                        SMS_LINK_TEMPLATE: settings.smsLinkTemplate(),
                    }));
                    currentRtChild = child;
                    armIdle();
                    capTimer = setTimeout(() => wrapUp(`已跑满 ${Math.round(maxMs / 60_000)} 分钟上限`), maxMs);
                    child.once("error", (error) => finish({ok: false, reason: String(error?.message || error)}));
                    runtime.pipeOutput(child, {
                        onLine: (line) => {
                            armIdle();
                            onProgress?.(line);
                            effects.log("RT", email, line);
                        },
                        onEvent: (event) => {
                            armIdle();
                            if (event?.type === "result") result = event;
                            else if (event?.message) {
                                onProgress?.(event.message);
                                effects.log("RT", email, event.message);
                            }
                        },
                    });
                    child.once("exit", () => {
                        if (settled) return;
                        if (result?.status === "success" && result.rt) return takeResult();
                        finish({ok: false, reason: result?.error || (timedOut ? "OAuth/取码卡住，已收尾" : "OAuth 获取 rt 失败")});
                    });
                });
            } catch (error) {
                temp?.cleanup();
                if (currentRtChild === child) currentRtChild = null;
                return {ok: false, reason: `启动 rt worker 失败: ${String(error?.message || error).slice(0, 140)}`};
            }
        }, {timeoutMs: 45_000, log: (message) => onProgress?.(message), signal: abortController.signal})
            .catch((error) => ({ok: false, reason: abortController.signal.aborted ? "已停止" : String(error?.message || error)}))
            .finally(() => {
                if (currentRtAbort === abortController) currentRtAbort = null;
            });
    }

    function stopAt() {
        const active = !!(currentAtAbort || currentAtStop);
        currentAtAbort?.abort(new Error("已停止"));
        currentAtStop?.("已停止");
        return active;
    }

    function stopRt() {
        const child = currentRtChild;
        const active = !!(child || currentRtAbort);
        currentRtAbort?.abort(new Error("已停止"));
        try { child?.kill("SIGKILL"); } catch { /* */ }
        return active;
    }

    return {runAt, runRt, stopAt, stopRt};
}
