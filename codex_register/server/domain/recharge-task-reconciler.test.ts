import assert from "node:assert/strict";
import test from "node:test";
import {createRechargeTaskReconciler} from "./recharge-task-reconciler.js";

test("生产收敛端口原子更新队列和卡密，并跳过过期轮询快照", async () => {
    const calls = [];
    const paid = [];
    const reconcile = createRechargeTaskReconciler({
        lookupTasks: async () => ({results: [
            {ok: true, redeem_code: "card-1", task: {status: "failed", message: "returned"}},
            {ok: true, redeem_code: "card-2", task: {status: "paid", message: "ok"}},
        ]}),
        applyResult: async (queueId, cardId, updates, options) => {
            calls.push({queueId, cardId, updates, options});
            return queueId === 1 ? {applied: true} : {applied: false, reason: "队列项已重新配卡"};
        },
        onPaid: async (item) => { paid.push(item.id); },
        log: () => {},
    });

    const settled = await reconcile([
        {id: 1, email: "a", card_id: 11, card_code: "card-1"},
        {id: 2, email: "b", card_id: 12, card_code: "card-2"},
    ]);

    assert.equal(calls[0].options.releaseCard, true);
    assert.equal(calls[0].updates.status, "error");
    assert.equal(paid.length, 0);
    assert.equal(settled, 1);
});

test("单个已支付任务换绑入队失败不阻断同批其他任务收敛", async () => {
    const applied = [];
    const logs = [];
    const reconcile = createRechargeTaskReconciler({
        lookupTasks: async () => ({results: [
            {ok: true, redeem_code: "card-1", task: {status: "paid"}},
            {ok: true, redeem_code: "card-2", task: {status: "paid"}},
        ]}),
        applyResult: async (queueId) => {
            applied.push(queueId);
            return {applied: true};
        },
        onPaid: async () => { throw new Error("rebind unavailable"); },
        log: (line) => logs.push(line),
    });

    const settled = await reconcile([
        {id: 1, email: "a", card_id: 11, card_code: "card-1"},
        {id: 2, email: "b", card_id: 12, card_code: "card-2"},
    ]);

    assert.equal(settled, 2);
    assert.deepEqual(applied, [1, 2]);
    assert.equal(logs.filter((line) => line.includes("自动换绑入队失败")).length, 2);
});

test("归一化后重复的卡密拒绝模糊更新队列", async () => {
    let applied = 0;
    const logs = [];
    const reconcile = createRechargeTaskReconciler({
        lookupTasks: async () => ({results: [
            {ok: true, redeem_code: "ABCD", task: {status: "paid"}},
        ]}),
        applyResult: async () => {
            applied++;
            return {applied: true};
        },
        log: (line) => logs.push(line),
    });

    const settled = await reconcile([
        {id: 1, email: "a", card_id: 11, card_code: "AB-CD"},
        {id: 2, email: "b", card_id: 12, card_code: "ABCD"},
    ]);

    assert.equal(settled, 0);
    assert.equal(applied, 0);
    assert.match(logs[0], /拒绝模糊收敛/);
});
