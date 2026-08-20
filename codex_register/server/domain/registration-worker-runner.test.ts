import assert from "node:assert/strict";
import test from "node:test";
import {createRegistrationWorkerRunner} from "./registration-worker-runner.js";

test("注册 Worker 结果事件向引擎传递 scheduler 门面", async () => {
    const scheduler = {running: new Map(), emit() {}, tick() {}};
    const runner = createRegistrationWorkerRunner({scheduler, rootDir: process.cwd()});
    let received = null;
    const info = {
        id: 7,
        gotResult: false,
        engine: {onResult: async (owner, id, event) => { received = {owner, id, event}; }},
    };

    await runner.handleLine(info, '@@EVENT@@{"type":"result","ok":true}');

    assert.equal(info.gotResult, true);
    assert.equal(received.owner, scheduler);
    assert.equal(received.id, 7);
    assert.equal(received.event.ok, true);
    runner.dispose();
});
