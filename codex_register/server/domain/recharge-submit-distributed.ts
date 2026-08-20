// @ts-nocheck
// 充值提交的持久化任务适配器：按队列项执行，不持有批次级全局锁。
export function createRechargeSubmitDistribution({
    instanceId,
    store,
    cards,
    precheck,
    submitOne,
    config,
    effects,
    isReloginRunning = () => false,
    isExportRunning = () => false,
    isRecoveryRunning = () => false,
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now = () => Date.now(),
} = {}) {
    let worker = null;
    let stopped = false;

    const notify = async () => {
        try {
            if (effects.scheduleAll) effects.scheduleAll();
            else await effects.syncAll?.();
        } catch (error) {
            effects.log(`刷新充值视图失败: ${String(error?.message || error).slice(0, 120)}`);
        }
    };

    async function submitCandidate(candidate, account, isStopped) {
        if (isStopped()) return {stopped: true};
        const current = await store.get(candidate.id);
        if (isStopped()) return {stopped: true};
        if (!current) return {ok: false, reason: "队列项已不存在"};
        if (current.status === "error") return {ok: false, skipped: true};
        const picked = await cards.takeReusable(candidate.email, {isStopped});
        if (isStopped()) {
            if (picked.card) await cards.release([picked.card.id]).catch(() => {});
            return {stopped: true};
        }
        if (!picked.card) {
            const reason = cards.failureReason(picked);
            await store.updateQueue(candidate.id, {status: "error", error: reason, instance_id: "", finished_at: now()});
            await notify();
            return {ok: false, reason};
        }
        const card = picked.card;
        let assignment;
        try {
            assignment = await store.assignCard(candidate.id, card.id, candidate.account_id, candidate.email, instanceId);
        } catch (error) {
            await cards.release([card.id]).catch(() => {});
            throw error;
        }
        const queueItem = assignment?.queueItem;
        const liveCard = assignment?.card;
        if (!queueItem || !liveCard) {
            await store.cancelPair(candidate.id, card.id, instanceId).catch(() => {});
            return {ok: false, reason: "配卡事务未返回完整快照"};
        }
        await notify();
        if (isStopped()) {
            await store.cancelPair(queueItem.id, liveCard.id, instanceId).catch(() => {});
            return {stopped: true};
        }
        effects.log(`提交 ${queueItem.email} ← ${String(liveCard.code || "").slice(0, 8)}…`);
        const result = await submitOne(queueItem, liveCard, "", {validation: picked.val || null, account});
        await notify();
        const intervalMs = Math.max(0, Number(config.intervalSeconds?.() || 0) * 1000);
        if (!isStopped() && intervalMs) await sleep(intervalMs);
        return result;
    }

    async function processTask(task, {signal} = {}) {
        const id = Number(task.entity_id);
        const claimed = await store.claim([id], instanceId);
        const item = claimed?.claimed?.[0];
        if (!item) return {skipped: true, reason: claimed?.skipped?.[0]?.reason || "队列项不可认领"};
        const isStopped = () => stopped || signal?.aborted;
        try {
            const account = store.getAccounts
                ? (await store.getAccounts([item.account_id]))[0]
                : await store.getAccount?.(item.account_id);
            if (!account) {
                await store.updateQueue(item.id, {status: "error", error: "账号不存在", instance_id: "", finished_at: now()});
                return {ok: false, reason: "账号不存在"};
            }
            const check = await precheck(item, account);
            if (isStopped()) return {stopped: true};
            if (!check.ok) {
                if (check.transient) throw new Error(`预检临时失败: ${check.reason || "稍后重试"}`);
                await store.updateQueue(item.id, {status: "error", error: check.reason, instance_id: "", finished_at: now()});
                await notify();
                return {ok: false, reason: check.reason};
            }
            return await submitCandidate(item, account, isStopped);
        } finally {
            await store.releaseByInstance(instanceId, [id]).catch(() => {});
            await notify();
        }
    }

    async function start(queueIds) {
        if (isRecoveryRunning()) return {error: "正在人工恢复残留任务", status: 409};
        if (isReloginRunning()) return {error: "重新登录正在进行中", status: 400};
        if (isExportRunning()) return {error: "导出 RT 正在进行中", status: 409};
        if (!queueIds.length) return {error: "未选择队列项", status: 400};
        if (config?.isConfigured && !config.isConfigured()) return {error: "充值平台 API 未配置(缺少 Base URL 或 API Key)", status: 400};
        const uniqueIds = [...new Set(queueIds.map(Number).filter(Number.isInteger))];
        const items = store.getMany
            ? await store.getMany(uniqueIds)
            : (await Promise.all(uniqueIds.map((id) => store.get(id)))).filter(Boolean);
        const byId = new Map(items.map((item) => [Number(item.id), item]));
        const eligible = [];
        const skipped = [];
        for (const id of uniqueIds) {
            const item = byId.get(id);
            if (!item) { skipped.push({id, reason: "队列项不存在"}); continue; }
            if (item.status !== "pending" || String(item.delivery_status || "undelivered") !== "undelivered") {
                skipped.push({id, email: item.email, reason: `状态不可提交: ${item.status || "—"}`});
                continue;
            }
            eligible.push(item);
        }
        const tasks = store.enqueueTasks
            ? await store.enqueueTasks(eligible.map((item) => ({entityId: item.id, priority: 10})))
            : (await Promise.all(eligible.map((item) => store.enqueueTask(item.id, {priority: 10})))).filter(Boolean);
        const scheduledSet = new Set(tasks.map((task) => Number(task.entity_id)));
        const scheduled = eligible.filter((item) => scheduledSet.has(Number(item.id))).map((item) => Number(item.id));
        for (const item of eligible) {
            if (!scheduledSet.has(Number(item.id))) skipped.push({id: item.id, email: item.email, reason: "已在分布式队列中"});
        }
        if (!scheduled.length) return {error: skipped[0]?.reason || "没有可提交的队列项", status: 400, skipped};
        stopped = false;
        worker?.start?.();
        worker?.wake?.();
        effects.log(`充值提交已入分布式队列: ${scheduled.length} 个，实例会按并发自动分片`);
        return {ok: true, queued: scheduled.length, skipped, instanceId};
    }

    function bind(nextWorker) {
        worker = nextWorker;
        return worker;
    }

    function stop({force = false} = {}) {
        stopped = true;
        void worker?.stop?.({waitForIdle: true, timeoutMs: force ? 2_000 : 15_000});
        return {ok: true, running: !!worker?.isBusy?.(), forced: !!force};
    }

    return {
        bind,
        start,
        processTask,
        stop,
        isBound: () => !!worker,
        isRunning: () => !!worker?.isBusy?.(),
    };
}
