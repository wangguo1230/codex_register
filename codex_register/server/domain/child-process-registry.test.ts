import assert from "node:assert/strict";
import {EventEmitter} from "node:events";
import test from "node:test";
import {createChildProcessRegistry} from "./child-process-registry.js";

test("子进程注册表按作用域终止并在退出后释放", () => {
    const timers = new Map();
    let timerId = 0;
    const registry = createChildProcessRegistry({
        graceMs: 1_000,
        clock: {
            setTimeout: (fn) => { const id = ++timerId; timers.set(id, fn); return id; },
            clearTimeout: (id) => timers.delete(id),
        },
    });
    const child = Object.assign(new EventEmitter(), {
        signals: [] as string[],
        kill(signal) { this.signals.push(signal); },
    });

    assert.equal(registry.track(child), true);
    assert.equal(registry.track(child), false);
    assert.equal(registry.terminateAll(), 1);
    assert.deepEqual(child.signals, ["SIGTERM"]);
    child.emit("close");
    assert.equal(registry.size(), 0);
    assert.equal(timers.size, 0);
});

test("取消后才登记的子进程仍有强杀兜底", () => {
    const controller = new AbortController();
    controller.abort();
    const timers = new Map();
    let timerId = 0;
    const registry = createChildProcessRegistry({
        signal: controller.signal,
        graceMs: 1_000,
        clock: {
            setTimeout: (fn) => { const id = ++timerId; timers.set(id, fn); return id; },
            clearTimeout: (id) => timers.delete(id),
        },
    });
    const child = Object.assign(new EventEmitter(), {
        signals: [] as string[],
        kill(signal) { this.signals.push(signal); },
    });

    assert.equal(registry.track(child), true);
    assert.deepEqual(child.signals, ["SIGTERM"]);
    assert.equal(timers.size, 1);
    [...timers.values()][0]();
    assert.deepEqual(child.signals, ["SIGTERM", "SIGKILL"]);
    assert.equal(registry.size(), 0);
});
