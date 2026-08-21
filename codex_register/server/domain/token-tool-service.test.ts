import assert from "node:assert/strict";
import test from "node:test";
import {createTokenToolService, parseEmailPasswordLines} from "./token-tool-service.js";

function deferred() {
    let resolve;
    const promise = new Promise((res) => { resolve = res; });
    return {promise, resolve};
}

function createHarness(overrides = {}) {
    const events = [];
    const service = createTokenToolService({
        store: {
            listSuccess: async () => [],
            getAccount: async () => null,
            getAccountByEmail: async () => null,
            getMailbox: async () => null,
            setRtFile: async () => {},
            readAuth: () => null,
            readJson: () => null,
            readSessionFile: () => null,
            ...overrides.store,
        },
        workers: {
            runAt: async () => ({ok: true, accessToken: "at"}),
            runRt: async () => ({ok: true, rt: "rt"}),
            stopRt() {},
            ...overrides.workers,
        },
        tokens: {
            testAt: async () => ({ok: true}),
            extract: () => ({}),
            extractSession: () => null,
            refreshRt: async (rt) => ({ok: true, tokens: {refresh_token: rt}}),
            buildDispatcher: () => ({}),
            syncPlan: async () => "",
            ...overrides.tokens,
        },
        runPool: async (items, worker) => Promise.all(items.map(worker)),
        effects: {
            broadcast: (type, payload) => events.push({type, payload}),
            log() {},
            rootLog() {},
            warn() {},
        },
        config: {
            rtProxy: () => "",
            regProxy: () => "",
            rtConcurrency: () => 4,
            defaultPassword: () => "default",
        },
    });
    return {service, events};
}

test("解析批量邮箱文本并按邮箱去重", () => {
    assert.deepEqual(parseEmailPasswordLines([
        "A@Example.com----pw1----ignored-at",
        "a@example.com----pw2",
        "b@example.com\tpw3",
        "invalid",
    ].join("\n")), [
        {email: "a@example.com", password: "pw1"},
        {email: "b@example.com", password: "pw3"},
    ]);
});

test("AT 批次在首次异步查询前预占运行态", async () => {
    const gate = deferred();
    const h = createHarness({store: {listSuccess: async () => gate.promise}});

    const first = h.service.startAt({lines: "a@example.com----pw"});
    const second = await h.service.startAt({lines: "b@example.com----pw"});

    assert.equal(second.status, 409);
    gate.resolve([]);
    assert.equal((await first).ok, true);
});

test("RT 刷新并发执行但保持输入结果顺序", async () => {
    const h = createHarness({
        tokens: {
            refreshRt: async (rt) => {
                if (rt === "slow") await new Promise((resolve) => setTimeout(resolve, 5));
                return {ok: true, tokens: {refresh_token: rt}};
            },
        },
    });

    const result = await h.service.refreshTokens([
        {email: "a@example.com", password: "a", rt: "slow"},
        {email: "b@example.com", password: "b", rt: "fast"},
    ]);

    assert.deepEqual(result.results.map((item) => item.email), ["a@example.com", "b@example.com"]);
    assert.deepEqual(result.results.map((item) => item.tokens.refresh_token), ["slow", "fast"]);
});

test("RT 批次重试只执行失败项，成功项不会重复获取", async () => {
    const calls = [];
    let firstPass = true;
    const h = createHarness({
        workers: {
            runRt: async (email) => {
                calls.push(email);
                if (email === "b@example.com" && firstPass) return {ok: false, reason: "temporary"};
                return {ok: true, rt: `rt-${email}`};
            },
        },
    });
    const waitDone = async (after = 0) => {
        for (let i = 0; i < 100; i++) {
            if (h.events.filter((event) => event.type === "batchRtAcquire" && event.payload.done).length > after) return;
            await new Promise((resolve) => setTimeout(resolve, 2));
        }
        throw new Error("RT 批次未完成");
    };

    await h.service.startRt("a@example.com----pw\nb@example.com----pw\nc@example.com----pw");
    await waitDone();
    assert.deepEqual(calls, ["a@example.com", "b@example.com", "c@example.com"]);

    firstPass = false;
    const retry = await h.service.retryFailedRt();
    assert.equal(retry.count, 1);
    await waitDone(1);
    assert.deepEqual(calls, ["a@example.com", "b@example.com", "c@example.com", "b@example.com"]);

    const noRetry = await h.service.retryFailedRt();
    assert.equal(noRetry.count, 0);
    assert.deepEqual(calls, ["a@example.com", "b@example.com", "c@example.com", "b@example.com"]);
});
