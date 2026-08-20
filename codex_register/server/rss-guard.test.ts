// @ts-nocheck
import assert from "node:assert/strict";
import test from "node:test";
import {createRssGuard} from "./rss-guard.js";

function createTimerHarness() {
    let callback = null;
    let cleared = false;
    const timer = {unref() {}};
    return {
        timer,
        setIntervalFn(fn) {
            callback = fn;
            return timer;
        },
        clearIntervalFn(value) {
            assert.equal(value, timer);
            cleared = true;
        },
        tick() {
            callback?.();
        },
        wasCleared() {
            return cleared;
        },
    };
}

test("RSS 正常时不阻断浏览器任务并可停止监控", () => {
    const harness = createTimerHarness();
    const guard = createRssGuard({
        readRss: () => 100,
        setIntervalFn: harness.setIntervalFn,
        clearIntervalFn: harness.clearIntervalFn,
    });

    const stop = guard.start();
    assert.equal(guard.isBlocked(), false);
    assert.equal(guard.start(), stop);
    stop();
    assert.equal(harness.wasCleared(), true);
});

test("RSS 超阈值只熔断新浏览器任务，恢复后解除熔断", () => {
    const harness = createTimerHarness();
    let rss = 2000;
    const warnings = [];
    const guard = createRssGuard({
        readRss: () => rss,
        warn: (message) => warnings.push(String(message)),
        setIntervalFn: harness.setIntervalFn,
        clearIntervalFn: harness.clearIntervalFn,
    });

    guard.start();
    assert.equal(guard.isBlocked(), true);
    assert.equal(warnings.length, 1);

    rss = 1000;
    harness.tick();
    assert.equal(guard.isBlocked(), false);
    assert.equal(warnings.length, 1);
});

test("RSS guard 不触发重启或任务停放回调", () => {
    const harness = createTimerHarness();
    let rss = 3500;
    let sideEffect = 0;
    const guard = createRssGuard({
        readRss: () => rss,
        warn: () => { sideEffect += 1; },
        setIntervalFn: harness.setIntervalFn,
        clearIntervalFn: harness.clearIntervalFn,
    });

    guard.start();
    assert.equal(guard.isBlocked(), true);
    assert.equal(sideEffect, 1);
    rss = 100;
    harness.tick();
    assert.equal(guard.isBlocked(), false);
    assert.equal(sideEffect, 1);
});
