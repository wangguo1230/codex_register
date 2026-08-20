// @ts-nocheck
// Gmail 换绑排队服务：统一处理去重、冷却、默认池范围和排队状态落库。
import {createKeyedJobQueue} from "./keyed-job-queue.js";
import {normalizeConcurrency} from "./concurrency.js";

export function createGmailRebindQueueService({
    concurrency,
    execute,
    store,
    policy,
    poolGroup,
    defaultTarget,
    extractEmails,
    effects,
    getTaskWorker = () => null,
    cancelTask = async () => false,
    isRecoveryRunning = () => false,
    isExportRunning = () => false,
    now = Date.now,
} = {}) {
    const limit = () => normalizeConcurrency(concurrency());
    const queue = createKeyedJobQueue({
        concurrency: limit,
        execute,
        onError: (queueId, error) => effects.log(`换绑异常 ${queueId}: ${error?.message || error}`),
    });
    const preparing = new Set();
    const localIds = new Set();

    async function enqueue(item, {force = false, target, pool} = {}) {
        if (isRecoveryRunning()) {
            effects.log(`换绑跳过 ${item?.email || item?.id || "?"}: 正在人工恢复残留任务`);
            return false;
        }
        if (isExportRunning()) {
            effects.log(`换绑跳过 ${item?.email || item?.id || "?"}: 正在导出 RT`);
            return false;
        }
        const destination = policy.resolveTarget(item, {force, target, defaultTarget: defaultTarget()});
        if (!destination) return false;
        const id = Number(item?.id);
        if (!Number.isInteger(id)) return false;
        if (queue.has(id) || preparing.has(id)) {
            effects.log(`换绑跳过 ${item.email || id}: 已在进行，不要重复点`);
            return false;
        }
        if (String(item.rebind_instance || "").trim()) {
            effects.log(`换绑跳过 ${item.email || id}: 已由实例 ${item.rebind_instance} 认领`);
            return false;
        }

        const status = String(item.rebind_status || "");
        if (status === "unknown") {
            effects.log(`换绑跳过 ${item.email || id}: 状态待核对，先对账确认官方到底改没改`);
            effects.reconcile();
            return false;
        }
        const blockedUntil = Number(item?.rebind_blocked_until) || 0;
        if (blockedUntil > now()) {
            effects.log(`换绑跳过 ${item.email || id}: 官方 24h 换绑上限未解，${policy.formatUntil(blockedUntil)} 后再点`);
            return false;
        }
        if (!force && ["ok", "pending", "skipped"].includes(status)) return false;

        let normalizedPool = destination === "gmail"
            ? policy.normalizePool(pool || item?.rebind_pool || {}, extractEmails)
            : {};
        if (destination === "gmail" && !normalizedPool.emails?.length && normalizedPool.grp === undefined) {
            normalizedPool = {grp: poolGroup};
        }
        const currentLimit = limit();
        const waitsForSlot = queue.activeCount() >= currentLimit;
        const persistedPool = (normalizedPool.emails || normalizedPool.grp !== undefined) ? normalizedPool : null;
        preparing.add(id);
        try {
            const scheduled = store.scheduleQueue
                ? await store.scheduleQueue(id, {
                    expectedStatus: status,
                    target: destination,
                    pool: persistedPool,
                })
                : await store.updateQueue(id, {
                    rebind_status: "pending",
                    rebind_error: "",
                    rebind_target: destination,
                    rebind_pool: persistedPool,
                }).then(() => true);
            if (!scheduled) {
                effects.log(`换绑排队跳过 ${item.email || id}: 状态已变化或已被其他实例认领`);
                return false;
            }
            const worker = getTaskWorker();
            if (worker) {
                localIds.add(id);
                worker.wake();
            } else if (!queue.enqueue(id, {target: destination, pool: normalizedPool})) {
                return false;
            }
        } catch (error) {
            effects.log(`换绑排队失败 ${item.email || id}: ${error?.message || error}`);
            return false;
        } finally {
            preparing.delete(id);
        }
        try {
            await effects.syncQueue();
        } catch (error) {
            effects.log(`换绑 ${item.email || id} 已入队，但刷新队列视图失败: ${String(error?.message || error).slice(0, 120)}`);
        }
        if (waitsForSlot) effects.log(`换绑 ${item.email} → ${policy.targetLabel(destination)} 已排队，等空位（并发 ${currentLimit}）`);
        return true;
    }

    return {
        enqueue,
        has: (id) => localIds.has(Number(id)) || queue.has(id),
        cancel: (id) => {
            const key = Number(id);
            const found = localIds.has(key) || queue.has(key);
            if (found) void cancelTask(key).catch(() => {});
            if (queue.has(key)) return queue.cancel(key);
            return {found, active: false};
        },
        cancelAll: () => {
            const ids = [...localIds];
            for (const id of ids) void cancelTask(id).catch(() => {});
            const result = queue.cancelAll();
            return {count: ids.length + result.count, active: result.active};
        },
        isCancelled: queue.isCancelled,
        getMetadata: queue.getMetadata,
        activeCount: () => getTaskWorker()?.activeCount?.() || queue.activeCount(),
        isBusy: () => preparing.size > 0 || !!getTaskWorker()?.isBusy?.() || queue.size() > 0,
        waitForIdle: (options) => getTaskWorker()?.waitForIdle?.(options) || queue.waitForIdle(options),
        onTaskStart: (task) => localIds.add(Number(task.entity_id)),
        onTaskFinish: (task) => localIds.delete(Number(task.entity_id)),
    };
}
