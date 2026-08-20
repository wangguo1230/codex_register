import assert from "node:assert/strict";
import test from "node:test";
import {createRechargeCardRecovery} from "./recharge-card-recovery.js";

test("卡密复活找到目标数量后立即停止后续平台核验", async () => {
    const validated = [];
    const released = [];
    const revive = createRechargeCardRecovery({
        listErrorCards: async () => [
            {id: 1, code: "card-1", status: "error"},
            {id: 2, code: "card-2", status: "error"},
        ],
        validateCard: async (code) => {
            validated.push(code);
            return {status: "unused", account_change_allowed: true};
        },
        unpairCards: async (ids) => { released.push(...ids); return ids.length; },
        isAllowed: (value) => value === true,
    });

    const count = await revive();

    assert.equal(count, 1);
    assert.deepEqual(validated, ["card-1"]);
    assert.deepEqual(released, [1]);
});

test("平台 unused 但数据库拒绝解绑时不误报复活", async () => {
    const logs = [];
    const revive = createRechargeCardRecovery({
        listErrorCards: async () => [{id: 1, code: "card-1", status: "error"}],
        validateCard: async () => ({status: "unused"}),
        unpairCards: async () => 0,
        isAllowed: () => false,
        log: (line) => logs.push(line),
    });

    assert.equal(await revive(), 0);
    assert.match(logs[0], /仍被活动队列占用/);
});
