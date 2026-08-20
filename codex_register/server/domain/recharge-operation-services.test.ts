import assert from "node:assert/strict";
import test from "node:test";
import {createRechargeBatchRuntime} from "./recharge-batch-runtime.js";
import {createRechargePollService} from "./recharge-poll-service.js";
import {createRechargeReloginService} from "./recharge-relogin-service.js";
import {createRechargeSubmitService} from "./recharge-submit-service.js";

async function waitUntil(predicate) {
    for (let index = 0; index < 20; index++) {
        if (predicate()) return;
        await new Promise((resolve) => setImmediate(resolve));
    }
    assert.fail("等待充值服务状态收敛超时");
}

test("提交认领异常时释放批次运行锁", async () => {
    const runtime = createRechargeBatchRuntime();
    const service = createRechargeSubmitService({
        instanceId: "i1",
        runtime,
        store: {claim: async () => { throw new Error("db unavailable"); }},
        cards: {},
        poll: {},
        runPool: async () => {},
        config: {},
        effects: {log() {}},
    });

    const result = await service.start([1]);

    assert.equal(result.status, 500);
    assert.equal(runtime.isRunning(), false);
});

test("充值 API 未配置时提交在认领前拒绝", async () => {
    const runtime = createRechargeBatchRuntime();
    let claimed = 0;
    const service = createRechargeSubmitService({
        instanceId: "i1",
        runtime,
        store: {claim: async () => { claimed++; return {claimed: [], skipped: []}; }},
        config: {isConfigured: () => false},
    });

    const result = await service.start([1]);

    assert.equal(result.status, 400);
    assert.match(result.error, /API 未配置/);
    assert.equal(claimed, 0);
    assert.equal(runtime.isRunning(), false);
});

test("人工恢复期间提交、重登和轮询均在读库前拒绝", async () => {
    const runtime = createRechargeBatchRuntime();
    let reads = 0;
    const submit = createRechargeSubmitService({
        runtime,
        store: {claim: async () => { reads++; return {claimed: [], skipped: []}; }},
        isRecoveryRunning: () => true,
    });
    const relogin = createRechargeReloginService({
        batchRuntime: runtime,
        store: {claim: async () => { reads++; return {claimed: [], skipped: []}; }},
        effects: {jobsChanged() {}},
        isRecoveryRunning: () => true,
    });
    const poll = createRechargePollService({
        store: {listPending: async () => { reads++; return []; }},
        runtime: {isStopped: () => false},
        effects: {log() {}, syncAll: async () => {}},
        hasApiKey: () => true,
        isRecoveryRunning: () => true,
    });

    assert.equal((await submit.start([1])).status, 409);
    assert.equal((await relogin.start([1])).status, 409);
    assert.equal((await relogin.startAndSubmit([1])).status, 409);
    assert.equal((await poll.refresh([1])).status, 409);
    assert.equal(reads, 0);
});

test("重登提交认领异常时同时清除重登态和批次锁", async () => {
    const runtime = createRechargeBatchRuntime();
    const service = createRechargeReloginService({
        instanceId: "i1",
        batchRuntime: runtime,
        store: {claim: async () => { throw new Error("claim failed"); }},
        effects: {jobsChanged() {}},
    });

    const result = await service.startAndSubmit([1]);

    assert.equal(result.status, 500);
    assert.equal(service.isRunning(), false);
    assert.equal(runtime.isRunning(), false);
});

test("普通重登与充值提交双向互斥", async () => {
    const runtime = createRechargeBatchRuntime();
    runtime.begin();
    let claimed = 0;
    const service = createRechargeReloginService({
        instanceId: "i1",
        batchRuntime: runtime,
        store: {claim: async () => { claimed++; return {claimed: [], skipped: []}; }},
        effects: {jobsChanged() {}},
    });

    const result = await service.start([1]);

    assert.equal(result.status, 400);
    assert.match(result.error, /充值提交/);
    assert.equal(claimed, 0);
});

test("普通重登不依赖充值 API 配置", async () => {
    const runtime = createRechargeBatchRuntime();
    let claimed = 0;
    const service = createRechargeReloginService({
        instanceId: "i1",
        batchRuntime: runtime,
        store: {
            claim: async () => {
                claimed++;
                return {claimed: [], skipped: [{reason: "没有可认领项目"}]};
            },
        },
        config: {isConfigured: () => false},
        effects: {jobsChanged() {}},
    });

    const result = await service.start([1]);

    assert.equal(result.status, 400);
    assert.equal(result.error, "没有可认领项目");
    assert.equal(claimed, 1);
});

test("普通重登读不到新 session 时不误报成功或覆盖队列", async () => {
    const runtime = createRechargeBatchRuntime();
    const logs = [];
    let updated = 0;
    let finished;
    const done = new Promise((resolve) => { finished = resolve; });
    const item = {id: 1, account_id: 9, email: "a@example.com"};
    const service = createRechargeReloginService({
        instanceId: "i1",
        batchRuntime: runtime,
        store: {
            claim: async () => ({claimed: [item], skipped: []}),
            getAccount: async () => ({id: 9, auth_file: "auth.json"}),
            updateQueueAuth: async () => { updated++; },
            releaseByInstance: async () => { finished(); },
        },
        relogin: async () => ({ok: true, authFile: "auth.json"}),
        credentials: {readAuth: () => ({}), extractSession: () => null},
        effects: {
            log: (line) => logs.push(line),
            jobsChanged() {},
            scheduleAll() {},
            syncQueue: async () => {},
        },
    });

    assert.equal((await service.start([1])).ok, true);
    await done;

    assert.equal(updated, 0);
    assert.equal(logs.some((line) => line.includes("登录后仍无 session")), true);
    assert.equal(logs.some((line) => line.includes("完成: 成功 0 / 失败 1")), true);
});

test("充值 API 未配置时重登提交在认领前拒绝", async () => {
    const runtime = createRechargeBatchRuntime();
    let claimed = 0;
    const service = createRechargeReloginService({
        instanceId: "i1",
        batchRuntime: runtime,
        store: {claim: async () => { claimed++; return {claimed: [], skipped: []}; }},
        config: {isConfigured: () => false},
        effects: {jobsChanged() {}},
    });

    const result = await service.startAndSubmit([1]);

    assert.equal(result.status, 400);
    assert.match(result.error, /API 未配置/);
    assert.equal(claimed, 0);
    assert.equal(service.isRunning(), false);
    assert.equal(runtime.isRunning(), false);
});

test("RT 导出与充值提交、重登双向互斥", async () => {
    const runtime = createRechargeBatchRuntime();
    let claims = 0;
    const submit = createRechargeSubmitService({
        instanceId: "i1",
        runtime,
        store: {claim: async () => { claims++; return {claimed: [], skipped: []}; }},
        isExportRunning: () => true,
    });
    const relogin = createRechargeReloginService({
        instanceId: "i1",
        batchRuntime: runtime,
        store: {claim: async () => { claims++; return {claimed: [], skipped: []}; }},
        effects: {jobsChanged() {}},
        isExportRunning: () => true,
    });

    assert.equal((await submit.start([1])).status, 409);
    assert.equal((await relogin.start([1])).status, 409);
    assert.equal((await relogin.startAndSubmit([1])).status, 409);
    assert.equal(claims, 0);
});

test("手工轮询过滤无卡密和已完成项目", async () => {
    const logs = [];
    const items = [
        {id: 1, email: "a@example.com", status: "pending", card_code: ""},
        {id: 2, email: "b@example.com", status: "done", card_code: "card"},
    ];
    const service = createRechargePollService({
        store: {
            get: async (id) => items.find((item) => item.id === id),
            listPending: async () => [],
        },
        reconcile: async () => 0,
        runtime: {isStopped: () => false},
        effects: {log: (line) => logs.push(line), syncAll: async () => {}},
        hasApiKey: () => true,
    });

    const result = await service.refresh([1, 2]);

    assert.equal(result.status, 400);
    assert.equal(result.skipped.length, 2);
    assert.match(logs[0], /刷新跳过/);
});

test("手工刷新已完成项目只同步视图，不重复查询平台", async () => {
    let synced = 0;
    let reconciled = 0;
    const service = createRechargePollService({
        store: {
            get: async () => ({id: 1, email: "done@example.com", status: "done", card_code: "card"}),
            listPending: async () => [],
        },
        reconcile: async () => { reconciled++; return 0; },
        runtime: {isStopped: () => false},
        effects: {log() {}, syncAll: async () => { synced++; }},
        hasApiKey: () => true,
    });

    const result = await service.refresh([1]);

    assert.equal(result.ok, true);
    assert.equal(result.updated, 0);
    assert.equal(reconciled, 0);
    assert.equal(synced, 1);
});

test("充值完成轮询合并并发触发", async () => {
    let pending = true;
    let reconciles = 0;
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const service = createRechargePollService({
        store: {listPending: async () => pending ? [{id: 1, card_code: "card"}] : []},
        reconcile: async () => {
            reconciles++;
            await gate;
            pending = false;
            return 1;
        },
        runtime: {isStopped: () => false},
        effects: {log() {}, syncAll: async () => {}},
        hasApiKey: () => true,
        sleep: async () => {},
    });

    const first = service.runLoop();
    await new Promise((resolve) => setImmediate(resolve));
    const second = service.runLoop();
    assert.equal(service.isLoopRunning(), true);
    release();
    await Promise.all([first, second]);

    assert.equal(reconciles, 1);
    assert.equal(service.isLoopRunning(), false);
});

test("轮询单批全部收敛后不再重复读取待处理列表", async () => {
    let listCalls = 0;
    const logs = [];
    const service = createRechargePollService({
        store: {
            listPending: async () => {
                listCalls++;
                return [{id: 1, card_code: "card"}];
            },
        },
        reconcile: async () => 1,
        runtime: {isStopped: () => false},
        effects: {log: (line) => logs.push(line), syncAll: async () => {}},
        hasApiKey: () => true,
    });

    await service.runLoop();

    assert.equal(listCalls, 1);
    assert.equal(logs.some((line) => line.includes("轮询超时")), false);
});

test("主动停止轮询不会误报超时", async () => {
    let listCalls = 0;
    const logs = [];
    const service = createRechargePollService({
        store: {listPending: async () => { listCalls++; return [{id: 1, card_code: "card"}]; }},
        reconcile: async () => 0,
        runtime: {isStopped: () => true},
        effects: {log: (line) => logs.push(line), syncAll: async () => {}},
        hasApiKey: () => true,
    });

    await service.runLoop();

    assert.equal(listCalls, 0);
    assert.equal(logs.some((line) => line.includes("轮询超时")), false);
    assert.equal(logs.some((line) => line.includes("轮询已停止")), true);
});

test("充值 API 配置不完整时手工和前台轮询都不查询平台", async () => {
    let listed = 0;
    let reconciled = 0;
    const logs = [];
    const service = createRechargePollService({
        store: {listPending: async () => { listed++; return []; }},
        reconcile: async () => { reconciled++; return 0; },
        runtime: {isStopped: () => false},
        effects: {log: (line) => logs.push(line), syncAll: async () => {}},
        hasApiKey: () => false,
    });

    assert.equal((await service.refresh([])).status, 400);
    await service.runLoop();

    assert.equal(listed, 0);
    assert.equal(reconciled, 0);
    assert.equal(logs.some((line) => line.includes("API 配置不完整")), true);
});

test("原子配卡失败时立即归还已认领卡密", async () => {
    const runtime = createRechargeBatchRuntime();
    const released = [];
    let finish;
    const finished = new Promise((resolve) => { finish = resolve; });
    const item = {id: 1, account_id: 9, email: "a@example.com", status: "pending"};
    const service = createRechargeSubmitService({
        instanceId: "i1",
        runtime,
        store: {
            claim: async () => ({claimed: [item], skipped: []}),
            release: async () => {},
            releaseByInstance: async () => {},
            get: async () => item,
            unusedCardCount: async () => 1,
            assignCard: async () => { throw new Error("transaction failed"); },
        },
        cards: {
            takeReusable: async () => ({card: {id: 3, code: "card-code"}}),
            failureReason: () => "no card",
            release: async (ids) => { released.push(...ids); },
        },
        precheck: async () => ({ok: true}),
        submitOne: async () => ({ok: true}),
        poll: {runLoop: async () => {}},
        runPool: async (items, worker) => { for (const value of items) await worker(value); },
        config: {intervalSeconds: () => 0, concurrency: () => 1, baseUrl: () => "test"},
        effects: {log() {}, syncQueue: async () => { finish(); }, syncAll: async () => {}},
    });

    const result = await service.start([1]);
    await finished;
    await waitUntil(() => !runtime.isRunning());

    assert.equal(result.ok, true);
    assert.deepEqual(released, [3]);
    assert.equal(runtime.isRunning(), false);
});

test("配卡完成后批次停止会原子撤销 paired", async () => {
    const runtime = createRechargeBatchRuntime();
    const cancelled = [];
    let finished;
    const done = new Promise((resolve) => { finished = resolve; });
    const item = {id: 1, account_id: 9, email: "a@example.com", status: "pending"};
    const service = createRechargeSubmitService({
        instanceId: "i1",
        runtime,
        store: {
            claim: async () => ({claimed: [item], skipped: []}),
            release: async () => {},
            releaseByInstance: async () => {},
            get: async () => item,
            unusedCardCount: async () => 1,
            assignCard: async () => {
                runtime.requestStop();
                return {queueItem: {...item, status: "paired", card_id: 3}, card: {id: 3, code: "card-code"}};
            },
            cancelPair: async (...args) => { cancelled.push(args); },
        },
        cards: {
            takeReusable: async () => ({card: {id: 3, code: "card-code"}}),
            failureReason: () => "no card",
            release: async () => {},
        },
        precheck: async () => ({ok: true}),
        submitOne: async () => { throw new Error("不应提交"); },
        poll: {runLoop: async () => {}},
        runPool: async (items, worker) => { for (const value of items) await worker(value); },
        config: {intervalSeconds: () => 0, concurrency: () => 1, baseUrl: () => "test"},
        effects: {log() {}, syncQueue: async () => { finished(); }, syncAll: async () => {}},
    });

    await service.start([1]);
    await done;

    assert.deepEqual(cancelled, [[1, 3, "i1"]]);
});

test("强制解锁后的旧提交批次不会被新批次恢复", async () => {
    const runtime = createRechargeBatchRuntime();
    const submitted = [];
    const released = [];
    let releaseFirstPrecheck;
    let firstPrecheckStarted;
    const firstStarted = new Promise((resolve) => { firstPrecheckStarted = resolve; });
    const firstGate = new Promise((resolve) => { releaseFirstPrecheck = resolve; });
    let finishAll;
    const allFinished = new Promise((resolve) => { finishAll = resolve; });
    const items = new Map([
        [1, {id: 1, account_id: 11, email: "old@example.com", status: "pending"}],
        [2, {id: 2, account_id: 12, email: "new@example.com", status: "pending"}],
    ]);
    const service = createRechargeSubmitService({
        instanceId: "i1",
        runtime,
        store: {
            claim: async (ids) => ({claimed: ids.map((id) => items.get(id)), skipped: []}),
            release: async () => {},
            releaseByInstance: async (_instanceId, ids) => {
                released.push(...ids);
                if (released.length === 2) finishAll();
            },
            get: async (id) => items.get(id),
            unusedCardCount: async () => 2,
            updateQueue: async () => {},
            assignCard: async (queueId, cardId) => ({queueItem: items.get(queueId), card: {id: cardId, code: `card-${cardId}`}}),
        },
        cards: {
            takeReusable: async (email) => ({card: {id: email === "old@example.com" ? 21 : 22, code: "card-code"}}),
            failureReason: () => "no card",
            release: async () => {},
        },
        precheck: async (item) => {
            if (item.id === 1) {
                firstPrecheckStarted();
                await firstGate;
            }
            return {ok: true};
        },
        submitOne: async (item) => { submitted.push(item.id); return {ok: true}; },
        poll: {runLoop: async () => {}},
        runPool: async (values, worker) => { for (const value of values) await worker(value); },
        config: {intervalSeconds: () => 0, concurrency: () => 1, baseUrl: () => "test"},
        effects: {log() {}, syncQueue: async () => {}, syncAll: async () => {}},
    });

    assert.equal((await service.start([1])).ok, true);
    await firstStarted;
    service.stop({force: true});
    assert.equal((await service.start([2])).ok, true);
    releaseFirstPrecheck();
    await allFinished;

    assert.deepEqual(submitted, [2]);
});

test("重登提交原子配卡失败时立即归还新认领卡密", async () => {
    const runtime = createRechargeBatchRuntime();
    const released = [];
    let finished;
    const done = new Promise((resolve) => { finished = resolve; });
    const item = {id: 1, account_id: 9, email: "a@example.com", status: "pending", card_id: 0};
    const service = createRechargeReloginService({
        instanceId: "i1",
        batchRuntime: runtime,
        store: {
            claim: async () => ({claimed: [item], skipped: []}),
            getQueue: async () => item,
            getAccount: async () => ({id: 9, email: item.email}),
            updateQueueAuth: async () => {},
            assignCard: async () => { throw new Error("transaction failed"); },
            releaseByInstance: async () => { finished(); },
        },
        relogin: async () => ({ok: true, authFile: "auth.json"}),
        credentials: {readAuth: () => ({session: {accessToken: "at"}}), extractSession: () => ({accessToken: "at"})},
        cards: {
            takeReusable: async () => ({card: {id: 3, code: "card-code"}}),
            failureReason: () => "no card",
            release: async (ids) => { released.push(...ids); },
        },
        policy: {isAccountDeadReason: () => false},
        config: {intervalSeconds: () => 0},
        effects: {log() {}, jobsChanged() {}, syncQueue: async () => {}, syncAll: async () => {}},
        poll: {runLoop: async () => {}},
    });

    assert.equal((await service.startAndSubmit([1])).ok, true);
    await done;
    await waitUntil(() => !service.isRunning() && !runtime.isRunning());
    assert.deepEqual(released, [3]);
    assert.equal(runtime.isRunning(), false);
});

test("充值提交批量释放非 pending 租约且提交前只复核一次队列", async () => {
    const runtime = createRechargeBatchRuntime();
    const pending = {id: 1, account_id: 9, email: "a@example.com", status: "pending"};
    const paired = [
        {id: 2, account_id: 10, email: "b@example.com", status: "paired"},
        {id: 3, account_id: 11, email: "c@example.com", status: "paired"},
    ];
    const releaseCalls = [];
    let getCalls = 0;
    let accountBatchCalls = 0;
    let precheckAccount = null;
    let validationSnapshot = null;
    let submitAccount = null;
    let finish;
    const done = new Promise((resolve) => { finish = resolve; });
    const service = createRechargeSubmitService({
        instanceId: "i1",
        runtime,
        store: {
            claim: async () => ({claimed: [pending, ...paired], skipped: []}),
            release: async (ids) => { releaseCalls.push(ids); },
            releaseByInstance: async () => {},
            get: async () => { getCalls++; return pending; },
            getAccounts: async (ids) => {
                accountBatchCalls++;
                assert.deepEqual(ids, [9]);
                return [{id: 9, email: pending.email}];
            },
            unusedCardCount: async () => 1,
            assignCard: async () => ({queueItem: pending, card: {id: 4, code: "card-code"}}),
        },
        cards: {
            takeReusable: async () => ({card: {id: 4, code: "card-code"}, val: {status: "unused"}}),
            failureReason: () => "no card",
            release: async () => {},
        },
        precheck: async (_item, account) => { precheckAccount = account; return {ok: true}; },
        submitOne: async (_item, _card, _label, options) => {
            validationSnapshot = options.validation;
            submitAccount = options.account;
            return {ok: true};
        },
        poll: {runLoop: async () => {}},
        runPool: async (items, worker) => { for (const item of items) await worker(item); },
        config: {intervalSeconds: () => 0, concurrency: () => 1, baseUrl: () => "test"},
        effects: {log() {}, syncQueue: async () => { finish(); }, syncAll: async () => {}},
    });

    assert.equal((await service.start([1, 2, 3])).ok, true);
    await done;

    assert.deepEqual(releaseCalls, [[2, 3]]);
    assert.equal(getCalls, 1);
    assert.equal(accountBatchCalls, 1);
    assert.equal(precheckAccount?.id, 9);
    assert.equal(submitAccount, precheckAccount);
    assert.deepEqual(validationSnapshot, {status: "unused"});
});

test("充值提交释放数据库租约前保持运行锁", async () => {
    const runtime = createRechargeBatchRuntime();
    let releaseLease;
    const leaseGate = new Promise((resolve) => { releaseLease = resolve; });
    let releaseStarted;
    const releasing = new Promise((resolve) => { releaseStarted = resolve; });
    const item = {id: 1, account_id: 9, email: "a@example.com", status: "pending"};
    const service = createRechargeSubmitService({
        instanceId: "i1",
        runtime,
        store: {
            claim: async () => ({claimed: [item], skipped: []}),
            release: async () => {},
            releaseByInstance: async () => { releaseStarted(); await leaseGate; },
            get: async () => item,
            unusedCardCount: async () => 1,
            assignCard: async () => ({queueItem: item, card: {id: 4, code: "card-code"}}),
        },
        cards: {
            takeReusable: async () => ({card: {id: 4, code: "card-code"}}),
            failureReason: () => "no card",
            release: async () => {},
        },
        precheck: async () => ({ok: true}),
        submitOne: async () => ({ok: true}),
        poll: {runLoop: async () => {}},
        runPool: async (items, worker) => { for (const value of items) await worker(value); },
        config: {intervalSeconds: () => 0, concurrency: () => 1, baseUrl: () => "test"},
        effects: {log() {}, syncQueue: async () => {}, syncAll: async () => {}},
    });

    assert.equal((await service.start([1])).ok, true);
    await releasing;
    assert.equal(runtime.isRunning(), true);
    releaseLease();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(runtime.isRunning(), false);
});
