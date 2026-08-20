import assert from "node:assert/strict";
import test from "node:test";
import {createApplicationBootstrap} from "./application-bootstrap.js";

function createClock() {
    const timers = new Map<number, () => void>();
    let nextId = 0;
    return {
        timers,
        setTimeout(callback) {
            const id = ++nextId;
            timers.set(id, callback);
            return id;
        },
        clearTimeout(id) { timers.delete(id); },
        fire(id) {
            const callback = timers.get(id);
            timers.delete(id);
            callback?.();
        },
    };
}

test("初始化失败后保持 HTTP 存活状态并退避重试", async () => {
    const clock = createClock();
    const state: any = {httpReady: true, infrastructureReady: false, startupAttempt: 0};
    const calls: string[] = [];
    let attempt = 0;
    const bootstrap = createApplicationBootstrap({
        state,
        clock,
        retryDelayMs: 100,
        initialize: async ({reportPhase}) => {
            reportPhase("database-schema");
            attempt += 1;
            if (attempt === 1) throw new Error("schema timeout");
        },
        lifecycle: {
            markInfrastructureReady: () => {
                state.infrastructureReady = true;
                calls.push("ready");
            },
            markInfrastructureFailed: (error) => {
                state.infrastructureReady = false;
                state.startupError = error.message;
                calls.push("failed");
            },
        },
        logger: {error() {}},
    });

    assert.equal(await bootstrap.start(), false);
    assert.equal(state.httpReady, true);
    assert.equal(state.infrastructureReady, false);
    assert.equal(state.startupError, "schema timeout");
    assert.equal(clock.timers.size, 1);

    clock.fire([...clock.timers.keys()][0]);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(state.infrastructureReady, true);
    assert.equal(state.startupAttempt, 2);
    assert.deepEqual(calls, ["failed", "ready"]);
});

test("并发启动只执行一个初始化流程", async () => {
    const state: any = {};
    let release;
    let count = 0;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    const bootstrap = createApplicationBootstrap({
        state,
        initialize: async () => { count += 1; await pending; },
        lifecycle: {markInfrastructureReady() {}, markInfrastructureFailed() {}},
    });

    const first = bootstrap.start();
    const second = bootstrap.start();
    assert.equal(first, second);
    release();
    assert.equal(await first, true);
    assert.equal(count, 1);
});
