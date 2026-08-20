import assert from "node:assert/strict";
import test from "node:test";
import {buildRechargeRecoveryPlan, partitionRechargeRecoveryRows} from "./recharge-manual-recovery-repository.js";

test("人工恢复只解配状态一致的 paired，提交中状态保持待对账", () => {
    const plan = buildRechargeRecoveryPlan([
        {id: 1, account_id: 11, status: "paired", card_id: 101, instance_id: "old"},
        {id: 2, account_id: 12, status: "paired", card_id: 102, instance_id: "old"},
        {id: 3, status: "submitting", instance_id: "old"},
        {id: 4, status: "submitted", instance_id: ""},
        {id: 5, account_id: 13, status: "paired", card_id: 103, task_status: "unknown", instance_id: "old"},
        {id: 6, account_id: 14, status: "paired", card_id: 104, submitted_at: 123, instance_id: "old"},
    ], [
        {id: 101, account_id: 11, status: "paired"},
        {id: 102, account_id: 99, status: "paired"},
        {id: 103, account_id: 13, status: "paired"},
        {id: 104, account_id: 14, status: "paired"},
    ]);

    assert.deepEqual(plan.pairedQueueIds, [1]);
    assert.deepEqual(plan.pairedCardIds, [101]);
    assert.deepEqual(plan.reviewQueueIds, [2, 5, 6]);
    assert.deepEqual(plan.preservedQueueIds, [3, 4]);
    assert.deepEqual(plan.rechargeLeaseIds, [1, 2, 3, 5, 6]);
});

test("换绑 verify 残留转待核对，verify 前残留归还邮箱", () => {
    const plan = buildRechargeRecoveryPlan([
        {id: 1, rebind_status: "pending", rebind_instance: "old", rebind_attempt_stage: "verify"},
        {id: 2, rebind_status: "pending", rebind_instance: "old", rebind_attempt_stage: "begin"},
        {id: 3, rebind_status: "unknown", rebind_instance: "old", rebind_attempt_stage: "verify"},
    ], []);

    assert.deepEqual(plan.rebindLeaseIds, [1, 2, 3]);
    assert.deepEqual(plan.rebindUnknownIds, [1]);
    assert.deepEqual(plan.rebindReturnIds, [2]);
});

test("人工恢复跳过其他活实例，但允许处理当前实例的历史残留", () => {
    const partition = partitionRechargeRecoveryRows([
        {id: 1, instance_id: "current", rebind_instance: ""},
        {id: 2, instance_id: "other-live", rebind_instance: ""},
        {id: 3, instance_id: "other-stale", rebind_instance: ""},
        {id: 4, instance_id: "", rebind_instance: "other-live"},
    ], ["current", "other-live"], "current");

    assert.deepEqual(partition.recoverable.map((row) => row.id), [1, 3]);
    assert.deepEqual(partition.blocked.map((row) => row.id), [2, 4]);
});
