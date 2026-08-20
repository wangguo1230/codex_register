// @ts-nocheck
// 普通充值提交持久化 worker 的组合根适配。
import {createPersistentTaskWorker} from "../domain/persistent-task-worker.js";
import {normalizeConcurrency} from "../domain/concurrency.js";

export function createRechargeSubmitWorker({db, scheduler, submit, log} = {}) {
    return createPersistentTaskWorker({
        kind: "recharge_submit",
        instanceId: db.instanceId,
        concurrency: () => normalizeConcurrency(scheduler.rechargeConcurrency, 3),
        claim: (limit, leaseMs) => db.claimWorkTasks("recharge_submit", db.instanceId, limit, leaseMs),
        heartbeat: (task, leaseMs) => db.heartbeatWorkTask(task.id, db.instanceId, task.lease_token, leaseMs),
        complete: (task, result) => db.completeWorkTask(task.id, db.instanceId, task.lease_token, result),
        fail: (task, error) => db.failWorkTask(task.id, db.instanceId, task.lease_token, error),
        release: (task, reason) => db.releaseWorkTask(task.id, db.instanceId, task.lease_token, reason),
        cancel: (task) => db.cancelWorkTask("recharge_submit", task.entity_id),
        execute: (task, context) => submit.processDistributedTask(task, context),
        onChange: (state) => {
            if (state.error) log(`充值分布式 worker 拉取失败: ${String(state.error?.message || state.error).slice(0, 140)}`);
        },
    });
}
