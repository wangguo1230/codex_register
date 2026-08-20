// @ts-nocheck
// 每日维护应用服务：协调 AT/RT 探测、失效 AT 重登、养号和存活状态更新。

export function createDailyMaintenanceService({scheduler, store, tokens, chat, runPool, effects, now = () => Date.now()} = {}) {
    const rootLog = (line) => effects.broadcast("log", {id: 0, line, ts: now()});

    async function maintainAccount(account, items, atFailedQueue) {
        let atOk = null;
        let rtOk = null;
        if (items.at) {
            try { atOk = (await tokens.testAt(account)).ok; } catch { atOk = false; }
            if (atOk === false) {
                try { atOk = (await tokens.testAt((await store.get(account.id)) || account)).ok; } catch { atOk = false; }
            }
            if (atOk === false && atFailedQueue) atFailedQueue.push(account);
        }
        if (items.rt) {
            try { rtOk = (await tokens.testRt(account, {updateRt: true, acquire: false})).ok; } catch { rtOk = false; }
        }
        if (items.at && items.rt) {
            await store.setDeadAt(account.id, atOk || rtOk ? 0 : (account.dead_at || now()));
            effects.broadcast("status", {id: account.id, ...await store.get(account.id)});
        }
    }

    async function withMaintenanceLock(owner, trigger, busyLabel, task) {
        if (!scheduler.acquireLock(owner)) {
            rootLog(`[定时·${trigger}] 跳过${busyLabel}(有其他浏览器任务在跑: ${scheduler.maintLock})`);
            return false;
        }
        try {
            await scheduler.waitRegistrationIdle();
            await task();
            return true;
        } finally {
            scheduler.releaseLock(owner);
            scheduler.tick();
        }
    }

    async function run(trigger = "cron") {
        if (scheduler.daily.running) return {ok: false, reason: "上次维护还在跑"};
        const items = scheduler.daily.items || {};
        const accounts = (await store.listSuccess()).filter((account) => !account.sold_at);
        scheduler.setDailyRunning(true);
        rootLog(`[定时·${trigger}] 开始维护 ${accounts.length} 个号 (养号:${!!items.chat} rt:${!!items.rt} at:${!!items.at})`);
        let chatN = 0;
        let rtN = 0;
        let atN = 0;
        let reloginN = 0;
        try {
            if (accounts.length) {
                const atFailedQueue = [];
                if (items.at || items.rt) {
                    await runPool(accounts, (account) => maintainAccount(account, items, items.at ? atFailedQueue : undefined), 6);
                    atN = items.at ? accounts.length : 0;
                    rtN = items.rt ? accounts.length : 0;
                }
                if (atFailedQueue.length) {
                    await withMaintenanceLock("daily-at-relogin", trigger, " at 重登", async () => {
                        rootLog(`[定时·${trigger}] ${atFailedQueue.length} 个号 at 失效,重登获取(并发${scheduler.concurrency})…`);
                        await runPool(atFailedQueue, async (account) => {
                            try {
                                const fresh = (await store.get(account.id)) || account;
                                const result = await tokens.testAt(fresh, {relogin: true});
                                if (result.ok) reloginN++;
                                if (result.ok && items.rt) {
                                    await store.setDeadAt(account.id, 0);
                                    effects.broadcast("status", {id: account.id, ...await store.get(account.id)});
                                }
                            } catch (error) {
                                effects.logAccount(account.id, `[定时·at重登] 异常: ${error?.message || error}`);
                            }
                        }, scheduler.concurrency);
                        rootLog(`[定时·${trigger}] at重登完成: ${reloginN}/${atFailedQueue.length} 成功`);
                    });
                }
                if (items.chat) {
                    const ran = await withMaintenanceLock("daily-chat", trigger, "养号", async () => {
                        await runPool(accounts, (account) => chat.run(account, ""), 2);
                    });
                    if (ran) chatN = accounts.length;
                }
            }
            scheduler.recordDailyRun({chatN, rtN, atN, accounts: accounts.length, trigger});
            rootLog(`[定时·${trigger}] 维护完成:${scheduler.daily.lastResult}${reloginN ? ` (at重登成功${reloginN}个)` : ""}`);
            return {ok: true, accounts: accounts.length, chatN, rtN, atN, reloginN};
        } catch (error) {
            rootLog(`[定时·${trigger}] 维护异常:${String(error?.message ?? error).slice(0, 120)}`);
            return {ok: false, reason: String(error?.message ?? error)};
        } finally {
            scheduler.setDailyRunning(false);
        }
    }

    function runIfDue(date = new Date()) {
        const daily = scheduler.daily;
        if (!daily.enabled || daily.running || date.getHours() !== daily.hour) return false;
        const last = daily.lastRunAt ? new Date(daily.lastRunAt) : null;
        if (last && last.toDateString() === date.toDateString()) return false;
        void run("cron");
        return true;
    }

    return {
        run,
        runIfDue,
        maintainAccount,
        configure: (config) => scheduler.configureDaily(config),
        isRunning: () => scheduler.daily.running,
        countSuccess: async () => (await store.listSuccess()).length,
    };
}
