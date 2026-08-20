import assert from "node:assert/strict";
import test from "node:test";
import {createDailyMaintenanceService} from "./daily-maintenance-service.js";

function createHarness({items, testAt, testRt, chatRun, now = () => 10_000} = {}) {
    const deadUpdates = [];
    const account = {id: 1, email: "a@example.com", dead_at: 0, sold_at: 0};
    const scheduler = {
        daily: {
            enabled: true,
            hour: 4,
            items: items || {at: true, rt: true, chat: false},
            running: false,
            lastRunAt: 0,
            lastResult: "",
        },
        maintLock: null,
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
        async waitRegistrationIdle() {},
        tick() {},
        configureDaily(config) {
            Object.assign(this.daily, config);
            return this.daily;
        },
        recordDailyRun(result) {
            this.daily.lastRunAt = now();
            this.daily.lastResult = `[${result.trigger}] ${result.accounts}个号`;
        },
        setDailyRunning(running) { this.daily.running = running; },
    };
    const service = createDailyMaintenanceService({
        scheduler,
        store: {
            listSuccess: async () => [account],
            get: async () => account,
            setDeadAt: async (_id, value) => { deadUpdates.push(value); },
        },
        tokens: {
            testAt: testAt || (async () => ({ok: true})),
            testRt: testRt || (async () => ({ok: true})),
        },
        chat: {run: chatRun || (async () => ({ok: true}))},
        runPool: async (values, worker) => Promise.all(values.map(worker)),
        effects: {broadcast() {}, logAccount() {}},
        now,
    });
    return {service, scheduler, account, deadUpdates};
}

test("AT 和 RT 都失效时才记录死亡时间", async () => {
    const dead = createHarness({
        testAt: async () => ({ok: false}),
        testRt: async () => ({ok: false}),
    });
    await dead.service.maintainAccount(dead.account, {at: true, rt: true});
    assert.deepEqual(dead.deadUpdates, [10_000]);

    const alive = createHarness({
        testAt: async () => ({ok: false}),
        testRt: async () => ({ok: true}),
    });
    await alive.service.maintainAccount(alive.account, {at: true, rt: true});
    assert.deepEqual(alive.deadUpdates, [0]);
});

test("养号异常后释放维护锁并清除 daily 运行态", async () => {
    const h = createHarness({
        items: {at: false, rt: false, chat: true},
        chatRun: async () => { throw new Error("browser failed"); },
    });

    const result = await h.service.run("manual");

    assert.equal(result.ok, false);
    assert.equal(h.scheduler.maintLock, null);
    assert.equal(h.scheduler.daily.running, false);
});

test("同一天定时维护只触发一次", async () => {
    const h = createHarness({items: {at: false, rt: false, chat: false}});
    h.scheduler.daily.lastRunAt = new Date(2026, 7, 19, 3).getTime();

    assert.equal(h.service.runIfDue(new Date(2026, 7, 19, 4)), false);
    assert.equal(h.service.runIfDue(new Date(2026, 7, 20, 3)), false);
});
