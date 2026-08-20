import assert from "node:assert/strict";
import test from "node:test";
import {createRechargeQueueService} from "./recharge-queue-service.js";

test("只回收平台未使用且未锁给其他账号的卡密", async () => {
    const unpaired = [];
    const updated = [];
    const items = [
        {id: 1, status: "error", email: "a@example.com", card_id: 11, card_code: "free-card"},
        {id: 2, status: "error", email: "b@example.com", card_id: 12, card_code: "locked-card"},
    ];
    const service = createRechargeQueueService({
        store: {
            get: async (id) => items.find((item) => item.id === id),
            unpairCards: async (ids) => { unpaired.push(...ids); return ids.length; },
            updateCard: async (id, value) => { updated.push([id, value]); },
        },
        api: {
            call: async (_method, _path, body) => ({
                result: {status: "unused", bound_email: body.redeem_code === "locked-card" ? "other@example.com" : "a@example.com"},
            }),
        },
        cardPolicy: {boundToOtherAccount: (result, email) => result.bound_email !== email},
        effects: {log() {}, syncCards: async () => {}},
    });

    const result = await service.reclaimCards([1, 2]);

    assert.deepEqual(unpaired, [11]);
    assert.equal(updated[0][0], 12);
    assert.deepEqual({reclaimed: result.reclaimed, used: result.used, failed: result.failed}, {reclaimed: 1, used: 1, failed: 0});
});

test("数据库未实际释放卡密时回收结果记为失败", async () => {
    const service = createRechargeQueueService({
        store: {
            get: async () => ({id: 1, status: "error", email: "a@example.com", card_id: 11, card_code: "card"}),
            unpairCards: async () => 0,
            updateCard: async () => {},
        },
        api: {call: async () => ({result: {status: "unused"}})},
        cardPolicy: {boundToOtherAccount: () => false},
        effects: {log() {}, syncCards: async () => {}},
    });

    const result = await service.reclaimCards([1]);

    assert.deepEqual({reclaimed: result.reclaimed, failed: result.failed}, {reclaimed: 0, failed: 1});
});
