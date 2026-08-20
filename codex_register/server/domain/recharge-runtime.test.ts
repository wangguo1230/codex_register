import assert from "node:assert/strict";
import test from "node:test";
import {createRechargeLifecycle} from "./recharge-lifecycle.js";
import {createRechargeRuntime} from "./recharge-runtime.js";

function deferred() {
    let resolve;
    const promise = new Promise((done) => { resolve = done; });
    return {promise, resolve};
}

test("并发队列同步合并请求并在脏标记后补一轮", async () => {
    const first = deferred();
    let reads = 0;
    const snapshots = [];
    const runtime = createRechargeRuntime({
        store: {
            listCards: async () => [],
            listQueue: async () => {
                reads++;
                if (reads === 1) await first.promise;
                return {read: reads};
            },
        },
        jobs: {reloginRunning: () => false, batchRunning: () => false, exportRunning: () => false},
        publish: (event, data) => { if (event === "rechargeQueue") snapshots.push(data); },
    });

    const one = runtime.syncQueue();
    const two = runtime.syncQueue();
    first.resolve();
    await Promise.all([one, two]);

    assert.equal(reads, 2);
    assert.deepEqual(snapshots, [{read: 1}, {read: 2}]);
});

test("定时同步运行期间只记脏标记并从完成时间重新限频", async () => {
    const gate = deferred();
    const timers = [];
    let now = 10_000;
    let queueReads = 0;
    const clock = {
        setTimeout(callback, ms) {
            const timer = {callback, ms, unref() {}};
            timers.push(timer);
            return timer;
        },
        clearTimeout(timer) {
            const index = timers.indexOf(timer);
            if (index >= 0) timers.splice(index, 1);
        },
    };
    const runtime = createRechargeRuntime({
        store: {
            listCards: async () => [],
            listQueue: async () => {
                queueReads++;
                if (queueReads === 1) await gate.promise;
                return [];
            },
        },
        jobs: {reloginRunning: () => false, batchRunning: () => false, exportRunning: () => false},
        publish() {},
        syncSchedule: {delayMs: 100, minIntervalMs: 5_000, now: () => now, clock},
    });

    runtime.scheduleAll();
    assert.equal(timers.length, 1);
    assert.equal(timers[0].ms, 100);
    timers.shift().callback();
    await new Promise((resolve) => setImmediate(resolve));
    runtime.scheduleAll();
    assert.equal(timers.length, 0);

    gate.resolve();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(timers.length, 1);
    assert.equal(timers[0].ms, 5_000);
    runtime.stopScheduledSync();
});

test("充值任务状态保持提交、重登和导出互斥语义", () => {
    let relogin = true;
    let batch = true;
    const runtime = createRechargeRuntime({
        store: {listCards: async () => [], listQueue: async () => []},
        jobs: {reloginRunning: () => relogin, batchRunning: () => batch, exportRunning: () => true},
        publish() {},
    });

    assert.deepEqual(runtime.jobState(), {submit: false, reloginSubmit: true, relogin: false, exportRt: true});
    batch = false;
    assert.deepEqual(runtime.jobState(), {submit: false, reloginSubmit: false, relogin: true, exportRt: true});
});

test("充值生命周期只停止当前进程操作，不注册历史任务恢复", () => {
    const stopped = [];
    const lifecycle = createRechargeLifecycle({
        relogin: {requestStop: () => stopped.push("relogin")},
        batch: {requestStop: () => stopped.push("batch")},
        exports: {requestStop: () => stopped.push("exports")},
        rebind: {requestStop: () => stopped.push("rebind")},
    });

    lifecycle.stop();
    assert.deepEqual(stopped, ["relogin", "batch", "exports", "rebind"]);
});
