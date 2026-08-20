// @ts-nocheck
// 充值平台状态轮询 worker 的组合根适配，不包含平台状态机。
import {createPersistentTaskWorker} from "../domain/persistent-task-worker.js";
import {normalizeConcurrency} from "../domain/concurrency.js";

export function createRechargePollWorker({db, scheduler, isConfigured, reconcile, log, syncQueue = async () => {}} = {}) {
    const intervalMs = () => Math.max(1_000, Math.min(60_000, Number(scheduler.rechargeInterval || 5) * 1000));
    return createPersistentTaskWorker({
        kind: "recharge_poll",
        instanceId: db.instanceId,
        concurrency: () => normalizeConcurrency(scheduler.rechargeConcurrency, 3),
        claim: (limit, leaseMs) => db.claimWorkTasks("recharge_poll", db.instanceId, limit, leaseMs),
        heartbeat: (task, leaseMs) => db.heartbeatWorkTask(task.id, db.instanceId, task.lease_token, leaseMs),
        complete: async (task, result) => {
            const applied = await db.completeWorkTask(task.id, db.instanceId, task.lease_token, result);
            if (applied && result?.reschedule) {
                await db.enqueueWorkTask("recharge_poll", task.entity_id, {}, {availableAt: Date.now() + intervalMs()});
            }
            if (applied) await syncQueue().catch(() => {});
            return applied;
        },
        fail: (task, error) => db.failWorkTask(task.id, db.instanceId, task.lease_token, error),
        release: (task, reason) => db.releaseWorkTask(task.id, db.instanceId, task.lease_token, reason),
        cancel: (task) => db.cancelWorkTask("recharge_poll", task.entity_id),
        execute: async (task) => {
            if (!isConfigured()) return {reschedule: false, skipped: "充值 API 未配置"};
            const item = await db.getRechargeQueueItem(task.entity_id);
            if (!item || !item.card_code || ["done", "error"].includes(String(item.status || ""))) {
                return {reschedule: false, skipped: "已到终态"};
            }
            await reconcile([item]);
            const fresh = await db.getRechargeQueueItem(task.entity_id);
            return {
                reschedule: !!fresh && !!fresh.card_code
                    && !["done", "error"].includes(String(fresh.status || ""))
                    && String(fresh.task_status || "").toLowerCase() !== "paid",
            };
        },
        onChange: (state) => {
            if (state.error) log(`充值状态 worker 拉取失败: ${String(state.error?.message || state.error).slice(0, 140)}`);
        },
    });
}
