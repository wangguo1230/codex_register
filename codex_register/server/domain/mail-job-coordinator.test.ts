import assert from "node:assert/strict";
import test from "node:test";
import {createMailJobCoordinator} from "./mail-job-coordinator.js";

function emptyProgress(overrides = {}) {
    return {
        running: false,
        kind: "mail",
        done: 0,
        total: 0,
        ok: 0,
        fail: 0,
        queued: 0,
        runningCount: 0,
        rate: 0,
        current: [],
        lastLine: "",
        byKind: {},
        paused: false,
        ...overrides,
    };
}

function createHarness(options = {}) {
    let paused = options.paused ?? false;
    let stopFlag = options.stopFlag ?? false;
    let bitLoggedOut = options.bitLoggedOut ?? false;
    const calls = {
        paused: [],
        canceled: [],
        claims: [],
        enqueued: [],
        executed: [],
        broadcasts: [],
        stoppedWindows: 0,
        aborts: 0,
        staleReclaims: 0,
        interruptedRecoveries: 0,
        heartbeats: [],
        timeoutChecks: 0,
    };
    const mailboxes = new Map((options.mailboxes || []).map((mailbox) => [mailbox.id, mailbox]));
    const progress = options.progress || emptyProgress();
    const instances = options.instances || [];
    const timedOut = options.timedOut || [];
    const resumable = options.resumable || [];
    const newestErrors = options.newestErrors || [];
    const gaps = options.gaps || [];
    const claimed = options.claimed || [];
    const store = {
        setClaimPaused: async (value) => {
            paused = value;
            calls.paused.push(value);
        },
        cancelPending: async (kind) => {
            calls.canceled.push(kind);
            return 2;
        },
        progress: async () => ({...progress, paused}),
        isClaimPaused: async () => paused,
        upsertInstance: async () => {},
        listInstances: async () => instances,
        requeueRunning: async () => 1,
        requeueRecentBitFailures: async () => [],
        reclaimStale: async () => { calls.staleReclaims++; return 0; },
        recoverInterrupted: async () => {
            calls.interruptedRecoveries++;
            return options.recovered || 0;
        },
        heartbeat: async (...args) => { calls.heartbeats.push(args); },
        failTimedOut: async () => { calls.timeoutChecks++; return timedOut; },
        claim: async (...args) => {
            calls.claims.push(args);
            return claimed;
        },
        getMailbox: async (id) => mailboxes.get(id) || null,
        enqueue: async (items, kind) => {
            calls.enqueued.push({items, kind});
            return {inserted: items.length, batchId: "batch-1"};
        },
        cancelUsablePending: async () => 0,
        listNewestErrors: async () => newestErrors,
        listResumable: async () => resumable,
        listHardenGaps: async () => gaps,
    };
    const scheduler = {
        pwConcurrency: options.concurrency || 2,
        mailProxyPoolSnap: () => ({slots: options.proxySlots || 2, total: options.proxySlots || 2, leased: 0}),
        collectJumpLines: () => options.jumpLines || [],
    };
    const jumpPool = {
        urls: options.jumpUrls || [],
        health: new Map(options.jumpHealth || []),
        checkOne: async () => ({ok: false, at: Date.now()}),
    };
    const bitRuntime = {
        ensureWindowBudget: async () => 0,
        isLoggedOut: () => bitLoggedOut,
        listAllWindows: async () => [],
        listAutomationWindows: async () => options.windows || [],
        markLoggedOut: (value) => { bitLoggedOut = value; },
        setExpectedTiles: () => {},
        stopAutomationWindows: async () => {
            calls.stoppedWindows++;
            return 1;
        },
    };
    const stopRuntime = {
        clear: () => { stopFlag = false; },
        isStopped: () => stopFlag,
        isCritical: () => false,
        request: () => { stopFlag = true; },
    };
    const coordinator = createMailJobCoordinator({
        store,
        scheduler,
        jumpPool,
        maxExitsPerJump: 2,
        executeJob: (job) => { calls.executed.push(job); },
        effects: {
            broadcast: (...args) => { calls.broadcasts.push(args); },
            log: () => {},
            warn: () => {},
        },
        instanceId: "instance-1",
        isHttpReady: () => options.httpReady ?? false,
        isShuttingDown: () => false,
        bitRuntime,
        stopRuntime,
        now: () => 100_000,
    });
    return {
        coordinator,
        calls,
        isPaused: () => paused,
        isStopFlagSet: () => stopFlag,
        addAbortController(mailboxId) {
            coordinator.runtime.abortControllers.set(mailboxId, {
                abort: () => { calls.aborts++; },
            });
        },
    };
}

test("begin 清除本机停止旗标并恢复共池认领", async () => {
    const h = createHarness({paused: true, stopFlag: true});

    await h.coordinator.begin();

    assert.equal(h.isPaused(), false);
    assert.equal(h.isStopFlagSet(), false);
    assert.deepEqual(h.calls.paused, [false]);
});

test("startPaused 仅暂停本实例且 tick 不维护或认领历史任务", async () => {
    const h = createHarness({httpReady: true});

    h.coordinator.startPaused();
    await h.coordinator.tick();

    assert.equal(h.coordinator.isStopped(), true);
    assert.deepEqual(h.calls.paused, []);
    assert.equal(h.calls.staleReclaims, 0);
    assert.equal(h.calls.timeoutChecks, 0);
    assert.equal(h.calls.claims.length, 0);
});

test("邮箱心跳只续租本进程实际持有的邮箱任务", async () => {
    const h = createHarness();
    h.coordinator.runtime.localMailboxIds.add(7);

    await h.coordinator.heartbeat();

    assert.deepEqual(h.calls.heartbeats, [["instance-1", [7]]]);
});

test("stopAll 暂停认领、取消排队并中止本机任务", async () => {
    const h = createHarness();
    h.addAbortController(7);

    const result = await h.coordinator.stopAll();
    await Promise.resolve();

    assert.equal(result.canceled, 2);
    assert.equal(h.isPaused(), true);
    assert.equal(h.isStopFlagSet(), true);
    assert.equal(h.calls.aborts, 1);
    assert.deepEqual(h.calls.canceled, [""]);
    assert.equal(h.calls.stoppedWindows, 1);
});

test("配置了跳板但没有可用端口时不认领整备任务", async () => {
    const h = createHarness({httpReady: true, jumpLines: ["vless://jump"], jumpUrls: []});

    await h.coordinator.tick();

    assert.equal(h.calls.claims.length, 0);
});

test("BitBrowser 不可用时只从共池认领改密任务", async () => {
    const h = createHarness({httpReady: true, bitLoggedOut: true});

    await h.coordinator.tick();

    assert.equal(h.calls.claims.length, 1);
    assert.equal(h.calls.claims[0][2], "pw");
});

test("超时任务属于本实例时中止对应执行控制器", async () => {
    const h = createHarness({
        httpReady: true,
        paused: true,
        timedOut: [{instance_id: "instance-1", mailbox_id: 9}],
    });
    h.addAbortController(9);

    await h.coordinator.tick();

    assert.equal(h.calls.aborts, 1);
});

test("startHarden 只将有效且未删除的 Gmail 入队", async () => {
    const h = createHarness({mailboxes: [
        {id: 1, email: "ready@gmail.com", provider: "google", deleted_at: 0},
        {id: 2, email: "mail@example.com", provider: "mailcom", deleted_at: 0},
        {id: 3, email: "deleted@gmail.com", provider: "google", deleted_at: 1},
    ]});

    const result = await h.coordinator.startHarden([1, 2, 3]);

    assert.equal(result.count, 1);
    assert.equal(result.skipped, 0);
    assert.equal(h.calls.enqueued.length, 1);
    assert.deepEqual(h.calls.enqueued[0], {
        kind: "harden",
        items: [{id: 1, email: "ready@gmail.com"}],
    });
});

test("resume 跳过已经具备新 2FA 和 IMAP 的 Gmail", async () => {
    const mailbox = {
        id: 1,
        email: "ready@gmail.com",
        provider: "google",
        deleted_at: 0,
        imap_password: "app-password",
        google_state: {totp_rotated: true},
    };
    const h = createHarness({
        mailboxes: [mailbox],
        resumable: [{id: 1, kind: "harden"}],
    });

    const result = await h.coordinator.resume();

    assert.equal(result.count, 0);
    assert.equal(result.skippedDone, 1);
    assert.equal(h.calls.enqueued.length, 0);
});

test("resume 人工回收失联 running 后直接继续认领", async () => {
    const h = createHarness({recovered: 2});

    const result = await h.coordinator.resume();

    assert.equal(result.count, 2);
    assert.equal(result.recovered, 2);
    assert.equal(h.calls.interruptedRecoveries, 1);
    assert.equal(h.calls.enqueued.length, 0);
});

test("snapshot 保持原邮箱任务状态 API 字段", async () => {
    const h = createHarness({
        progress: emptyProgress({
            running: true,
            done: 3,
            total: 5,
            queued: 1,
            runningCount: 1,
            byKind: {harden: {pending: 1}},
        }),
        instances: [{instanceId: "instance-1"}],
    });

    await h.coordinator.refreshState();
    const snapshot = h.coordinator.snapshot();

    assert.equal(snapshot.running, true);
    assert.equal(snapshot.done, 3);
    assert.equal(snapshot.source, "queue");
    assert.equal(snapshot.instanceId, "instance-1");
    assert.deepEqual(snapshot.instances, [{instanceId: "instance-1"}]);
    assert.ok(Array.isArray(snapshot.windows));
    assert.deepEqual(h.coordinator.stateExtras().mailJob, snapshot);
});
