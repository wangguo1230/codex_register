import assert from "node:assert/strict";
import test from "node:test";
import {createRechargeServiceBridge} from "./recharge-service-bridge.js";

test("充值桥接只允许绑定一次并转发调用", async () => {
    const calls: string[] = [];
    const bridge = createRechargeServiceBridge();
    assert.throws(() => bridge.syncQueue(), /not bound/);
    bridge.bind({
        syncQueue: async () => { calls.push("sync"); },
        attachExportChild: () => { calls.push("child"); },
        log: () => { calls.push("log"); },
    });
    await bridge.syncQueue();
    bridge.attachExportChild({});
    bridge.log("line");
    assert.deepEqual(calls, ["sync", "child", "log"]);
    assert.throws(() => bridge.bind({}), /already bound/);
});
