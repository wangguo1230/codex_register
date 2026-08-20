import assert from "node:assert/strict";
import test from "node:test";
import {createRechargeBatchRuntime} from "./recharge-batch-runtime.js";

test("充值批次运行态保持代际锁和停止语义", () => {
    let now = 1_000;
    let changes = 0;
    const runtime = createRechargeBatchRuntime({
        now: () => now,
        onChange: () => { changes++; },
    });

    const first = runtime.begin();
    assert.equal(runtime.isRunning(), true);
    assert.equal(runtime.isStopped(), false);

    runtime.requestStop();
    assert.equal(runtime.isRunning(), true);
    assert.equal(runtime.isStopped(), true);

    now = 1_250;
    assert.equal(runtime.elapsedMs(), 250);

    const second = runtime.begin();
    assert.equal(runtime.isStopped(), false);
    assert.equal(runtime.isStopped(first), true);
    assert.equal(runtime.isStopped(second), false);
    assert.equal(runtime.requestStop(first), false);
    assert.equal(runtime.isStopped(second), false);
    assert.equal(runtime.end(first), false);
    assert.equal(runtime.isRunning(), true);

    assert.equal(runtime.end(second), true);
    assert.equal(runtime.isRunning(), false);
    assert.equal(runtime.isStopped(), false);
    assert.equal(changes, 4);
});

test("强制解锁只释放运行锁并保留停止标记", () => {
    const runtime = createRechargeBatchRuntime();
    runtime.begin();
    runtime.requestStop();
    runtime.forceUnlock();

    assert.equal(runtime.isRunning(), false);
    assert.equal(runtime.isStopped(), true);
});
