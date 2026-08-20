import assert from "node:assert/strict";
import test from "node:test";
import {createTokenBatchService} from "./token-batch-service.js";

function deferred() {
    let resolve;
    let reject;
    const promise = new Promise((res, rej) => {
        resolve = res;
        reject = rej;
    });
    return {promise, resolve, reject};
}

function createHarness({testAt, testRt, runPool} = {}) {
    const broadcasts = [];
    const scheduler = {
        maintLock: null,
        running: new Map(),
        concurrency: 2,
        acquireLock(owner) {
            if (this.maintLock) return false;
            this.maintLock = owner;
            return true;
        },
        releaseLock(owner) {
            if (this.maintLock !== owner) return false;
            this.maintLock = null;
            return true;
        },
        tick() {},
        async waitRegistrationIdle() {},
    };
    const accounts = [{id: 1}, {id: 2}];
    const service = createTokenBatchService({
        scheduler,
        store: {getAccount: async (id) => accounts.find((item) => item.id === id)},
        testAt: testAt || (async () => ({ok: true})),
        testRt: testRt || (async () => ({ok: true})),
        pickAccounts: async () => accounts,
        runPool: runPool || (async (items, worker) => {
            await Promise.all(items.map(worker));
        }),
        effects: {
            broadcast: (type, payload) => broadcasts.push({type, payload}),
            logAccount() {},
            info() {},
            warn() {},
        },
    });
    return {service, scheduler, broadcasts};
}

test("强制停止后旧代际不能清除新批次状态", async () => {
    const firstRun = deferred();
    const secondRun = deferred();
    let runs = 0;
    const h = createHarness({
        runPool: async (_items, worker) => {
            runs++;
            if (runs === 1) {
                await worker({id: 1});
                return;
            }
            await secondRun.promise;
        },
        testAt: async () => {
            if (runs === 1) await firstRun.promise;
            return {ok: true};
        },
    });

    await h.service.startAt([1], {relogin: true});
    assert.equal(h.service.stopAt({force: true}).forced, true);
    await h.service.startAt([2], {relogin: true});
    assert.equal(h.service.atStatus().running, true);

    firstRun.resolve();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(h.service.atStatus().running, true);
    assert.equal(h.scheduler.maintLock, "batch-at-relogin");

    secondRun.resolve();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(h.service.atStatus().running, false);
    assert.equal(h.scheduler.maintLock, null);
    const stoppedEvents = h.broadcasts.filter((item) => item.type === "batchAt" && item.payload.running === false);
    assert.equal(stoppedEvents.length, 2);
});

test("RT 批次异常后释放维护锁", async () => {
    const h = createHarness({
        runPool: async () => { throw new Error("pool failed"); },
    });

    const result = await h.service.startRt([1], {acquire: true});
    assert.equal(result.ok, true);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(h.scheduler.maintLock, null);
});

test("已有其他维护锁时拒绝启动浏览器批次", async () => {
    const h = createHarness();
    h.scheduler.maintLock = "mail-job";

    const at = await h.service.startAt([1], {relogin: true});
    const rt = await h.service.startRt([1], {acquire: true});

    assert.equal(at.status, 409);
    assert.equal(rt.status, 409);
    assert.equal(h.scheduler.maintLock, "mail-job");
});

test("强制停止批量 AT 会终止正在重登的 Worker", async () => {
    const child = {
        signals: [],
        once() {},
        kill(signal) { this.signals.push(signal); },
    };
    const gate = deferred();
    const h = createHarness({
        testAt: async (_account, options) => {
            options.onChild(child);
            await gate.promise;
            return {ok: false};
        },
    });

    await h.service.startAt([1], {relogin: true});
    await new Promise((resolve) => setImmediate(resolve));
    const result = h.service.stopAt({force: true});

    assert.equal(result.killed, 1);
    assert.deepEqual(child.signals, ["SIGTERM"]);
    gate.resolve();
});
