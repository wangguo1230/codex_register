import assert from "node:assert/strict";
import {EventEmitter} from "node:events";
import test from "node:test";
import {createApplicationLifecycle} from "./application-lifecycle.js";
import {createPeriodicTaskRegistry} from "./periodic-task-registry.js";

function createHarness() {
    const calls: string[] = [];
    const runtime = Object.assign(new EventEmitter(), {exit: (code) => calls.push(`exit:${code}`)});
    const activeTimers = new Set<number>();
    let timerId = 0;
    const periodicTasks = createPeriodicTaskRegistry({
        clock: {
            setInterval: () => { const id = ++timerId; activeTimers.add(id); return id; },
            clearInterval: (id) => activeTimers.delete(id),
        },
    });
    const server = new EventEmitter();
    const app = {
        listen: (_port, _host, callback) => {
            queueMicrotask(callback);
            return server;
        },
    };
    const state = {httpReady: false, infrastructureReady: false, shuttingDown: false};
    const lifecycle = createApplicationLifecycle({
        port: 3100,
        webBuilt: true,
        state,
        processGuard: {
            killExistingHttp: () => calls.push("guard:port"),
            registerPid: () => { calls.push("pid:add"); return () => calls.push("pid:drop"); },
        },
        store: {
            instanceId: "instance-1",
            setMailClaimPaused: async () => calls.push("claim:pause"),
            releaseInstanceWork: async () => ({gpt: 0, claude: 0, sms: 0, pw: 0, mail: 0, recharge: 0}),
            parkRebindWork: async () => { calls.push("rebind:park"); return {leases: 1, unknown: 0, mailboxes: 1}; },
        },
        scheduler: {
            pause: () => calls.push("scheduler:pause"),
            pauseClaude: () => calls.push("scheduler:pause-claude"),
            killDomain: (domain) => calls.push(`kill:${domain}`),
        },
        mailJobs: {
            startPaused: () => calls.push("jobs:paused"),
            heartbeat: async () => calls.push("jobs:heartbeat"),
            tick: async () => {},
            requestStop: () => calls.push("jobs:stop"),
            hasBusyWork: () => false,
        },
        recharge: {
            lifecycle: {stop: () => calls.push("recharge:stop")},
        },
        daily: {runIfDue: async () => {}},
        browser: {
            refreshWindows: async () => {},
            closeTrackedWindows: async () => calls.push("windows:close"),
        },
        rss: {start: async () => () => calls.push("rss:stop")},
        effects: {
            log: (message) => calls.push(String(message)),
            warn: (message) => calls.push(String(message)),
            error: (message) => calls.push(String(message)),
            rechargeLog: () => {},
            broadcastRechargeJobs: () => {},
        },
        runtime,
        periodicTasks,
    });
    return {lifecycle, app, state, calls, activeTimers};
}

test("HTTP 监听后等待基础设施就绪才注册后台轮询", async () => {
    const harness = createHarness();
    harness.lifecycle.startHttp(harness.app);
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(harness.state.httpReady, true);
    assert.equal(harness.activeTimers.size, 0);
    assert.equal(harness.calls.filter((value) => value === "jobs:paused").length, 0);

    harness.lifecycle.markInfrastructureReady();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(harness.activeTimers.size, 4);
    assert.equal(harness.calls.filter((value) => value === "jobs:paused").length, 1);
    harness.lifecycle.markInfrastructureReady();
    assert.equal(harness.activeTimers.size, 4);
    assert.equal(harness.calls.filter((value) => value === "jobs:paused").length, 1);
    harness.lifecycle.dispose();
    assert.equal(harness.activeTimers.size, 0);
});

test("并发关停共享同一退回流程并完整停止任务", async () => {
    const harness = createHarness();
    harness.lifecycle.startHttp(harness.app);
    await new Promise((resolve) => setImmediate(resolve));
    harness.lifecycle.markInfrastructureReady();

    const first = harness.lifecycle.parkWorkForShutdown("test");
    const second = harness.lifecycle.parkWorkForShutdown("test");
    assert.equal(first, second);
    await first;

    assert.equal(harness.state.shuttingDown, true);
    assert.equal(harness.activeTimers.size, 0);
    assert.equal(harness.calls.filter((value) => value === "jobs:stop").length, 1);
    assert.equal(harness.calls.filter((value) => value === "recharge:stop").length, 1);
    assert.equal(harness.calls.filter((value) => value === "rebind:park").length, 1);
    assert.equal(harness.calls.filter((value) => value === "windows:close").length, 1);
});

test("关停等待换绑执行器收敛后再停放持久化租约", async () => {
    const harness = createHarness();
    let releaseStop;
    const stopped = new Promise((resolve) => { releaseStop = resolve; });
    harness.lifecycle.dispose();

    const calls = [];
    const lifecycle = createApplicationLifecycle({
        port: 3100,
        webBuilt: true,
        state: {httpReady: true, infrastructureReady: true, shuttingDown: false},
        processGuard: {killExistingHttp() {}, registerPid: () => () => {}},
        store: {
            instanceId: "instance-1",
            setMailClaimPaused: async () => {},
            releaseInstanceWork: async () => ({gpt: 0, claude: 0, sms: 0, pw: 0, mail: 0, recharge: 0}),
            parkRebindWork: async () => { calls.push("park"); return {leases: 0}; },
        },
        scheduler: {pause() {}, pauseClaude() {}, killDomain() {}},
        mailJobs: {requestStop() {}, startPaused() {}, heartbeat: async () => {}, tick: async () => {}, hasBusyWork: () => false},
        recharge: {lifecycle: {stop: async () => { calls.push("stop"); await stopped; return {rebindIdle: true}; }}},
        daily: {runIfDue: async () => {}},
        browser: {refreshWindows: async () => {}, closeTrackedWindows: async () => {}},
        rss: {start: async () => () => {}},
        effects: {log() {}, warn() {}, error() {}, rechargeLog() {}, broadcastRechargeJobs() {}},
        runtime: Object.assign(new EventEmitter(), {exit() {}}),
    });

    const parking = lifecycle.parkWorkForShutdown("test");
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(calls, ["stop"]);
    releaseStop();
    await parking;
    assert.deepEqual(calls, ["stop", "park"]);
});

test("停止运行任务失败也继续停放持久化租约", async () => {
    const calls = [];
    const lifecycle = createApplicationLifecycle({
        port: 3100,
        webBuilt: true,
        state: {httpReady: true, infrastructureReady: true, shuttingDown: false},
        processGuard: {killExistingHttp() {}, registerPid: () => () => {}},
        store: {
            instanceId: "instance-1",
            setMailClaimPaused: async () => {},
            releaseInstanceWork: async () => ({gpt: 0, claude: 0, sms: 0, pw: 0, mail: 0, recharge: 0}),
            parkRebindWork: async () => { calls.push("park"); return {leases: 0}; },
        },
        scheduler: {pause() {}, pauseClaude() {}, killDomain() {}},
        mailJobs: {requestStop() {}, startPaused() {}, heartbeat: async () => {}, tick: async () => {}, hasBusyWork: () => false},
        recharge: {lifecycle: {stop: async () => { throw new Error("stop failed"); }}},
        daily: {runIfDue: async () => {}},
        browser: {refreshWindows: async () => {}, closeTrackedWindows: async () => {}},
        rss: {start: async () => () => {}},
        effects: {log() {}, warn: (message) => calls.push(String(message)), error() {}, rechargeLog() {}, broadcastRechargeJobs() {}},
        runtime: Object.assign(new EventEmitter(), {exit() {}}),
    });

    await lifecycle.parkWorkForShutdown("test");

    assert.equal(calls.some((value) => value.includes("停止充值任务失败")), true);
    assert.equal(calls.includes("park"), true);
});
