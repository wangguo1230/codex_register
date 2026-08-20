import assert from "node:assert/strict";
import test from "node:test";
import {createRechargeMailboxPrecheckService} from "./recharge-mailbox-precheck-service.js";

function createHarness(overrides = {}) {
    const logs = [];
    const released = [];
    const states = [];
    let imapCalls = 0;
    let webCalls = 0;
    const pool = {
        urls: overrides.poolUrls ?? ["socks5://exit"],
        lease: async () => ({url: "socks5://exit", release: () => released.push("exit")}),
    };
    const service = createRechargeMailboxPrecheckService({
        store: {
            getAccount: async () => overrides.account,
            refreshGoogleState: async (...args) => { states.push(args); },
        },
        mailbox: {
            isGoogle: (account) => account?.provider === "google",
            isMailcom: (account) => account?.provider === "mailcom",
            rememberMailcomPassword() {},
            verifyMailcom: overrides.verifyMailcom || (async () => ({ok: true})),
        },
        imap: {
            test: overrides.testImap || (async () => { imapCalls++; return {ok: true, messages: 2}; }),
            isTransient: (error) => /timeout|close/i.test(String(error)),
        },
        proxy: {mailPool: pool, gptPool: pool, mask: (value) => value},
        settings: {mailJump: () => "", gptJump: () => "", rechargeProxy: () => "http://127.0.0.1:10808"},
        web: {
            probe: overrides.probeWeb || (async () => { webCalls++; return {ok: true}; }),
            fresh: overrides.fresh || (() => ({fresh: false, ageMs: 0})),
        },
        effects: {log: (line) => logs.push(line)},
        credentials: overrides.credentials,
    });
    return {service, logs, released, states, imapCalls: () => imapCalls, webCalls: () => webCalls};
}

test("IMAP 认证失败立即停止换出口且释放租约", async () => {
    const harness = createHarness({
        account: {id: 1, email: "a@gmail.com", provider: "google", mailbox_imap: "imap"},
        testImap: async () => ({ok: false, error: "AUTHENTICATIONFAILED invalid credentials"}),
    });

    const result = await harness.service.precheck({account_id: 1});

    assert.match(result.reason, /IMAP 不可用/);
    assert.deepEqual(harness.released, ["exit"]);
    assert.equal(harness.logs.some((line) => line.includes("回退本机")), false);
});

test("IMAP 线路错误标记为可重试且不误判凭据", async () => {
    const harness = createHarness({
        account: {id: 1, email: "a@gmail.com", provider: "google", mailbox_imap: "imap"},
        poolUrls: [],
        testImap: async () => ({ok: false, error: "Unexpected close timeout"}),
    });

    const result = await harness.service.precheck({account_id: 1});

    assert.equal(result.transient, true);
    assert.match(result.reason, /未配卡，可再提交/);
});

test("近期网页探测有效时换绑跳过开窗", async () => {
    const harness = createHarness({fresh: () => ({fresh: true, ageMs: 120_000})});

    const result = await harness.service.probeRebindLogin({id: 1, imap_password: "imap"});

    assert.deepEqual(result, {ok: true, skipped: true, skipReason: "recent"});
    assert.equal(harness.webCalls(), 0);
});

test("换绑网页探测成功后记录登录时间", async () => {
    const harness = createHarness();

    assert.deepEqual(await harness.service.probeRebindLogin({id: 1, imap_password: "imap"}), {ok: true});

    assert.equal(harness.webCalls(), 1);
    assert.equal(harness.states[0][0], 1);
    assert.equal(harness.states[0][1].login, "ok");
});

test("GPT session 缺失时在配卡前终止", async () => {
    const harness = createHarness({
        account: {id: 1, email: "a@gmail.com", provider: "google", mailbox_imap: "imap"},
        credentials: {read: () => null, extractSession: () => null},
    });

    const result = await harness.service.precheck({account_id: 1});

    assert.equal(result.ok, false);
    assert.match(result.reason, /session 数据缺失/);
    assert.equal(harness.imapCalls(), 0);
});
