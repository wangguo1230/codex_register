import assert from "node:assert/strict";
import test from "node:test";
import {createOwnedOperationLock} from "./owned-operation-lock.js";
import {startSchedulerPollLoop} from "./scheduler-poll-loop.js";
import {createSchedulerSettingsStore} from "./scheduler-settings-store.js";

test("维护锁只允许持有者释放", () => {
    const lock = createOwnedOperationLock();
    assert.equal(lock.acquire("job-a"), true);
    assert.equal(lock.acquire("job-b"), false);
    assert.equal(lock.release("job-b"), false);
    assert.equal(lock.owner(), "job-a");
    assert.equal(lock.release("job-a"), true);
    assert.equal(lock.owner(), null);
});

test("调度轮询可显式停止且不在暂停态执行", async () => {
    let callback;
    let cleared = null;
    let active = false;
    let ticks = 0;
    const timer = {unrefCalled: false, unref() { this.unrefCalled = true; }};
    const stop = startSchedulerPollLoop({
        tick: async () => { ticks++; },
        isActive: () => active,
        clock: {
            setInterval(fn) { callback = fn; return timer; },
            clearInterval(value) { cleared = value; },
        },
    });

    callback();
    await Promise.resolve();
    assert.equal(ticks, 0);
    active = true;
    callback();
    await Promise.resolve();
    assert.equal(ticks, 1);
    assert.equal(timer.unrefCalled, true);
    stop();
    assert.equal(cleared, timer);
});

test("调度配置只持久化白名单且 daily.running 不落盘", () => {
    const writes = new Map();
    const files = {
        existsSync: (path) => writes.has(path),
        readFileSync: (path) => writes.get(path),
        writeFileSync: (path, value) => writes.set(path, value),
    };
    const store = createSchedulerSettingsStore({settingsFile: "settings", dailyFile: "daily", files});
    store.writeSettings({concurrency: 3, proxyPool: ["socks5://127.0.0.1:18080"], proxyPoolMailEnabled: false, secretRuntimeField: "drop"});
    store.writeDaily({...store.readDaily(), running: true, runCount: 2});

    assert.equal(store.readSettings().concurrency, 3);
    assert.equal(store.readSettings().secretRuntimeField, undefined);
    assert.deepEqual(store.readSettings().proxyPool, ["socks5://127.0.0.1:18080"]);
    assert.equal(store.readSettings().proxyPoolMailEnabled, false);
    assert.equal(JSON.parse(writes.get("daily")).running, undefined);
    assert.equal(store.readDaily().running, false);
    assert.equal(store.readDaily().runCount, 2);
});
