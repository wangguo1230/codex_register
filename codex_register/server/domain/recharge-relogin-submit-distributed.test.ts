import assert from "node:assert/strict";
import test from "node:test";
import {createRechargeReloginSubmitDistribution} from "./recharge-relogin-submit-distributed.js";
import {createRechargeReloginSubmitTaskExecutor} from "./recharge-relogin-submit-task.js";

function workerStub() {
    return {
        started: 0,
        woken: 0,
        start() { this.started++; },
        wake() { this.woken++; },
        isBusy: () => false,
        stop: async () => {},
    };
}

function queueRow(overrides = {}) {
    return {
        id: 1,
        account_id: 9,
        email: "a@example.com",
        status: "error",
        delivery_status: "undelivered",
        instance_id: "",
        card_id: 0,
        auth_file: "auth.json",
        auth_data: {},
        ...overrides,
    };
}

test("重登提交批量入口只入队，多实例重复点击不会生成第二条活动任务", async () => {
    const row = queueRow();
    const active = new Set();
    let inserts = 0;
    const makeStore = () => ({
        getMany: async () => [row],
        enqueueTasks: async (items) => {
            inserts++;
            const created = items.filter((item) => !active.has(Number(item.entityId)));
            for (const item of created) active.add(Number(item.entityId));
            return created.map((item) => ({entity_id: item.entityId, status: "pending"}));
        },
    });
    const firstWorker = workerStub();
    const secondWorker = workerStub();
    const create = (instanceId, worker) => {
        const distribution = createRechargeReloginSubmitDistribution({
            instanceId,
            store: makeStore(),
            executor: {execute: async () => ({ok: true})},
            effects: {log() {}, jobsChanged() {}},
            isConfigured: () => true,
        });
        distribution.bind(worker);
        return distribution;
    };

    const first = await create("node-a", firstWorker).start([1]);
    const second = await create("node-b", secondWorker).start([1]);

    assert.equal(first.ok, true);
    assert.equal(first.queued, 1);
    assert.equal(second.status, 400);
    assert.match(second.error, /已在重登提交分布式队列/);
    assert.equal(inserts, 2);
    assert.equal(firstWorker.started, 1);
    assert.equal(secondWorker.started, 0);
});

test("重登提交任务先取得充值行租约，再刷新 session、校验卡密并提交", async () => {
    const item = queueRow({status: "error"});
    const calls = [];
    const submitted = [];
    const executor = createRechargeReloginSubmitTaskExecutor({
        instanceId: "node-a",
        store: {
            claim: async (ids, owner, options) => {
                calls.push(["claim", ids, owner, options]);
                return {claimed: [{...item, instance_id: owner}], skipped: []};
            },
            getQueue: async () => item,
            getAccount: async () => ({id: 9, auth_file: "fresh.json"}),
            updateQueueAuth: async (...args) => calls.push(["session", ...args]),
            getCard: async () => null,
            updateCard: async (...args) => calls.push(["card", ...args]),
            assignCard: async (...args) => {
                calls.push(["assign", ...args]);
                return {queueItem: {...item, status: "paired", card_id: 3}, card: {id: 3, code: "card-code"}};
            },
            releaseByInstance: async (...args) => calls.push(["release", ...args]),
            cancelPair: async (...args) => calls.push(["cancel", ...args]),
        },
        relogin: async () => ({ok: true, authFile: "fresh.json"}),
        credentials: {
            readAuth: () => ({session: {accessToken: "at"}}),
            extractSession: (value) => value?.session || null,
        },
        api: {call: async () => ({result: {status: "unused"}})},
        cards: {
            takeReusable: async () => ({card: {id: 3, code: "card-code"}, val: {status: "unused"}}),
            failureReason: () => "无可用卡密",
        },
        submitOne: async (...args) => {
            submitted.push(args);
            return {ok: true, taskNo: "task-1"};
        },
        policy: {isAccountDeadReason: () => false},
        effects: {log() {}, scheduleAll() {}, syncAll: async () => {}},
    });

    const result = await executor.execute({entity_id: 1}, {signal: new AbortController().signal});

    assert.equal(result.ok, true);
    assert.equal(submitted.length, 1);
    assert.equal(submitted[0][0].status, "paired");
    assert.equal(submitted[0][1].id, 3);
    assert.equal(calls[0][0], "claim");
    assert.equal(calls.some((call) => call[0] === "session"), true);
    assert.equal(calls.some((call) => call[0] === "assign"), true);
    assert.deepEqual(calls.at(-1), ["release", "node-a", [1]]);
});

test("重登提交配卡事务失败时回收新卡，任务不会留下充值行租约", async () => {
    const releasedCards = [];
    const releasedRows = [];
    const item = queueRow();
    const executor = createRechargeReloginSubmitTaskExecutor({
        instanceId: "node-a",
        store: {
            claim: async () => ({claimed: [{...item, instance_id: "node-a"}], skipped: []}),
            getQueue: async () => item,
            getAccount: async () => ({id: 9, auth_file: "fresh.json"}),
            updateQueueAuth: async () => {},
            getCard: async () => null,
            assignCard: async () => { throw new Error("配卡事务失败"); },
            releaseByInstance: async (_owner, ids) => releasedRows.push(ids),
        },
        relogin: async () => ({ok: true, authFile: "fresh.json"}),
        credentials: {
            readAuth: () => ({session: {accessToken: "at"}}),
            extractSession: (value) => value?.session || null,
        },
        api: {call: async () => ({result: {status: "unused"}})},
        cards: {
            takeReusable: async () => ({card: {id: 7, code: "card-code"}, val: {status: "unused"}}),
            release: async (ids) => releasedCards.push(ids),
            failureReason: () => "无可用卡密",
        },
        submitOne: async () => assert.fail("配卡失败后不应提交"),
        policy: {isAccountDeadReason: () => false},
        effects: {log() {}, syncAll: async () => {}},
    });

    await assert.rejects(() => executor.execute({entity_id: 1}));
    assert.deepEqual(releasedCards, [[7]]);
    assert.deepEqual(releasedRows, [[1]]);
});

test("原卡平台已消费时跳过，不会重新提交", async () => {
    let submits = 0;
    const item = queueRow({card_id: 8});
    const executor = createRechargeReloginSubmitTaskExecutor({
        instanceId: "node-a",
        store: {
            claim: async () => ({claimed: [{...item, instance_id: "node-a"}], skipped: []}),
            getQueue: async () => item,
            getAccount: async () => ({id: 9, auth_file: "fresh.json"}),
            updateQueueAuth: async () => {},
            getCard: async () => ({id: 8, code: "used-card"}),
            updateCard: async () => {},
            releaseByInstance: async () => {},
        },
        relogin: async () => ({ok: true, authFile: "fresh.json"}),
        credentials: {
            readAuth: () => ({session: {accessToken: "at"}}),
            extractSession: (value) => value?.session || null,
        },
        api: {call: async () => ({result: {status: "paid"}})},
        cards: {takeReusable: async () => assert.fail("已消费原卡不能再取新卡")},
        submitOne: async () => { submits++; },
        policy: {isAccountDeadReason: () => false},
        effects: {log() {}, scheduleAll() {}, syncAll: async () => {}},
    });

    const result = await executor.execute({entity_id: 1});

    assert.equal(result.skipped, true);
    assert.equal(submits, 0);
});
