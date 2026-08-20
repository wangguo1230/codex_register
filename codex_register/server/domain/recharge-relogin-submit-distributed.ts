// @ts-nocheck
// 重登提交分布式适配器：批量入口只入队，单项执行交给持久化 worker。
export function createRechargeReloginSubmitDistribution({
    instanceId,
    store,
    executor,
    effects,
    isSubmitRunning = () => false,
    isExportRunning = () => false,
    isRecoveryRunning = () => false,
    isReloginRunning = () => false,
    isConfigured = () => true,
} = {}) {
    let worker = null;

    const notify = () => {
        try { effects.jobsChanged?.(); } catch { /* 状态广播不能影响入队 */ }
    };

    function bind(nextWorker) {
        worker = nextWorker;
        return worker;
    }

    async function start(ids) {
        if (isRecoveryRunning()) return {error: "正在人工恢复残留任务", status: 409};
        if (isReloginRunning()) return {error: "重新登录正在进行中", status: 400};
        if (isSubmitRunning()) return {error: "充值提交正在进行中", status: 400};
        if (isExportRunning()) return {error: "导出 RT 正在进行中", status: 409};
        if (!ids.length) return {error: "未选择队列项", status: 400};
        if (!isConfigured()) return {error: "充值平台 API 未配置(缺少 Base URL 或 API Key)", status: 400};
        if (worker?.isBusy?.()) return {error: "重新登录正在进行中", status: 400};

        const uniqueIds = [...new Set(ids.map(Number).filter(Number.isInteger))];
        const rows = store.getMany
            ? await store.getMany(uniqueIds)
            : (await Promise.all(uniqueIds.map((id) => store.getQueue(id)))).filter(Boolean);
        const byId = new Map(rows.map((item) => [Number(item.id), item]));
        const eligible = [];
        const skipped = [];
        for (const id of uniqueIds) {
            const item = byId.get(id);
            if (!item) {
                skipped.push({id, reason: "队列项不存在"});
                continue;
            }
            if (["submitting", "submitted", "done"].includes(String(item.status || ""))) {
                skipped.push({id, email: item.email, reason: `状态 ${item.status}`});
                continue;
            }
            if (String(item.delivery_status || "undelivered") !== "undelivered") {
                skipped.push({id, email: item.email, reason: "已交付或已标记失败"});
                continue;
            }
            if (String(item.instance_id || "")) {
                skipped.push({id, email: item.email, reason: `实例 ${item.instance_id} 处理中`});
                continue;
            }
            eligible.push(item);
        }

        const tasks = store.enqueueTasks
            ? await store.enqueueTasks(eligible.map((item) => ({entityId: item.id, priority: 20})))
            : (await Promise.all(eligible.map((item) => store.enqueueTask(item.id, {priority: 20})))).filter(Boolean);
        const scheduledSet = new Set(tasks.map((task) => Number(task.entity_id)));
        const scheduled = eligible.filter((item) => scheduledSet.has(Number(item.id)));
        for (const item of eligible) {
            if (!scheduledSet.has(Number(item.id))) {
                skipped.push({id: item.id, email: item.email, reason: "已在重登提交分布式队列中"});
            }
        }
        if (!scheduled.length) {
            return {error: skipped[0]?.reason || "没有可重登提交的队列项", status: 400, skipped};
        }

        worker?.start?.();
        worker?.wake?.();
        notify();
        effects.log(`重登提交已入分布式队列: ${scheduled.length} 个，实例按并发自动分片`);
        return {
            ok: true,
            count: scheduled.length,
            queued: scheduled.length,
            claimed: scheduled.length,
            skipped: skipped.length,
            instanceId,
        };
    }

    async function processTask(task, context = {}) {
        return executor.execute(task, context);
    }

    function onTaskStart(task) {
        notify();
    }

    function onTaskFinish(task) {
        notify();
    }

    function stop() {
        const killed = effects.childProcesses?.terminateAll?.() || 0;
        void worker?.stop?.({waitForIdle: true, timeoutMs: 15_000});
        notify();
        return {ok: true, running: isRunning(), killed};
    }

    return {
        bind,
        start,
        processTask,
        onTaskStart,
        onTaskFinish,
        stop,
        isRunning: () => !!worker?.isBusy?.(),
    };
}
