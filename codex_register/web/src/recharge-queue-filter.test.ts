import assert from "node:assert/strict";
import test from "node:test";
import type {RechargeQueueItem} from "./api";
import {filterRechargeQueue} from "./recharge-queue-filter";

function item(overrides: Partial<RechargeQueueItem> = {}): RechargeQueueItem {
    return {
        id: 1,
        account_id: 1,
        email: "current@mail.com",
        auth_file: "",
        plan: "",
        batch: "batch-a",
        card_id: 1,
        card_code: "",
        status: "done",
        task_no: "",
        task_status: "paid",
        task_message: "",
        error: "",
        plan_type: "pro",
        created_at: 1,
        submitted_at: 1,
        ...overrides,
    };
}

test("邮箱类型按当前邮箱判断", () => {
    const rows = [
        item({id: 1, email: "a@gmail.com"}),
        item({id: 2, email: "b@mail.com"}),
        item({id: 3, email: "c@icloud.com"}),
    ];
    assert.deepEqual(filterRechargeQueue(rows, {mailboxType: "gmail"}).map((row) => row.id), [1]);
    assert.deepEqual(filterRechargeQueue(rows, {mailboxType: "mailcom"}).map((row) => row.id), [2]);
    assert.deepEqual(filterRechargeQueue(rows, {mailboxType: "icloud"}).map((row) => row.id), [3]);
});

test("邮箱搜索同时匹配当前、原始、目标和待核对邮箱", () => {
    const row = item({
        email: "current@gmail.com",
        rebind_from: "original@mail.com",
        rebind_email: "target@gmail.com",
        rebind_attempt_email: "attempt@gmail.com",
    });
    for (const email of ["current@gmail.com", "original@mail.com", "target@gmail.com", "attempt@gmail.com"]) {
        assert.equal(filterRechargeQueue([row], {email}).length, 1, email);
    }
});

test("换绑状态区分未换绑、已换绑和待核对", () => {
    const plain = item({id: 1});
    const rebound = item({id: 2, email: "new@gmail.com", rebind_from: "old@mail.com", rebind_status: "ok", rebind_target: "gmail"});
    const unknown = item({id: 3, rebind_status: "unknown", rebind_attempt_email: "maybe@gmail.com"});
    const skipped = item({id: 4, rebind_status: "skipped"});
    const rows = [plain, rebound, unknown, skipped];
    assert.deepEqual(filterRechargeQueue(rows, {rebind: "none"}).map((row) => row.id), [1, 4]);
    assert.deepEqual(filterRechargeQueue(rows, {rebind: "ok"}).map((row) => row.id), [2]);
    assert.deepEqual(filterRechargeQueue(rows, {rebind: "unknown"}).map((row) => row.id), [3]);
    assert.deepEqual(filterRechargeQueue(rows, {rebind: "gmail"}).map((row) => row.id), [2, 3]);
});

test("状态、批次、类型和邮箱条件组合取交集", () => {
    const rows = [
        item({id: 1, email: "one@gmail.com", status: "pending", batch: "a"}),
        item({id: 2, email: "two@gmail.com", status: "pending", batch: "b"}),
        item({id: 3, email: "one@mail.com", status: "pending", batch: "a"}),
    ];
    assert.deepEqual(filterRechargeQueue(rows, {
        status: "pending",
        batch: "a",
        mailboxType: "gmail",
        email: "one",
    }).map((row) => row.id), [1]);
});

test("充值分组优先使用 recharge_group，兼容旧 batch 字段", () => {
    const rows = [
        item({id: 1, batch: "legacy", recharge_group: "delivery-a"}),
        item({id: 2, batch: "delivery-b", recharge_group: "delivery-b"}),
    ];
    assert.deepEqual(filterRechargeQueue(rows, {batch: "delivery-a"}).map((row) => row.id), [1]);
    assert.deepEqual(filterRechargeQueue(rows, {batch: "legacy"}).map((row) => row.id), []);
});
