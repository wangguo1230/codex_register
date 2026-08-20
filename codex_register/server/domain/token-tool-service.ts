// @ts-nocheck
// Token 工具应用服务：批量 AT/RT 获取、停止状态和纯 HTTP RT 刷新。
import {normalizeConcurrency} from "./concurrency.js";

export function parseEmailPasswordLines(text) {
    const rows = [];
    const seen = new Set();
    for (const raw of String(text || "").split(/\r?\n/)) {
        const parts = raw.split(/----|\t|,/).map((part) => part.trim());
        const email = String(parts[0] || "").toLowerCase();
        if (!email || !email.includes("@") || seen.has(email)) continue;
        seen.add(email);
        rows.push({email, password: parts[1] || ""});
    }
    return rows;
}

export function createTokenToolService({store, workers, tokens, runPool, effects, config} = {}) {
    const atState = {running: false, stopped: false, generation: 0};
    const rtState = {running: false, stopped: false, generation: 0};
    const publicAtResults = (results) => results.map(({accId, ...result}) => result);

    function normalizeItems(input = {}) {
        if (Array.isArray(input.items)) {
            return input.items
                .map((item) => ({email: String(item?.email || "").trim().toLowerCase(), password: String(item?.password || "")}))
                .filter((item) => item.email);
        }
        return parseEmailPasswordLines(input.lines);
    }

    async function startAt(input) {
        const items = normalizeItems(input);
        if (!items.length) return {error: "未提供邮箱列表", status: 400};
        if (atState.running) return {error: "已有批量 AT 获取任务在运行", status: 409};
        const generation = ++atState.generation;
        atState.running = true;
        atState.stopped = false;
        let accounts;
        try {
            accounts = await store.listSuccess();
        } catch (error) {
            if (generation === atState.generation) atState.running = false;
            return {error: String(error?.message || error), status: 500};
        }
        const byEmail = new Map(accounts.map((account) => [account.email.toLowerCase(), account]));
        const results = items.map((item) => {
            const account = byEmail.get(item.email);
            return {
                email: item.email,
                password: account?.password || item.password,
                ok: false,
                reason: "",
                status: "pending",
                accId: account?.id || null,
            };
        });
        void (async () => {
            try {
                for (const result of results) {
                    if (atState.stopped || generation !== atState.generation) {
                        result.reason = "已停止";
                        result.status = "done";
                        continue;
                    }
                    if (!result.password) {
                        result.reason = "无密码";
                        result.status = "done";
                        effects.broadcast("refreshAt", {results: publicAtResults(results)});
                        continue;
                    }
                    try {
                        if (result.accId) {
                            const account = await store.getAccount(result.accId);
                            if (!account) {
                                result.reason = "账号不存在";
                            } else {
                                const tested = await tokens.testAt(account, {relogin: true});
                                if (tested.ok) {
                                    const fresh = await store.getAccount(result.accId);
                                    const auth = store.readAuth(fresh);
                                    result.accessToken = tokens.extract(auth)?.accessToken || "";
                                    result.sessionJson = tokens.extractSession(auth);
                                    result.ok = true;
                                    result.reason = "获取成功";
                                } else {
                                    result.reason = tested.reason || "获取失败";
                                }
                            }
                        } else {
                            const mailbox = await store.getMailbox(result.email);
                            const acquired = await workers.runAt(result.email, mailbox?.password || result.password);
                            if (acquired.ok && acquired.accessToken) {
                                result.accessToken = acquired.accessToken;
                                result.sessionJson = acquired.authFile ? store.readSessionFile(acquired.authFile) : null;
                                result.ok = true;
                                result.reason = "获取成功(独立登录)";
                            } else {
                                result.reason = acquired.reason || "登录失败";
                            }
                        }
                    } catch (error) {
                        result.reason = String(error?.message || error).slice(0, 80);
                    }
                    result.status = "done";
                    effects.broadcast("refreshAt", {results: publicAtResults(results)});
                }
            } catch (error) {
                effects.warn("[批量AT工具] 异常:", error?.message || error);
            } finally {
                if (generation === atState.generation) {
                    atState.running = false;
                    atState.stopped = false;
                    effects.broadcast("refreshAt", {results: publicAtResults(results), done: true});
                }
            }
        })();
        return {ok: true, count: results.length};
    }

    function stopAt() {
        atState.stopped = true;
        workers.stopAt?.();
        return {ok: true};
    }

    async function refreshTokens(items) {
        if (!Array.isArray(items) || !items.length) return {error: "items 为空", status: 400};
        const dispatcher = tokens.buildDispatcher(config.rtProxy() || config.regProxy());
        const results = new Array(items.length);
        const concurrency = normalizeConcurrency(config.rtConcurrency(), 4);
        await runPool(items.map((item, index) => ({item, index})), async ({item, index}) => {
            if (!item.rt) {
                results[index] = {email: item.email, ok: false, reason: "无rt"};
                return;
            }
            const refreshed = await tokens.refreshRt(item.rt, dispatcher);
            results[index] = refreshed.ok && refreshed.tokens
                ? {email: item.email, password: item.password, ok: true, tokens: refreshed.tokens}
                : {email: item.email, ok: false, reason: refreshed.reason || "刷新失败"};
        }, concurrency);
        return {results};
    }

    async function startRt(lines) {
        const items = parseEmailPasswordLines(lines);
        if (!items.length) return {error: "未提供邮箱列表", status: 400};
        if (rtState.running) return {error: "已有批量 RT 获取任务在运行", status: 409};
        const results = items.map((item) => ({...item, ok: false, reason: "", status: "pending"}));
        const generation = ++rtState.generation;
        rtState.running = true;
        rtState.stopped = false;
        void (async () => {
            try {
                for (const result of results) {
                    if (rtState.stopped || generation !== rtState.generation) {
                        result.reason = "已停止";
                        result.status = "done";
                        continue;
                    }
                    const mailbox = await store.getMailbox(result.email);
                    const account = await store.getAccountByEmail(result.email);
                    const mailPassword = mailbox?.password || result.password;
                    const gptPassword = (account?.gpt_password || result.password || config.defaultPassword()).trim();
                    if (!gptPassword && !mailPassword) {
                        result.reason = "无密码";
                        result.status = "done";
                        effects.broadcast("batchRtAcquire", {results, done: false});
                        continue;
                    }
                    result.status = "running";
                    result.reason = "OAuth 登录中…";
                    effects.broadcast("batchRtAcquire", {results, done: false});
                    try {
                        effects.log("RT", result.email, "走 OAuth 获取 rt…");
                        const acquired = await workers.runRt(result.email, mailPassword, gptPassword, (message) => {
                            result.reason = String(message || "").slice(0, 80);
                            result.status = "running";
                            effects.broadcast("batchRtAcquire", {results, done: false});
                        });
                        if (acquired.ok) {
                            Object.assign(result, {rt: acquired.rt, accessToken: acquired.accessToken, ok: true, reason: "获取成功"});
                            if (acquired.rtFile) {
                                const freshAccount = await store.getAccountByEmail(result.email);
                                if (freshAccount) {
                                    const rtData = store.readJson(acquired.rtFile);
                                    await store.setRtFile(freshAccount.id, acquired.rtFile, rtData);
                                    effects.log("RT", result.email, "rt 已同步到 GPT 账号");
                                    const extracted = tokens.extract(rtData);
                                    const plan = await tokens.syncPlan(freshAccount, acquired.accessToken || extracted?.accessToken, extracted?.accountId);
                                    if (plan) {
                                        result.plan = plan;
                                        effects.log("RT", result.email, `套餐 → ${plan}`);
                                    }
                                }
                            }
                        } else {
                            result.reason = acquired.reason || "获取失败";
                        }
                    } catch (error) {
                        result.reason = String(error?.message || error).slice(0, 80);
                    }
                    result.status = "done";
                    effects.broadcast("batchRtAcquire", {results, done: false});
                }
            } catch (error) {
                effects.warn("[批量RT工具] 异常:", error?.message || error);
            } finally {
                if (generation === rtState.generation) {
                    rtState.running = false;
                    rtState.stopped = false;
                    effects.broadcast("batchRtAcquire", {results, done: true});
                    effects.rootLog(`[批量RT] 完成: ${results.filter((result) => result.ok).length}/${results.length} 成功`);
                }
            }
        })();
        return {ok: true, count: results.length};
    }

    function stopRt() {
        rtState.stopped = true;
        workers.stopRt();
        return {ok: true};
    }

    return {startAt, stopAt, refreshTokens, startRt, stopRt};
}
