import assert from "node:assert/strict";
import test from "node:test";
import {createAccountTokenService} from "./account-token-service.js";

function createHarness(overrides = {}) {
    const account = overrides.account || {id: 1, auth_data: {access_token: "at", refresh_token: "rt"}};
    const statuses = [];
    const updates = [];
    let workerRuns = 0;
    let refreshCalls = 0;
    const service = createAccountTokenService({
        store: {
            setTestStatus: async (_id, kind, status) => { statuses.push([kind, status]); },
            getAccount: async () => account,
            setDeadAt: async (_id, value) => { account.dead_at = value; },
            updateAccount: async (_id, value) => { updates.push(value); },
            updateQueuePlan: async () => 0,
            updateRtData: async (_id, value) => { updates.push(value); },
        },
        credentials: {
            readAuth: (value) => value?.auth_data,
            readRt: (value) => value?.rt_data,
            readFile: () => null,
            extract: (data) => data ? {
                accessToken: data.access_token || "",
                refreshToken: data.refresh_token || "",
                accountId: data.account_id || "",
                raw: data,
            } : null,
        },
        http: {
            buildDispatcher: (url) => url,
            probeAt: overrides.probeAt || (async () => ({ok: true})),
            refreshRt: overrides.refreshRt || (async () => { refreshCalls++; return {ok: true, tokens: {access_token: "new-at", refresh_token: "new-rt"}}; }),
            probePlan: async () => ({ok: false}),
        },
        settings: {
            tokenProxy: () => "http://127.0.0.1:10808",
            rechargeProxy: () => "http://127.0.0.1:10808",
            maskProxy: (value) => value,
        },
        files: {writeRt() {}},
        relogin: {run: overrides.relogin || (async () => ({ok: false}))},
        rtWorker: {run: async () => { workerRuns++; return {ok: true, refresh_token: "acquired"}; }},
        effects: {status: async () => {}, logAccount() {}, syncQueue: async () => {}},
        delay: (resolve) => resolve(),
        now: () => new Date("2026-08-20T00:00:00.000Z"),
    });
    return {service, account, statuses, updates, workerRuns: () => workerRuns, refreshCalls: () => refreshCalls};
}

test("AT 有效时复活已失效账号", async () => {
    const harness = createHarness({account: {id: 1, dead_at: 123, auth_data: {access_token: "at"}}});

    assert.equal((await harness.service.testAt(harness.account)).ok, true);

    assert.equal(harness.account.dead_at, 0);
    assert.deepEqual(harness.statuses.at(-1), ["at", "✅有效"]);
});

test("RT 首次刷新失败后重试并写回独立 RT 数据", async () => {
    let calls = 0;
    const harness = createHarness({
        account: {id: 1, rt_file: "rt.json", rt_data: {refresh_token: "rt"}},
        refreshRt: async () => {
            calls++;
            return calls === 1
                ? {ok: false, reason: "network"}
                : {ok: true, tokens: {access_token: "new-at", refresh_token: "new-rt"}};
        },
    });

    const result = await harness.service.testRt(harness.account);

    assert.equal(result.ok, true);
    assert.equal(calls, 2);
    assert.equal(harness.updates[0].refresh_token, "new-rt");
});

test("无 RT 且允许获取时委托 RT Worker", async () => {
    const harness = createHarness({account: {id: 1, phone: "+1000"}});

    const result = await harness.service.testRt(harness.account, {acquire: true});

    assert.equal(result.refresh_token, "acquired");
    assert.equal(harness.workerRuns(), 1);
});
