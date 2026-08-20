import assert from "node:assert/strict";
import {EventEmitter} from "node:events";
import test from "node:test";
import {createAccountRtWorker} from "./account-rt-worker.js";

function createHarness(overrides = {}) {
    const statuses = [];
    const writes = [];
    let output;
    const child = new EventEmitter();
    child.killed = false;
    child.kill = () => { child.killed = true; return true; };
    const worker = createAccountRtWorker({
        runtime: {
            spawn: overrides.spawn || (() => child),
            cleanEnv: (env) => env,
            attachChild() {},
            pipeOutput: (_child, handlers) => { output = handlers; },
        },
        store: {
            setRtFile: async (...args) => { writes.push(args); },
            setPhone: async () => {},
            setCard: async () => {},
        },
        files: {
            writeCredential() {},
            readJson: () => ({access_token: "at", refresh_token: "rt"}),
        },
        settings: {
            rtProxy: () => "socks5://exit",
            regProxy: () => "",
            rechargeProxy: () => "socks5://exit",
            mailProxyEnabled: () => false,
            mailProxy: () => "",
            smsLinkTemplate: () => "",
            smsMaxBind: () => 0,
            defaultPassword: () => "password",
        },
        proxy: {
            withLease: overrides.withLease || (async (_owner, task) => task("socks5://exit", "")),
            pickXray: async () => "",
            pickMailBrowser: () => "",
            mask: (value) => value,
        },
        effects: {
            setStatus: async (...args) => { statuses.push(args); },
            emitSmsStats: async () => {},
            syncPlan: async () => "plus",
        },
        credentials: {extract: () => ({accessToken: "at", accountId: "acct"})},
        timeouts: {idleMs: 60_000, maxMs: 120_000, graceMs: 3_000},
    });
    return {worker, child, statuses, writes, output: () => output};
}

test("代理租约异常收敛为 RT 失败状态", async () => {
    const {worker, statuses} = createHarness({withLease: async () => { throw new Error("pool failed"); }});

    const result = await worker.run({id: 1, email: "a@example.com"}, "");

    assert.deepEqual(result, {ok: false, reason: "pool failed"});
    assert.match(statuses.at(-1)[2], /获取失败/);
});

test("成功结果只持久化一次并返回套餐", async () => {
    const {worker, child, writes, output} = createHarness();
    const pending = worker.run({id: 1, email: "a@example.com", provider: "mailcom"}, "");
    await new Promise((resolve) => setImmediate(resolve));

    output().onEvent({type: "result", status: "success", rt: "rt", rtFile: "rt.json"});
    child.emit("close", 0);
    child.emit("close", 0);
    const result = await pending;

    assert.deepEqual(result, {ok: true, refresh_token: "rt", plan_type: "plus"});
    assert.equal(writes.length, 1);
});

test("Worker error 与 close 竞态只返回启动失败", async () => {
    const {worker, child} = createHarness();
    const pending = worker.run({id: 1, email: "a@example.com", provider: "mailcom"}, "");
    await new Promise((resolve) => setImmediate(resolve));

    child.emit("error", new Error("spawn failed"));
    child.emit("close", 1);

    assert.deepEqual(await pending, {ok: false, reason: "spawn failed"});
});
