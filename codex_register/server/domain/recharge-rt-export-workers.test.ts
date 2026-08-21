import assert from "node:assert/strict";
import test from "node:test";
import {createRechargeRtAcquireService} from "./recharge-rt-acquire.js";
import {createSub2jsonExportService} from "./recharge-sub2json-export.js";

test("RT force export uses one worker login", async () => {
    let reloginCalls = 0;
    let acquireCalls = 0;
    let acquireOptions = null;
    const logs = [];
    const acquire = createRechargeRtAcquireService({
        getAccounts: async () => [{id: 1, email: "a@example.com", rt_data: null, auth_data: null}],
        getAuthData: (account) => account.auth_data,
        getRtData: (account) => account.rt_data,
        extractTokens: () => null,
        relogin: async () => { reloginCalls++; return {ok: true}; },
        acquireRt: async (_account, options) => { acquireCalls++; acquireOptions = options; return {ok: true}; },
    });
    const result = await acquire([{account_id: 1, email: "a@example.com"}], {
        forceRelogin: true,
        log: (line) => logs.push(line),
    });
    assert.deepEqual(result, {ok: 1, fail: 0, total: 1});
    assert.equal(reloginCalls, 0);
    assert.equal(acquireCalls, 1);
    assert.equal(acquireOptions.forceAcquire, true);
    assert.match(logs[0], /RT/);
});

test("RT 导出批量预取账号避免逐条数据库查询", async () => {
    let batchCalls = 0;
    let singleCalls = 0;
    const acquire = createRechargeRtAcquireService({
        getAccounts: async () => {
            batchCalls++;
            return [
                {id: 1, rt_data: null, auth_data: null},
                {id: 2, rt_data: null, auth_data: null},
            ];
        },
        getAccount: async () => { singleCalls++; return null; },
        getAuthData: (account) => account.auth_data,
        getRtData: (account) => account.rt_data,
        extractTokens: () => null,
        acquireRt: async () => ({ok: true}),
    });

    const result = await acquire([
        {account_id: 1, email: "a@example.com"},
        {account_id: 2, email: "b@example.com"},
    ], {concurrency: 2});

    assert.equal(result.ok, 2);
    assert.equal(batchCalls, 1);
    assert.equal(singleCalls, 0);
});

test("sub2json 批量预取账号避免逐条数据库查询", async () => {
    let batchCalls = 0;
    let singleCalls = 0;
    const service = createSub2jsonExportService({
        getAccounts: async () => {
            batchCalls++;
            return [
                {id: 1, email: "a@example.com"},
                {id: 2, email: "b@example.com"},
            ];
        },
        getAccount: async () => { singleCalls++; return null; },
        getRtData: () => null,
        extractTokens: () => null,
        testOneRt: async (account) => ({
            ok: true,
            tokens: {access_token: `at-${account.id}`, refresh_token: `rt-${account.id}`},
        }),
    });

    const result = await service.exportAccounts([
        {account_id: 1, email: "a@example.com"},
        {account_id: 2, email: "b@example.com"},
    ], {concurrency: 2});

    assert.equal(result.ok, 2);
    assert.equal(batchCalls, 1);
    assert.equal(singleCalls, 0);
});

test("RT 导出把账号读取异常计入失败数", async () => {
    const logs = [];
    const acquire = createRechargeRtAcquireService({
        getAccount: async () => { throw new Error("db unavailable"); },
    });

    const result = await acquire([{account_id: 1, email: "a@example.com"}], {log: (line) => logs.push(line)});

    assert.deepEqual(result, {ok: 0, fail: 1, total: 1});
    assert.match(logs[0], /读取账号失败/);
});

test("sub2json 把账号读取异常计入失败数", async () => {
    const logs = [];
    const service = createSub2jsonExportService({
        getAccount: async () => { throw new Error("db unavailable"); },
    });

    const result = await service.exportAccounts(
        [{account_id: 1, email: "a@example.com"}],
        {log: (line) => logs.push(line), progress: true},
    );

    assert.deepEqual(result, {accounts: [], ok: 0, fail: 1, total: 1});
    assert.match(logs[0], /读取账号失败/);
});
