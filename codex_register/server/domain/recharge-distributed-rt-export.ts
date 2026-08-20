// @ts-nocheck
// 充值导出的分布式 RT 等待器：只负责入队、观察终态和读取最新队列快照。
export function createRechargeDistributedRtExport({store, distributedRt, hasRt, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), maxWaitMs = 30 * 60_000, log = () => {}} = {}) {
    async function run({rows, work, ids, batch, isStopped = () => false}) {
        const accountIds = [...new Set(work.map((row) => Number(row.account_id)).filter(Number.isInteger))];
        const emailByAccountId = new Map(work.map((row) => [Number(row.account_id), String(row.email || row.account_id)]));
        const configuredWait = Number(maxWaitMs);
        const deadline = Date.now() + Math.max(60_000, Number.isFinite(configuredWait) ? configuredWait : 30 * 60_000);
        let needsEnqueue = true;
        let retryTerminalTasks = true;
        let fresh = rows;
        const reported = new Map();

        const reportStates = (states) => {
            for (const task of states || []) {
                const accountId = Number(task.entity_id);
                const status = String(task.status || "unknown");
                const worker = String(task.lease_owner || task.result?.worker_instance || "未认领");
                const attempts = Number(task.attempts || 0);
                const signature = `${status}:${worker}:${attempts}`;
                if (reported.get(accountId) === signature) continue;
                reported.set(accountId, signature);
                log(`RT任务 ${emailByAccountId.get(accountId) || accountId} → ${status} · 执行实例 ${worker} · 第 ${attempts} 次`);
            }
        };

        while (!isStopped() && Date.now() < deadline) {
            if (needsEnqueue) {
                const tasks = await distributedRt.enqueue(accountIds, {updateRt: true, acquire: true});
                needsEnqueue = false;
                distributedRt.wake?.();
                log("导出 RT 已进入分布式队列: " + (tasks?.length || 0) + "/" + accountIds.length + " 个新任务，其余由其他实例处理或已在队列中");
            }
            const states = await distributedRt.list(accountIds);
            reportStates(states);
            const terminal = states.length >= accountIds.length
                && states.every((task) => ["success", "failed", "canceled"].includes(String(task.status || "")));
            if (terminal) {
                fresh = await store.listFull(ids.length ? ids : undefined, batch || undefined);
                const missing = fresh.filter((row) => !hasRt(row));
                if (missing.length && retryTerminalTasks) {
                    retryTerminalTasks = false;
                    needsEnqueue = true;
                    log("分布式 RT 任务已结束但仍有 " + missing.length + " 个缺失，重新排队一次");
                    continue;
                }
                return {fresh, timedOut: false};
            }
            await sleep(Math.min(2_000, Math.max(250, deadline - Date.now())));
        }
        fresh = await store.listFull(ids.length ? ids : undefined, batch || undefined);
        return {fresh, timedOut: !isStopped()};
    }

    return {run};
}
