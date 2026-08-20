import assert from "node:assert/strict";
import test from "node:test";
import {canSafelyReleaseQueueCard} from "./recharge-queue-maintenance-repository.js";

test("只有无平台提交痕迹的 paired 或 unused 卡密允许随队列释放", () => {
    const cleanQueue = {id: 1, account_id: 7, task_no: "", task_status: ""};

    assert.equal(canSafelyReleaseQueueCard(cleanQueue, {status: "paired", account_id: 7, task_no: "", task_status: ""}), true);
    assert.equal(canSafelyReleaseQueueCard(cleanQueue, {status: "unused", task_no: "", task_status: ""}), true);
    assert.equal(canSafelyReleaseQueueCard(cleanQueue, {status: "error", task_no: "", task_status: ""}), false);
    assert.equal(canSafelyReleaseQueueCard({...cleanQueue, task_no: "task-1"}, {status: "paired"}), false);
    assert.equal(canSafelyReleaseQueueCard({...cleanQueue, submitted_at: 123}, {status: "paired"}), false);
    assert.equal(canSafelyReleaseQueueCard(cleanQueue, {status: "paired", task_status: "unknown"}), false);
    assert.equal(canSafelyReleaseQueueCard(cleanQueue, {status: "paired", account_id: 8}), false);
});
