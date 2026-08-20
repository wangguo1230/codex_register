import assert from "node:assert/strict";
import test from "node:test";
import {createRechargeAdminService} from "./recharge-admin-service.js";

function deferred() {
    let resolve;
    const promise = new Promise((done) => { resolve = done; });
    return {promise, resolve};
}

async function waitUntil(predicate) {
    for (let index = 0; index < 20; index++) {
        if (predicate()) return;
        await new Promise((resolve) => setImmediate(resolve));
    }
    assert.fail("等待卡密后台任务超时");
}

function createHarness(cards = [], overrides = {}) {
    const unpaired = [];
    const updates = [];
    const apiCalls = [];
    const logs = [];
    let batchReads = 0;
    const settings = {
            rechargeApiKey: "secret-api-key",
            rebindAfterPaid: "gmail",
            normalizeRebindAfterPaid() {},
            saveSettings() {},
            ...overrides.settings,
        };
    const service = createRechargeAdminService({
        settings,
        store: {
            countFreeGoogleImap: async () => 2,
            countFreeMailcom: async () => 3,
            listCards: async () => cards,
            getCard: async (id) => cards.find((card) => card.id === id),
            getCards: async (ids) => {
                batchReads++;
                return cards.filter((card) => ids.includes(card.id));
            },
            importCards: async () => ({}),
            deleteCards: async () => ({}),
            updateCard: async (id, value) => { updates.push([id, value]); },
            unpairCards: async (ids) => { unpaired.push(...ids); },
            applyValidation: async () => ({}),
            ...overrides.store,
        },
        logs: {list: () => [], clear() {}},
        api: {
            call: async (_method, _path, body) => {
                apiCalls.push(body.redeem_code);
                return {result: {status: "unused"}};
            },
            ...overrides.api,
        },
        effects: {log: (line) => logs.push(line), syncCards: async () => {}, ...overrides.effects},
        getJobState: overrides.getJobState || (() => ({})),
        instanceId: "test",
    });
    return {service, settings, unpaired, updates, apiCalls, logs, batchReads: () => batchReads};
}

test("提交中和已提交卡密不能手工解绑", async () => {
    const h = createHarness([
        {id: 1, code: "submitted-code", status: "submitted"},
        {id: 2, code: "unused-code", status: "unused"},
    ]);

    const result = await h.service.unpairCards([1, 2]);

    assert.deepEqual(h.unpaired, [2]);
    assert.deepEqual(result, {ok: true, unpaired: 1, skipped: 1});
});

test("配置读取只返回掩码 API key", async () => {
    const h = createHarness();
    const config = await h.service.getConfig();
    assert.equal(config.apiKey, "secret****-key");
    assert.equal(config.hasKey, true);
});

test("任务状态接口只读取当前实例状态，不触发配置或库存查询", () => {
    const h = createHarness([], {getJobState: () => ({submit: false, exportRt: true})});

    assert.deepEqual(h.service.getJobs(), {submit: false, exportRt: true});
    assert.equal(h.batchReads(), 0);
});

test("充值、换绑和 RT 并发配置可读取且不受旧上限限制", async () => {
    const h = createHarness([], {settings: {
        rechargeConcurrency: 21,
        rebindConcurrency: 37,
        rtConcurrency: 101,
    }});

    const config = await h.service.getConfig();

    assert.equal(config.concurrency, 21);
    assert.equal(config.rebindConcurrency, 37);
    assert.equal(config.rtConcurrency, 101);
});

test("充值、换绑和 RT 并发配置更新后持久化并返回", async () => {
    const h = createHarness();

    const result = await h.service.updateConfig({concurrency: 8, rebindConcurrency: 6, rtConcurrency: 12});

    assert.equal(h.settings.rechargeConcurrency, 8);
    assert.equal(h.settings.rebindConcurrency, 6);
    assert.equal(h.settings.rtConcurrency, 12);
    assert.equal(result.concurrency, 8);
    assert.equal(result.rebindConcurrency, 6);
    assert.equal(result.rtConcurrency, 12);
});

test("充值提交间隔允许保存并读取零秒", async () => {
    const h = createHarness();

    await h.service.updateConfig({interval: 0});
    const config = await h.service.getConfig();

    assert.equal(h.settings.rechargeInterval, 0);
    assert.equal(config.interval, 0);
});

test("批量验卡只查询一次并跳过活动状态卡密", async () => {
    const h = createHarness([
        {id: 1, code: "unused-code", status: "unused"},
        {id: 2, code: "error-code", status: "error"},
        {id: 3, code: "submitting-code", status: "submitting"},
        {id: 4, code: "submitted-code", status: "submitted"},
        {id: 5, code: "done-code", status: "done"},
    ]);

    assert.deepEqual(await h.service.startValidation([1, 2, 3, 4, 5]), {ok: true, count: 5});
    await waitUntil(() => h.logs.includes("验证完成"));

    assert.equal(h.batchReads(), 1);
    assert.deepEqual(h.apiCalls, ["unused-code", "error-code"]);
});

test("验卡读取尚未完成时拒绝并发启动第二个维护任务", async () => {
    const gate = deferred();
    const cards = [{id: 1, code: "unused-code", status: "unused"}];
    const h = createHarness(cards, {store: {getCards: () => gate.promise}});

    const first = h.service.startValidation([1]);
    const second = await h.service.startReset([1]);

    assert.equal(second.status, 409);
    gate.resolve(cards);
    assert.deepEqual(await first, {ok: true, count: 1});
    await waitUntil(() => h.logs.includes("验证完成"));
});

test("批量验卡中间刷新合并调度且结束时强制刷新一次", async () => {
    let scheduled = 0;
    let flushed = 0;
    let direct = 0;
    const h = createHarness([
        {id: 1, code: "card-1", status: "unused"},
        {id: 2, code: "card-2", status: "unused"},
    ], {effects: {
        scheduleAll: () => { scheduled++; },
        flushAll: async () => { flushed++; },
        syncCards: async () => { direct++; },
    }});

    await h.service.startValidation([1, 2]);
    await waitUntil(() => h.logs.includes("验证完成"));

    assert.equal(scheduled, 2);
    assert.equal(flushed, 1);
    assert.equal(direct, 0);
});
