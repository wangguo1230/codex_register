import assert from "node:assert/strict";
import test from "node:test";
import {createGmailRebindQueueService} from "./gmail-rebind-queue-service.js";

function createHarness(overrides = {}) {
    const updates = [];
    const logs: string[] = [];
    let reconciles = 0;
    const service = createGmailRebindQueueService({
        concurrency: () => 3,
        execute: async () => new Promise(() => {}),
        store: {updateQueue: async (...args) => { updates.push(args); }},
        policy: {
            resolveTarget: (_item, options) => options.target || options.defaultTarget,
            normalizePool: (pool) => pool,
            targetLabel: (target) => target,
            formatUntil: () => "tomorrow",
        },
        poolGroup: "换绑池",
        defaultTarget: () => "gmail",
        extractEmails: () => [],
        effects: {
            log: (message) => logs.push(message),
            syncQueue: async () => {},
            reconcile: () => { reconciles++; },
        },
        now: () => 100,
        ...overrides,
    });
    return {service, updates, logs, reconciles: () => reconciles};
}

test("Gmail 未指定范围时只从换绑池排队并拒绝重复任务", async () => {
    const harness = createHarness();
    const item = {id: 1, email: "old@example.com", rebind_status: ""};
    assert.equal(await harness.service.enqueue(item), true);
    assert.equal(await harness.service.enqueue(item), false);
    assert.deepEqual(harness.updates[0][1].rebind_pool, {grp: "换绑池"});
    assert.equal("rebind_instance" in harness.updates[0][1], false);
    assert.match(harness.logs.at(-1), /已在进行/);
});

test("其他实例已认领时不覆盖执行租约", async () => {
    const harness = createHarness();

    assert.equal(await harness.service.enqueue({
        id: 4,
        email: "remote@example.com",
        rebind_status: "pending",
        rebind_instance: "server-b",
    }, {force: true}), false);
    assert.equal(harness.updates.length, 0);
    assert.match(harness.logs[0], /server-b/);
});

test("人工恢复期间不落盘新的换绑任务", async () => {
    const harness = createHarness({isRecoveryRunning: () => true});

    assert.equal(await harness.service.enqueue({id: 9, email: "recover@example.com"}), false);
    assert.equal(harness.updates.length, 0);
    assert.match(harness.logs[0], /人工恢复/);
});

test("RT 导出期间不落盘新的换绑任务", async () => {
    let writes = 0;
    const queue = createGmailRebindQueueService({
        concurrency: () => 2,
        execute: async () => {},
        store: {scheduleQueue: async () => { writes++; return true; }},
        policy: {
            resolveTarget: () => "gmail",
            normalizePool: () => ({grp: "换绑池"}),
            targetLabel: () => "Gmail",
            formatUntil: () => "later",
        },
        poolGroup: "换绑池",
        defaultTarget: () => "gmail",
        extractEmails: () => [],
        effects: {log() {}, syncQueue: async () => {}, reconcile() {}},
        isExportRunning: () => true,
    });

    assert.equal(await queue.enqueue({id: 1, email: "a@example.com", status: "done"}), false);
    assert.equal(writes, 0);
});

test("同一进程并发排队只执行一次落库", async () => {
    let releaseUpdate;
    let updates = 0;
    const gate = new Promise((resolve) => { releaseUpdate = resolve; });
    const harness = createHarness({
        store: {updateQueue: async () => { updates++; await gate; }},
    });
    const item = {id: 5, email: "same@example.com", rebind_status: ""};

    const first = harness.service.enqueue(item, {force: true});
    await new Promise((resolve) => setImmediate(resolve));
    const second = await harness.service.enqueue(item, {force: true});
    releaseUpdate();

    assert.equal(await first, true);
    assert.equal(second, false);
    assert.equal(updates, 1);
});

test("unknown 状态触发对账且冷却期不进入执行队列", async () => {
    const unknown = createHarness();
    assert.equal(await unknown.service.enqueue({id: 1, email: "a", rebind_status: "unknown"}), false);
    assert.equal(unknown.reconciles(), 1);

    const blocked = createHarness();
    assert.equal(await blocked.service.enqueue({id: 2, email: "b", rebind_blocked_until: 200}), false);
    assert.match(blocked.logs[0], /24h/);
});

test("换绑状态落库完成后才启动执行器", async () => {
    let persisted = false;
    let executedAfterPersist = false;
    const harness = createHarness({
        execute: async () => { executedAfterPersist = persisted; },
        store: {updateQueue: async (...args) => { harness.updates.push(args); persisted = true; }},
    });

    assert.equal(await harness.service.enqueue({id: 3, email: "c", rebind_status: ""}), true);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(executedAfterPersist, true);
});

test("换绑已持久化后视图刷新失败不反向报告排队失败", async () => {
    const harness = createHarness({
        effects: {
            log: (message) => harness.logs.push(message),
            syncQueue: async () => { throw new Error("broadcast failed"); },
            reconcile: () => {},
        },
    });

    assert.equal(await harness.service.enqueue({id: 8, email: "a@example.com", rebind_status: ""}), true);
    assert.ok(harness.logs.some((line) => line.includes("已入队，但刷新队列视图失败")));
});

test("Gmail 换绑并发高于旧上限时按配置执行", async () => {
    let active = 0;
    let maxActive = 0;
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const queue = createGmailRebindQueueService({
        concurrency: () => 7,
        execute: async () => {
            active++;
            maxActive = Math.max(maxActive, active);
            await gate;
            active--;
        },
        store: {scheduleQueue: async () => true},
        policy: {
            resolveTarget: () => "gmail",
            normalizePool: () => ({grp: "换绑池"}),
            targetLabel: () => "Gmail",
            formatUntil: () => "later",
        },
        poolGroup: "换绑池",
        defaultTarget: () => "gmail",
        extractEmails: () => [],
        effects: {log() {}, syncQueue: async () => {}, reconcile() {}},
    });

    await Promise.all(Array.from({length: 7}, (_, index) => queue.enqueue({id: index + 1, email: `a${index}@example.com`})));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(maxActive, 7);
    release();
    await queue.waitForIdle({timeoutMs: 1000});
});
