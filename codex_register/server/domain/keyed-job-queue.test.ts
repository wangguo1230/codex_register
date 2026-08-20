import assert from "node:assert/strict";
import test from "node:test";
import {createKeyedJobQueue} from "./keyed-job-queue.js";

test("取消活动任务会中止该任务的 AbortSignal，不影响其他任务", async () => {
    const started: Array<{id: number; signal: AbortSignal}> = [];
    const queue = createKeyedJobQueue({
        concurrency: 2,
        execute: async (id, _metadata, context) => {
            started.push({id, signal: context.signal});
            await new Promise((resolve) => context.signal.addEventListener("abort", resolve, {once: true}));
        },
    });

    assert.equal(queue.enqueue(1, {}), true);
    assert.equal(queue.enqueue(2, {}), true);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(queue.cancel(1).active, true);
    assert.equal(started.find((item) => item.id === 1)?.signal.aborted, true);
    assert.equal(started.find((item) => item.id === 2)?.signal.aborted, false);
    queue.cancel(2);
});

test("批量取消会移除等待项并中止全部活动信号", async () => {
    const started: Array<{id: number; signal: AbortSignal}> = [];
    const queue = createKeyedJobQueue({
        concurrency: 2,
        execute: async (id, _metadata, context) => {
            started.push({id, signal: context.signal});
            await new Promise((resolve) => context.signal.addEventListener("abort", resolve, {once: true}));
        },
    });
    queue.enqueue(1, {});
    queue.enqueue(2, {});
    queue.enqueue(3, {});
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(queue.size(), 3);

    assert.deepEqual(queue.cancelAll(), {count: 3, active: 2});
    assert.equal(started.every((item) => item.signal.aborted), true);
    assert.equal(queue.has(3), false);
    assert.equal(queue.size(), 2);
    assert.equal(await queue.waitForIdle({timeoutMs: 1_000}), true);
});
