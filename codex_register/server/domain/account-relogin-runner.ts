// @ts-nocheck
import {mkdtempSync, rmSync} from "node:fs";
import os from "node:os";
import path from "node:path";

export function isAccountDeadReason(reason) {
    return /account_deactivated|账户已被删除或停用|已被删除或停用|deleted or deactivated|account.{0,12}deactivated/i
        .test(String(reason || ""));
}

export function isAuthorizeRateLimited(reason) {
    return /429|rate_limit_exceeded|too many requests|请求过多|Retry-After|安全策略限制/i.test(String(reason || ""));
}

export function isReloginRetryable(reason) {
    const value = String(reason || "");
    if (isAccountDeadReason(value) || isAuthorizeRateLimited(value)) return false;
    return /403|409|invalid_state|no longer valid|authorize|chatgpt\.com|打开 OpenAI|Proxy connection|timed out|timeout|ECONN|ENOTFOUND|EPIPE|EHOST|network|socket|TLS|fetch failed|disconnected|secure TLS|超时|Cloudflare|Just a moment|身份验证错误|跳板池全忙|代理池全忙/i
        .test(value);
}

export function createAccountReloginRunner({runtime, store, files, settings, proxy, effects, timeouts = {}} = {}) {
    const idleFloorMs = timeouts.idleFloorMs === undefined
        ? 180_000
        : Math.max(1, Number(timeouts.idleFloorMs) || 1);
    const configuredMaxMs = timeouts.maxMs === undefined
        ? Math.max(300_000, Number(process.env.RELOGIN_WORKER_MAX_MS || 900_000))
        : Math.max(1, Number(timeouts.maxMs) || 1);
    const stopGraceMs = timeouts.graceMs === undefined
        ? 12_000
        : Math.max(1, Number(timeouts.graceMs) || 1);
    const noteFor = (account, onProgress, prefix = "relogin-at") => (message) => {
        effects.logAccount(account.id, `[${prefix}] ${message}`);
        try { onProgress?.(message); } catch { /* */ }
    };

    async function spawnOne(account, {
        proxy: explicitProxy,
        jump,
        script = "src/worker-login-http.ts",
        timeoutMs = 0,
        skipMfa = false,
        onProgress,
        gptPassword,
        onChild,
    } = {}) {
        const note = noteFor(account, onProgress);
        let exitProxy = settings.resolveExitProxy(explicitProxy);
        if (!exitProxy) {
            return {
                ok: false,
                reason: "无可用代理(rtProxy/10808 与传入出口皆空)，禁止直连 chatgpt.com（会 Connect Timeout）",
            };
        }
        const jumpUrl = jump === undefined
            ? String(settings.defaultJump() || "").trim()
            : String(jump || "").trim();
        const exitHostLocal = (() => {
            try {
                const url = new URL(exitProxy.includes("://") ? exitProxy.split("#")[0] : `socks5://${exitProxy}`);
                return url.hostname === "127.0.0.1" || url.hostname === "localhost";
            } catch { return false; }
        })();
        const browserWorker = /worker-register-browser|register-browser|worker-register-claude/i.test(String(script || ""));
        let mailProxy;
        try {
            if (browserWorker) {
                const xray = await proxy.pickXray(settings.rechargeProxy(), settings.rtProxy(), settings.regProxy());
                if (!xray) return {ok: false, reason: "浏览器必须走 xray，本机没有可用的 xray socks（10811/10808）"};
                if (exitProxy !== xray) note(`浏览器改走 xray ${proxy.mask(xray)}（不用 JS 转发 kookeey）`);
                exitProxy = xray;
            } else if (jumpUrl && !exitHostLocal) {
                note(`出口 ${proxy.mask(exitProxy)} + 跳板 ${proxy.mask(jumpUrl)}（协议转发在子进程）`);
            } else if (!jumpUrl && !exitHostLocal) {
                note(`无跳板，经出口 ${proxy.mask(exitProxy)}（国内访问 kookeey 常需跳板）`);
            } else if (exitHostLocal) {
                note(`本地出口 ${proxy.mask(exitProxy)}（不套跳板）`);
            }
            const configured = settings.mailProxyEnabled() ? settings.mailProxy() : "";
            mailProxy = await proxy.pickXray(configured, settings.rechargeProxy())
                || proxy.pickMailBrowser(configured, settings.rechargeProxy());
        } catch (error) {
            return {ok: false, reason: `选择重登代理失败: ${String(error?.message || error).slice(0, 140)}`};
        }

        const headless = process.env.MAILCOM_HEADED === "1" ? "0" : "1";
        const viaJump = !browserWorker && !!(jumpUrl && !exitHostLocal);
        const gptPw = String(gptPassword || account.gpt_password || settings.defaultPassword() || "").trim();
        note(
            `邮箱密码 ${String(account.password || "").slice(0, 4)}…(${String(account.password || "").length}位)`
            + ` · GPT密码 ${gptPw.slice(0, 4)}…(${gptPw.length}位)`
            + `${headless === "0" ? "；mail.com 有头" : "；mail.com 无头收码"}`
            + ` · GPT代理=${proxy.mask(exitProxy)}${viaJump ? "（经跳板）" : ""}`
            + ` · 收码代理=${mailProxy ? proxy.mask(mailProxy) : "直连"}`
            + (browserWorker ? " · 引擎=浏览器" : " · 引擎=协议")
            + (proxy.hasSocksAuth(exitProxy) && !mailProxy ? "（警告：无可用无账密收码代理）" : ""),
        );

        let tempDir;
        let child;
        try {
            tempDir = mkdtempSync(path.join(os.tmpdir(), "codex-relogin-"));
            const credentialFile = path.join(tempDir, `mc-${account.id}.txt`);
            files.writeCredential(credentialFile, {
                email: account.email,
                password: account.password,
                mailboxTotp: account.mailbox_totp || "",
                recoveryEmail: account.recovery_email || "",
                imapPassword: account.mailbox_imap || "",
            });
            child = runtime.spawn([script], runtime.cleanEnv({
                REG_EMAIL: account.email,
                MAIL_PROVIDER: account.provider || "mailcom",
                MAILCOM_TOKENS_FILE: credentialFile,
                ICLOUD_TOKENS_FILE: credentialFile,
                MAILCOM_HEADLESS: headless,
                PROXY_URL: exitProxy,
                MAIL_PROXY_JUMP: browserWorker ? "" : jumpUrl,
                MAILCOM_PROXY: mailProxy,
                REG_SIMULATE_CHAT: "",
                REG_TRY_RT: "0",
                GPT_PASSWORD: gptPw,
                TOTP_SECRET: account.totp_secret || "",
                REG_TRY_MFA: skipMfa ? "0" : (account.totp_secret ? "0" : "1"),
                OPENAI_FETCH_RETRY: process.env.OPENAI_FETCH_RETRY || "2",
                OPENAI_FETCH_RETRY_DELAY_MS: process.env.OPENAI_FETCH_RETRY_DELAY_MS || "800",
            }));
        } catch (error) {
            try { if (tempDir) rmSync(tempDir, {recursive: true, force: true}); } catch { /* */ }
            return {ok: false, reason: `启动 worker 失败: ${String(error?.message || error)}`};
        }
        try { onChild?.(child); } catch { /* 子进程跟踪失败不改变登录结果 */ }

        return new Promise((resolve) => {
            let settled = false;
            let result = null;
            let idleTimer = null;
            let capTimer = null;
            let killTimer = null;
            let beatTimer = null;
            let stopping = false;
            let terminalStop = false;
            const startedAt = Date.now();
            let lastChildAt = startedAt;
            const cleanup = () => {
                for (const timer of [idleTimer, capTimer, killTimer]) if (timer) clearTimeout(timer);
                if (beatTimer) clearInterval(beatTimer);
                try { rmSync(tempDir, {recursive: true, force: true}); } catch { /* */ }
            };
            const finish = (value) => {
                if (settled) return;
                settled = true;
                cleanup();
                resolve(value);
            };
            const persistRelogin = async (late = false) => {
                if (result?.status !== "success" || !result.authFile) return null;
                try {
                    const authData = files.readJson(result.authFile);
                    const updates = {auth_file: result.authFile, auth_data: authData};
                    if (result.totpSecret) {
                        updates.totp_secret = result.totpSecret;
                        updates.mfa_status = result.mfaStatus || "✅已绑";
                    } else if (result.mfaStatus) {
                        updates.mfa_status = result.mfaStatus;
                    }
                    await store.updateAccount(account.id, updates);
                    const queueUpdates = await store.updateQueueAuth(account.id, updates.auth_file, updates.auth_data);
                    if (queueUpdates) await effects.syncQueue();
                    await effects.snapshot();
                    note(late
                        ? (queueUpdates ? "停掉后仍登成功，已补写 session（GPT + 充值队列）" : "停掉后仍登成功，已补写 session（GPT）")
                        : (queueUpdates ? "已写回最新 session（GPT + 充值队列）" : "已写回最新 session（GPT）"));
                    return {ok: true, authFile: result.authFile, authData};
                } catch (error) {
                    const reason = `登录成功但 session 写回失败: ${String(error?.message || error).slice(0, 140)}`;
                    note(reason);
                    return {ok: false, reason};
                }
            };
            const effectiveIdle = Math.max(timeoutMs > 0 ? timeoutMs : 90_000, idleFloorMs);
            const effectiveMax = Math.max(effectiveIdle * 2, configuredMaxMs);
            const stopWorker = (reason, terminal = false) => {
                if (settled || (stopping && terminalStop)) return;
                stopping = true;
                terminalStop = terminalStop || terminal;
                note(`${reason}，先停 worker`);
                try { child.kill("SIGTERM"); } catch { /* */ }
                if (killTimer) clearTimeout(killTimer);
                killTimer = setTimeout(() => {
                    try { child.kill("SIGKILL"); } catch { /* */ }
                    note("无响应，已杀 worker");
                    finish({ok: false, reason});
                }, stopGraceMs);
            };
            const armIdle = () => {
                if (idleTimer) clearTimeout(idleTimer);
                idleTimer = setTimeout(() => {
                    if (settled) return;
                    stopWorker(`重登无响应(${Math.round(effectiveIdle / 1000)}s 无日志)`);
                }, effectiveIdle);
            };
            const touch = () => {
                if (settled) return;
                lastChildAt = Date.now();
                if (terminalStop) return;
                if (stopping) {
                    if (killTimer) clearTimeout(killTimer);
                    killTimer = null;
                    stopping = false;
                    note("仍有进度，取消停止");
                }
                armIdle();
            };

            armIdle();
            capTimer = setTimeout(() => stopWorker(`重登超过绝对上限 ${Math.round(effectiveMax / 1000)}s`, true), effectiveMax);
            beatTimer = setInterval(() => {
                if (settled) return;
                const elapsed = Math.round((Date.now() - startedAt) / 1000);
                const silent = Math.round((Date.now() - lastChildAt) / 1000);
                if (silent >= 8) note(`仍在跑，已 ${elapsed}s（子进程 ${silent}s 无新步骤）`);
            }, 15_000);
            runtime.pipeOutput(child, {
                onLine: (line) => { touch(); note(line); },
                onEvent: (event) => {
                    touch();
                    if (event?.type === "progress") note(event.message);
                    else if (event?.type === "result") result = event;
                },
            });
            child.once("error", (error) => {
                note(`worker 启动失败: ${error?.message || error}`);
                finish({ok: false, reason: String(error?.message || error)});
            });
            child.once("close", async () => {
                cleanup();
                const saved = await persistRelogin(settled);
                if (saved) {
                    if (!settled) finish(saved);
                    return;
                }
                if (settled) return;
                const reason = result?.error || "登录获取 at 失败";
                if (isAccountDeadReason(reason)) {
                    await store.updateAccount(account.id, {error: reason});
                    await effects.snapshot();
                }
                finish({ok: false, reason});
            });
        });
    }

    async function runDirect(account, {
        proxy: proxyUrl,
        jump = "",
        timeoutMs = 0,
        allowBrowser = true,
        skipMfa = false,
        onProgress,
        gptPassword,
        onChild,
    } = {}) {
        const note = noteFor(account, onProgress, "at");
        note("走协议登录重新获取 at(密码/邮箱码/TOTP)…");
        const protocol = await spawnOne(account, {
            proxy: proxyUrl,
            jump,
            script: "src/worker-login-http.ts",
            timeoutMs,
            skipMfa,
            onProgress,
            gptPassword,
            onChild,
        });
        if (protocol.ok || isAccountDeadReason(protocol.reason) || !allowBrowser) return protocol;
        note(`协议登录失败(${String(protocol.reason || "").slice(0, 80)}),回退浏览器…`);
        const browserProxy = await proxy.pickXray(settings.rechargeProxy(), settings.rtProxy(), settings.regProxy()) || "";
        if (!browserProxy) {
            note("浏览器必须走 xray，本机没有 10811/10808，浏览器回退跳过");
            return {...protocol, reason: `${protocol.reason || "协议失败"}；浏览器回退无可用 xray`};
        }
        note(`浏览器回退走 xray ${proxy.mask(browserProxy)}`);
        return spawnOne(account, {
            proxy: browserProxy,
            jump: "",
            script: "src/worker-register-browser.ts",
            timeoutMs,
            skipMfa,
            onProgress,
            gptPassword,
            onChild,
        });
    }

    async function runPooled(account, {
        proxy: explicitProxy,
        jump,
        timeoutMs = 0,
        allowBrowser = true,
        skipMfa = false,
        onProgress,
        usePool = true,
        gptPassword,
        onChild,
    } = {}) {
        const note = (message) => {
            try {
                if (onProgress) onProgress(message);
                else effects.logAccount(account.id, `[at] ${message}`);
            } catch { /* */ }
        };
        const defaultJump = jump || settings.defaultJump();
        const forced = explicitProxy !== undefined && explicitProxy !== null && String(explicitProxy).trim() !== "";
        if (!usePool || forced) {
            const proxyUrl = forced ? String(explicitProxy).trim() : settings.resolveExitProxy();
            if (!proxyUrl) return {ok: false, reason: "无可用代理(未配 rtProxy/10808，且未传出口)，禁止直连"};
            note(`重登代理 ${proxy.mask(proxyUrl)}${forced ? "（指定）" : "（充值/注册）"}${defaultJump && forced ? " +跳板" : ""}`);
            return runDirect(account, {
                proxy: proxyUrl,
                jump: forced ? defaultJump : "",
                timeoutMs,
                allowBrowser,
                skipMfa,
                onProgress,
                gptPassword,
                onChild,
            });
        }

        let last = {ok: false, reason: "未尝试"};
        const poolSize = Math.max(0, Number(settings.poolSize() || 0));
        const maxPoolTries = Math.min(3, Math.max(1, poolSize || 1));
        if (poolSize) {
            for (let index = 0; index < maxPoolTries; index++) {
                note(`① 协议重登链式 GPT 池（${index + 1}/${maxPoolTries}）`);
                try {
                    last = await proxy.withLease(account.email, async (proxyUrl, jumpUrl) => {
                        const selected = String(proxyUrl || "").trim();
                        if (!selected) throw new Error("池租约为空");
                        note(`   出口 ${proxy.mask(selected)}${jumpUrl ? " ←跳板 " + proxy.mask(jumpUrl) : ""}`);
                        return runDirect(account, {
                            proxy: selected,
                            jump: jumpUrl || "",
                            timeoutMs,
                            allowBrowser: false,
                            skipMfa,
                            onProgress,
                            gptPassword,
                            onChild,
                        });
                    }, {log: note, timeoutMs: 45_000, noEmptyFallback: true});
                } catch (error) {
                    last = {ok: false, reason: String(error?.message || error).slice(0, 160)};
                    note(`   链式失败: ${last.reason}`);
                }
                if (last?.ok || isAccountDeadReason(last?.reason)) return last;
                if (isAuthorizeRateLimited(last?.reason)) {
                    note("官方限流 429，停止换出口（再打会更限）");
                    return last;
                }
                if (index + 1 < maxPoolTries && isReloginRetryable(last?.reason)) {
                    note(`本条链不通，换出口再试: ${String(last?.reason || "").slice(0, 80)}`);
                    await new Promise((resolve) => setTimeout(resolve, 800));
                    continue;
                }
                break;
            }
        }

        if (allowBrowser && !last.ok && !isAuthorizeRateLimited(last.reason)) {
            const browserProxy = await proxy.pickXray(settings.rechargeProxy(), settings.rtProxy(), settings.regProxy()) || "";
            if (browserProxy) {
                note(`③ 浏览器回退 xray ${proxy.mask(browserProxy)}`);
                last = await runDirect(account, {
                    proxy: browserProxy,
                    jump: "",
                    timeoutMs,
                    allowBrowser: true,
                    skipMfa,
                    onProgress,
                    gptPassword,
                    onChild,
                });
            } else {
                note("③ 本机没有可用 xray，跳过浏览器回退");
            }
        }
        return last;
    }

    return {spawnOne, runDirect, runPooled};
}
