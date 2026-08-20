import assert from "node:assert/strict";
import test from "node:test";
import {resolveRechargeTaskSettlement, resolveRechargeTaskTransition} from "../domain/recharge-task-state.js";

test("平台创建任务立即返回终态时直接收敛队列和卡密", () => {
    const paid = resolveRechargeTaskSettlement("PAID", () => 123);
    const failed = resolveRechargeTaskSettlement("returned", () => 456);

    assert.deepEqual(paid, {
        terminal: true,
        releaseCard: false,
        queueStatus: "done",
        cardStatus: "done",
        finishedAt: 123,
    });
    assert.deepEqual(failed, {
        terminal: true,
        releaseCard: true,
        queueStatus: "error",
        cardStatus: "unused",
        finishedAt: 456,
    });
});

test("充值完成终态拒绝旧失败结果覆盖", () => {
    const result = resolveRechargeTaskTransition(
        {status: "done", task_status: "paid"},
        {status: "error", task_status: "failed"},
    );
    assert.equal(result.applied, false);
});

test("处理中任务拒绝 queued 旧快照降级并补齐 submitted", () => {
    const result = resolveRechargeTaskTransition(
        {status: "submitting", task_status: "processing", submitted_at: 0},
        {task_status: "queued", task_message: "old"},
        () => 123,
    );
    assert.equal(result.applied, true);
    assert.equal(result.updates.task_status, undefined);
    assert.equal(result.updates.task_message, undefined);
    assert.equal(result.updates.status, "submitted");
    assert.equal(result.updates.submitted_at, 123);
});
