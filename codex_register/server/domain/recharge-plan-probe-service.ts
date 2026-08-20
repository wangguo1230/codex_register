// @ts-nocheck
// 套餐探测应用服务：加载队列账号、并发查询套餐并收敛 plan_type。
import {runBoundedPool} from "./async-pool.js";
import {normalizeConcurrency} from "./concurrency.js";

export function createRechargePlanProbeService({store, credentials, plans, config, effects} = {}) {
    let running = false;

    const safeLog = (line) => {
        try { effects.log(line); } catch { /* 日志不影响任务收尾 */ }
    };

    async function loadTargets(ids, batch) {
        if (ids.length) {
            return store.getQueues
                ? store.getQueues(ids)
                : (await Promise.all(ids.map((id) => store.getQueue(id)))).filter(Boolean);
        }
        let targets = (await store.listQueue("all")).list || [];
        if (batch) targets = targets.filter((item) => item.batch === batch);
        return targets;
    }

    async function run(targets) {
        effects.log(`查询套餐: ${targets.length} 个账号`);
        let ok = 0;
        let fail = 0;
        const dispatcher = plans.buildDispatcher(config.regProxy());
        let started = 0;
        const concurrency = normalizeConcurrency(config.rtConcurrency(), 4);
        let accountsById = null;
        if (store.getAccounts && targets.length <= 100) {
            try {
                const accounts = await store.getAccounts(targets.map((item) => item.account_id));
                accountsById = new Map(accounts.map((account) => [Number(account.id), account]));
            } catch (error) {
                safeLog(`套餐查询批量读取账号失败，回退逐条读取: ${String(error?.message || error).slice(0, 120)}`);
            }
        }
        await runBoundedPool(targets, async (item) => {
            const index = ++started;
            try {
                const account = accountsById?.get(Number(item.account_id)) || await store.getAccount(item.account_id);
                const tokens = credentials.extractTokens(credentials.readAuth(account) || item.auth_data || credentials.readJson(item.auth_file));
                if (!tokens?.accessToken) {
                    fail++;
                    effects.log(`[${index}/${targets.length}] ✗ ${item.email} 无 AT`);
                    return;
                }
                const rtTokens = credentials.extractTokens(credentials.readRt(account) || credentials.readAuth(account) || item.auth_data || credentials.readJson(item.auth_file));
                const result = await plans.probe(tokens.accessToken, tokens.accountId, dispatcher, 12_000, rtTokens?.refreshToken);
                if (index === 1 && result._debug) effects.log(`[调试] endpoint=${result._debug.endpoint}, raw="${result._debug.raw}"`);
                if (result.ok) {
                    await store.updateQueue(item.id, {plan_type: result.plan_type});
                    ok++;
                    effects.log(`[${index}/${targets.length}] ${item.email} → ${result.plan_type}${result.has_active_subscription ? "(订阅中)" : ""}`);
                } else {
                    fail++;
                    effects.log(`[${index}/${targets.length}] ✗ ${item.email} ${result.error}`);
                }
            } catch (error) {
                fail++;
                effects.log(`[${index}/${targets.length}] ✗ ${item.email} ${String(error?.message || error).slice(0, 120)}`);
            }
        }, concurrency);
        await effects.syncQueue().catch((error) => {
            safeLog(`套餐查询刷新队列失败: ${String(error?.message || error).slice(0, 120)}`);
        });
        effects.log(`套餐查询完成: 成功 ${ok} / 失败 ${fail}`);
    }

    async function start(ids, batch = "") {
        if (running) return {error: "套餐查询正在进行中", status: 409};
        running = true;
        let targets;
        try {
            targets = await loadTargets(ids, batch);
        } catch (error) {
            running = false;
            throw error;
        }
        if (!targets.length) {
            running = false;
            return {ok: true, updated: 0};
        }
        void run(targets)
            .catch((error) => safeLog(`套餐查询后台任务异常: ${String(error?.message || error).slice(0, 160)}`))
            .finally(() => { running = false; });
        return {ok: true, count: targets.length};
    }

    return {start, isRunning: () => running};
}
