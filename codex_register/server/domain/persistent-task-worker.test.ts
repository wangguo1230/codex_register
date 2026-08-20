import assert from "node:assert/strict";
import test from "node:test";
import {createPersistentTaskWorker} from "./persistent-task-worker.js";

test("持久化 worker 按并发上限执行并在完成后继续补位", async () => {
    const queued = [1, 2, 3];
    const completed = [];
    let active = 0;
    let peak = 0;
    const worker = createPersistentTaskWorker({
        kind: "test",
        instanceId: "node-a",
        concurrency: 2,
        pollMs: 10,
        claim: async (limit) => queued.splice(0, limit).map((id) => ({id, entity_id: id, lease_token: `t-${id}`})),
        heartbeat: async () => true,
        complete: async (task) => completed.push(task.id),
        fail: async () => {},
        release: async () => {},
        cancel: async () => {},
        execute: async (task) => {
            active++;
            peak = Math.max(peak, active);
            await new Promise((resolve) => setTimeout(resolve, 15));
            active--;
            return {id: task.id};
        },
    });
    worker.start();
    await new Promise((resolve) => setTimeout(resolve, 80));
    await worker.stop();
    assert.deepEqual(completed, [1, 2, 3]);
    assert.equal(peak, 2);
});

test("停止 worker 会中止活动任务并释放租约", async () => {
    let released = 0;
    let aborted = false;
    const worker = createPersistentTaskWorker({
        kind: "test",
        instanceId: "node-a",
        concurrency: 1,
        claim: async () => [{id: 1, entity_id: 1, lease_token: "t-1"}],
        heartbeat: async () => true,
        complete: async () => assert.fail("停止后的任务不应完成"),
        fail: async () => assert.fail("停止后的任务不应失败"),
        release: async () => { released++; },
        cancel: async () => {},
        execute: async (_task, {signal}) => new Promise((resolve) => {
            signal.addEventListener("abort", () => { aborted = true; resolve(); }, {once: true});
        }),
    });
    worker.start();
    await new Promise((resolve) => setImmediate(resolve));
    await worker.stop({timeoutMs: 1_000});
    assert.equal(aborted, true);
    assert.equal(released, 1);
});
