import assert from "node:assert/strict";
import test from "node:test";
import {createRechargeManualRecoveryService} from "./recharge-manual-recovery-service.js";

test("人工恢复在本进程有充值任务时拒绝修改持久化状态", async () => {
    let writes = 0;
    const service = createRechargeManualRecoveryService({
        runtime: {
            jobState: () => ({submit: true}),
            pollRunning: () => false,
            rebindRunning: () => false,
        },
        store: {recover: async () => { writes++; return {}; }},
        effects: {log() {}, sync: async () => {}},
    });

    const result = await service.recover([1]);

    assert.equal(result.status, 409);
    assert.equal(writes, 0);
});

test("人工恢复调用单一事务并在完成后刷新视图", async () => {
    const calls: string[] = [];
    const service = createRechargeManualRecoveryService({
        runtime: {
            jobState: () => ({}),
            pollRunning: () => false,
            rebindRunning: () => false,
        },
        store: {recover: async (ids) => {
            calls.push(`recover:${ids.join(",")}`);
            return {selected: 2, rechargeLeases: 1, pairedReset: 1, preserved: 1, rebindLeases: 1, rebindUnknown: 1};
        }},
        effects: {log: () => calls.push("log"), sync: async () => { calls.push("sync"); }},
    });

    const result = await service.recover([2, 1, 2]);

    assert.equal(result.ok, true);
    assert.deepEqual(calls, ["recover:2,1", "log", "sync"]);
    assert.equal(service.isRunning(), false);
});
