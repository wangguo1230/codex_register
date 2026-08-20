import assert from "node:assert/strict";
import {EventEmitter} from "node:events";
import test from "node:test";
import {createRechargeExportService} from "./recharge-export-service.js";

function deferred() {
    let resolve;
    let reject;
    const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
    return {promise, resolve, reject};
}

function createHarness(overrides = {}) {
    const rows = overrides.rows || [];
    const logs = [];
    const ready = [];
    let queueSyncs = 0;
    const service = createRechargeExportService({
        store: {
            listFull: async () => rows,
            getQueue: async (id) => rows.find((row) => row.id === id),
            listQueue: async () => ({list: rows}),
            getAccount: async (id) => ({id, auth_data: rows.find((row) => row.account_id === id)?.account_auth}),
            updateQueue: async () => {},
            ...overrides.store,
        },
        credentials: {
            readJson: () => null,
            readAuth: (account) => account?.auth_data,
            readRt: (account) => account?.rt_data,
            extractTokens: (data) => data ? {
                accessToken: data.access_token || "",
                refreshToken: data.refresh_token || "",
                accountId: data.account_id || "",
            } : null,
            extractSession: (data) => data?.session || null,
            ...overrides.credentials,
        },
        formatLine: (row, options) => `${row.email}|${options?.rt || ""}`,
        rtAcquire: overrides.rtAcquire || (async () => ({ok: 0, fail: 0, total: 0})),
        distributedRt: overrides.distributedRt,
        sub2json: overrides.sub2json || {exportAccounts: async () => ({accounts: [], ok: 0, fail: 0, total: 0})},
        plans: overrides.plans || {buildDispatcher: () => null, probe: async () => ({ok: false})},
        config: {rtConcurrency: () => 4, regProxy: () => "", ...overrides.config},
        effects: {
            log: (line) => logs.push(line),
            jobsChanged() {},
            ready: (payload) => ready.push(payload),
            syncQueue: async () => { queueSyncs++; },
            ...overrides.effects,
        },
        isRechargeOperationRunning: overrides.isRechargeOperationRunning,
        isRecoveryRunning: overrides.isRecoveryRunning,
        isRebindRunning: overrides.isRebindRunning,
        now: () => new Date("2026-08-20T00:00:00.000Z"),
    });
    return {service, logs, ready, queueSyncs: () => queueSyncs};
}

async function waitUntil(predicate) {
    for (let index = 0; index < 20; index++) {
        if (predicate()) return;
        await new Promise((resolve) => setImmediate(resolve));
    }
    assert.fail("等待异步导出状态超时");
}

test("账号、卡密、session 与 sub2json 预备格式保持原契约", async () => {
    const rows = [{
        id: 1,
        email: "a@example.com",
        card_code: "card-1",
        refresh_token: "rt-1",
        gpt_auth_data: {session: {accessToken: "at-1"}},
        gpt_password: "gpt-pw",
    }];
    const {service} = createHarness({rows});

    assert.equal((await service.exportQueue({ids: [1], format: "account"})).text, "a@example.com|");
    assert.equal((await service.exportQueue({ids: [1], format: "card"})).text, "card-1");
    assert.equal((await service.exportQueue({ids: [1], format: "session"})).text, '{"accessToken":"at-1"}');
    assert.deepEqual(await service.exportQueue({ids: [1], format: "sub2json"}), {
        ok: true,
        text: "a@example.com----gpt-pw----rt-1",
        total: 1,
        withRt: 1,
        missingRt: 0,
    });
});

test("已有 RT 时含 RT 导出同步返回完整文本", async () => {
    const {service} = createHarness({rows: [
        {id: 1, email: "a@example.com", refresh_token: "rt-a"},
        {id: 2, email: "b@example.com", refresh_token: "rt-b"},
    ]});

    const result = await service.exportQueue({ids: [1, 2], format: "rt"});

    assert.equal(result.text, "a@example.com|rt-a\nb@example.com|rt-b");
    assert.equal(service.isRunning(), false);
});

test("充值导出缺少 RT 时通过持久化队列执行并从数据库生成结果", async () => {
    const rows = [{id: 1, account_id: 11, email: "a@example.com"}];
    let enqueued = 0;
    let awakened = 0;
    const {service, ready} = createHarness({
        rows,
        distributedRt: {
            enqueue: async (ids) => {
                enqueued += ids.length;
                rows[0].refresh_token = "rt-distributed";
                return [{id: 99, entity_id: 11, status: "pending"}];
            },
            list: async () => [{entity_id: 11, status: "success"}],
            wake: () => { awakened++; },
        },
        rtAcquire: async () => { throw new Error("不应回退本机执行"); },
    });

    const result = await service.exportQueue({ids: [1], format: "rt"});
    assert.equal(result.async, true);
    await waitUntil(() => ready.some((payload) => payload.text));
    assert.equal(enqueued, 1);
    assert.equal(awakened, 1);
    assert.equal(ready.at(-1).text, "a@example.com|rt-distributed");
});

test("导出运行中只同步返回已有 RT 的账号", async () => {
    const gate = deferred();
    const rows = [
        {id: 1, email: "ready@example.com", refresh_token: "rt-ready"},
        {id: 2, email: "pending@example.com"},
    ];
    const {service} = createHarness({rows, rtAcquire: () => gate.promise});

    await service.exportQueue({ids: [1, 2], format: "rt"});
    const second = await service.exportQueue({ids: [1, 2], format: "rt"});

    assert.equal(second.text, "ready@example.com|rt-ready");
    gate.resolve({ok: 1, fail: 0, total: 1});
    await waitUntil(() => !service.isRunning());
});

test("主 RT 导出期间最多运行一个局部 sub2json 作业", async () => {
    const rtGate = deferred();
    const partialGate = deferred();
    let partialCalls = 0;
    const rows = [
        {id: 1, email: "ready@example.com", refresh_token: "rt-ready"},
        {id: 2, email: "pending@example.com"},
    ];
    const {service} = createHarness({
        rows,
        rtAcquire: () => rtGate.promise,
        sub2json: {
            exportAccounts: async () => {
                partialCalls++;
                await partialGate.promise;
                return {accounts: [], ok: 1, fail: 0, total: 1};
            },
        },
    });

    await service.exportQueue({ids: [1, 2], format: "rt"});
    assert.equal((await service.exportSub2json([1, 2])).partial, true);
    assert.equal((await service.exportSub2json([1, 2])).status, 409);
    assert.equal(partialCalls, 1);

    partialGate.resolve();
    rtGate.resolve({ok: 1, fail: 0, total: 1});
    await waitUntil(() => !service.isRunning());
});

test("主导出结束后局部 sub2json 仍保持 RT 互斥", async () => {
    const rtGate = deferred();
    const partialGate = deferred();
    const rows = [
        {id: 1, email: "ready@example.com", refresh_token: "rt-ready"},
        {id: 2, email: "pending@example.com"},
    ];
    const {service, ready} = createHarness({
        rows,
        rtAcquire: () => rtGate.promise,
        sub2json: {
            exportAccounts: async () => {
                await partialGate.promise;
                return {accounts: [], ok: 1, fail: 0, total: 1};
            },
        },
    });

    await service.exportQueue({ids: [1, 2], format: "rt"});
    assert.equal((await service.exportSub2json([1, 2])).partial, true);

    rtGate.resolve({ok: 1, fail: 0, total: 1});
    await waitUntil(() => ready.some((payload) => payload.text && !payload.format));
    assert.equal(service.isRunning(), true);
    assert.equal((await service.exportSub2json([1, 2])).status, 409);

    partialGate.resolve();
    await waitUntil(() => !service.isRunning());
});

test("停止导出会终止已挂接子进程", async () => {
    const gate = deferred();
    const child = new EventEmitter();
    const signals = [];
    child.kill = (signal) => { signals.push(signal); return true; };
    const {service} = createHarness({
        rows: [{id: 1, email: "a@example.com"}],
        rtAcquire: () => gate.promise,
    });

    await service.exportQueue({ids: [1], format: "rt"});
    service.attachChild(child);
    assert.deepEqual(service.stop(), {ok: true, running: true, killed: 1});
    assert.deepEqual(signals, ["SIGTERM"]);
    gate.resolve({ok: 0, fail: 1, total: 1});
    await waitUntil(() => !service.isRunning());
});

test("RT 获取异常后释放运行锁", async () => {
    const {service} = createHarness({
        rows: [{id: 1, email: "a@example.com"}],
        rtAcquire: async () => { throw new Error("worker failed"); },
    });

    await service.exportQueue({ids: [1], format: "rt"});
    await waitUntil(() => !service.isRunning());

    assert.equal(service.isRunning(), false);
});

test("充值提交或重登期间拒绝启动 RT 导出", async () => {
    let listCalls = 0;
    const {service} = createHarness({
        rows: [{id: 1, email: "a@example.com"}],
        store: {listFull: async () => { listCalls++; return []; }},
        isRechargeOperationRunning: () => true,
    });

    const result = await service.exportQueue({ids: [1], format: "rt"});

    assert.equal(result.status, 409);
    assert.equal(service.isRunning(), false);
    assert.equal(listCalls, 0);
});

test("人工恢复期间拒绝启动 RT 和 sub2json 导出", async () => {
    let listCalls = 0;
    const {service} = createHarness({
        store: {listFull: async () => { listCalls++; return []; }},
        isRecoveryRunning: () => true,
    });

    assert.equal((await service.exportQueue({ids: [1], format: "rt"})).status, 409);
    assert.equal((await service.exportSub2json([1])).status, 409);
    assert.equal(listCalls, 0);
});

test("换绑期间拒绝启动 RT 和 sub2json 导出", async () => {
    let listCalls = 0;
    const {service} = createHarness({
        store: {listFull: async () => { listCalls++; return []; }},
        isRebindRunning: () => true,
    });

    assert.equal((await service.exportQueue({ids: [1], format: "rt"})).status, 409);
    assert.equal((await service.exportSub2json([1])).status, 409);
    assert.equal(listCalls, 0);
});

test("RT 导出在首次异步读库前预占运行锁", async () => {
    const gate = deferred();
    const {service} = createHarness({
        store: {listFull: () => gate.promise},
    });

    const exporting = service.exportQueue({ids: [1], format: "rt"});
    assert.equal(service.isRunning(), true);
    gate.resolve([{id: 1, email: "a@example.com", refresh_token: "rt"}]);
    assert.equal((await exporting).text, "a@example.com|rt");
    assert.equal(service.isRunning(), false);
});

test("套餐查询遇到无 AT 账号时继续处理后续账号", async () => {
    const synced = deferred();
    const updated = [];
    const rows = [
        {id: 1, account_id: 11, email: "missing@example.com"},
        {id: 2, account_id: 12, email: "ready@example.com", account_auth: {access_token: "at", account_id: "acct"}},
    ];
    const {service, logs} = createHarness({
        rows,
        store: {updateQueue: async (id, value) => { updated.push([id, value]); }},
        plans: {
            buildDispatcher: () => "dispatcher",
            probe: async () => ({ok: true, plan_type: "plus", has_active_subscription: true}),
        },
        effects: {syncQueue: async () => synced.resolve()},
    });

    assert.deepEqual(await service.probePlans([1, 2]), {ok: true, count: 2});
    await synced.promise;
    await waitUntil(() => logs.some((line) => line.includes("套餐查询完成")));

    assert.deepEqual(updated, [[2, {plan_type: "plus"}]]);
    assert.ok(logs.some((line) => line.includes("missing@example.com 无 AT")));
    assert.ok(logs.some((line) => line.includes("套餐查询完成: 成功 1 / 失败 1")));
});

test("套餐查询运行中拒绝重复批次并在完成后释放互斥", async () => {
    const gate = deferred();
    const rows = [{id: 1, account_id: 11, email: "a@example.com", account_auth: {access_token: "at", account_id: "acct"}}];
    const {service, logs} = createHarness({
        rows,
        plans: {buildDispatcher: () => null, probe: () => gate.promise},
    });

    assert.deepEqual(await service.probePlans([1]), {ok: true, count: 1});
    assert.equal((await service.probePlans([1])).status, 409);
    gate.resolve({ok: true, plan_type: "plus"});
    await waitUntil(() => logs.some((line) => line.includes("套餐查询完成")));

    assert.deepEqual(await service.probePlans([999]), {ok: true, updated: 0});
});

test("导出结果通知异常不会卡住 RT 运行锁", async () => {
    const rows = [{id: 1, account_id: 11, email: "a@example.com"}];
    const {service, logs} = createHarness({
        rows,
        rtAcquire: async () => ({ok: 1, fail: 0, total: 1}),
        effects: {ready: () => { throw new Error("broadcast failed"); }},
    });

    await service.exportQueue({ids: [1], format: "rt"});
    await waitUntil(() => !service.isRunning());

    assert.ok(logs.some((line) => line.includes("导出结果通知失败")));
});
