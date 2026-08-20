// @ts-nocheck

export function createAccountTokenService({store, credentials, http, settings, files, relogin, rtWorker, effects, delay = setTimeout, now = () => new Date()} = {}) {
    async function setStatus(id, kind, status) {
        await store.setTestStatus(id, kind, status);
        await effects.status(id, await store.getAccount(id));
    }

    async function reviveIfAlive(id) {
        const account = await store.getAccount(id);
        if (!account?.dead_at) return;
        await store.setDeadAt(id, 0);
        await effects.status(id, await store.getAccount(id));
    }

    function dispatcher(log, tag = "AT/RT") {
        const raw = String(settings.tokenProxy() || "").trim();
        const url = (!raw || /:\/\/127\.0\.0\.1:10808\b/.test(raw) || /:\/\/localhost:10808\b/.test(raw))
            ? "http://127.0.0.1:10808"
            : raw;
        try { log?.(`${tag} 走 ${settings.maskProxy(url)}（主进程不起转发）`); } catch { /* */ }
        return http.buildDispatcher(url);
    }

    const probeAtViaPool = (_account, accessToken, accountId, log) => http.probeAt(accessToken, accountId, dispatcher(log, "AT"));
    const refreshRtViaPool = (_account, refreshToken, log) => http.refreshRt(refreshToken, dispatcher(log, "RT"));

    async function testAt(account, {relogin: shouldRelogin = false, onChild} = {}) {
        await setStatus(account.id, "at", "测试中…");
        const note = (message) => effects.logAccount(account.id, `[at] ${message}`);
        const tokens = credentials.extract(credentials.readAuth(account));
        if (tokens?.accessToken) {
            const result = await probeAtViaPool(account, tokens.accessToken, tokens.accountId, note);
            if (result.ok) {
                await setStatus(account.id, "at", "✅有效");
                await reviveIfAlive(account.id);
                return result;
            }
            if (!shouldRelogin) {
                await setStatus(account.id, "at", "❌" + result.reason);
                return result;
            }
        } else if (!shouldRelogin) {
            await setStatus(account.id, "at", "无at");
            return {ok: false, reason: "无at"};
        }

        await setStatus(account.id, "at", "at失效,协议重登获取…");
        const login = await relogin.run(account, {
            allowBrowser: true,
            onChild,
            onProgress: (message) => effects.logAccount(account.id, `[at] ${message}`),
        });
        if (!login.ok) {
            await setStatus(account.id, "at", "❌登录获取失败:" + String(login.reason || "").slice(0, 40));
            return {ok: false, reason: login.reason};
        }
        const fresh = login.authFile
            ? credentials.readFile(login.authFile)
            : credentials.extract(credentials.readAuth(await store.getAccount(account.id)));
        const result = fresh?.accessToken
            ? await probeAtViaPool(account, fresh.accessToken, fresh.accountId, note)
            : {ok: false, reason: "新 auth 无 at"};
        await setStatus(account.id, "at", result.ok ? "✅有效(已重登)" : "❌" + result.reason);
        if (result.ok) await reviveIfAlive(account.id);
        return result;
    }

    async function syncPlan(account, accessToken, accountId = "") {
        if (!account?.id || !accessToken) return "";
        try {
            const result = await http.probePlan(accessToken, accountId, http.buildDispatcher(settings.rechargeProxy()));
            if (!result.ok || !result.plan_type) return "";
            const plan = result.plan_type;
            if (plan !== account.plan) await store.updateAccount(account.id, {plan});
            const updated = await store.updateQueuePlan(account.id, plan);
            if (updated) await effects.syncQueue();
            return plan;
        } catch {
            return "";
        }
    }

    async function testRt(account, {updateRt = true, acquire = false, onProgress, onChild} = {}) {
        await setStatus(account.id, "rt", "测试中…");
        const rtData = credentials.readRt(account);
        const tokens = credentials.extract(rtData || credentials.readAuth(account));
        const note = (message) => {
            effects.logAccount(account.id, `[rt] ${message}`);
            try { onProgress?.(message); } catch { /* */ }
        };
        if (tokens?.refreshToken) {
            let result = await refreshRtViaPool(account, tokens.refreshToken, note);
            if (!result.ok) {
                await setStatus(account.id, "rt", "失败,重试中…");
                await new Promise((resolve) => delay(resolve, 2_500));
                result = await refreshRtViaPool(account, tokens.refreshToken, note);
            }
            if (result.ok) {
                if (updateRt && result.tokens && tokens.raw && rtData) {
                    try {
                        const record = {...tokens.raw};
                        if (result.tokens.access_token) record.access_token = result.tokens.access_token;
                        if (result.tokens.refresh_token) record.refresh_token = result.tokens.refresh_token;
                        if (result.tokens.id_token) record.id_token = result.tokens.id_token;
                        record.last_refresh = now().toISOString();
                        await store.updateRtData(account.id, record);
                        if (account.rt_file) files.writeRt(account.rt_file, record);
                    } catch { /* 写回失败不影响测试结论 */ }
                }
                await setStatus(account.id, "rt", updateRt ? "✅有效(已续期)" : "✅有效");
                const plan = await syncPlan(account, result.tokens?.access_token, result.tokens?.account_id);
                if (plan) {
                    effects.logAccount(account.id, `[rt] 套餐 → ${plan}`);
                    return {...result, plan_type: plan};
                }
                return result;
            }
            if (!acquire) {
                await setStatus(account.id, "rt", "❌" + result.reason);
                return result;
            }
            await setStatus(account.id, "rt", "过期,重新获取中…");
            return rtWorker.run(account, account.phone || "", {onProgress, onChild});
        }
        if (!acquire) {
            await setStatus(account.id, "rt", "无rt");
            return {ok: false, reason: "无rt"};
        }
        await setStatus(account.id, "rt", "无rt,获取中…");
        return rtWorker.run(account, account.phone || "", {onProgress, onChild});
    }

    return {setStatus, testAt, testRt, syncPlan, probeAtViaPool, refreshRtViaPool};
}
