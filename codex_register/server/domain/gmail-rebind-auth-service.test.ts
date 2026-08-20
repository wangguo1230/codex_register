import assert from "node:assert/strict";
import test from "node:test";
import {createGmailRebindAuthService} from "./gmail-rebind-auth-service.js";

function createHarness(overrides = {}) {
    const relogins = [];
    const updates = [];
    let liveAccount = {id: 1, email: "old@example.com", auth: {accessToken: "fresh-at"}};
    const service = createGmailRebindAuthService({
        getAccount: async () => liveAccount,
        updateAccount: async (id, value) => { updates.push({id, value}); },
        getAuthData: (account) => account.auth,
        extractTokens: (data) => data,
        isSessionAlive: () => ({ok: true, leftMs: 300_000}),
        needsFreshLogin: () => false,
        pwdAuthLeftMs: () => 300_000,
        needsPwdReauth: () => true,
        isGoogleMailbox: () => false,
        rememberGoogleCredentials: () => {},
        rememberMailcomPassword: () => {},
        relogin: async (account, options) => { relogins.push({account, options}); return {ok: true}; },
        reloginIdleMs: () => 10_000,
        enrollTotp: async () => ({ok: false}),
        rechargeProxy: () => "http://127.0.0.1:10808",
        browserFallback: () => false,
        ...overrides,
    });
    return {service, relogins, updates, setLiveAccount: (value) => { liveAccount = value; }};
}

test("session 和 pwd_auth 足够新时直接复用，不触发重登", async () => {
    const h = createHarness();
    const account = {id: 1, email: "old@example.com", auth: {accessToken: "at"}};
    const result = await h.service.prepare(account);

    assert.equal(result.ok, true);
    assert.equal(result.accessToken, "at");
    assert.equal(h.relogins.length, 0);
});

test("session 失效时重登并从数据库读取最新 AT", async () => {
    const h = createHarness({isSessionAlive: () => ({ok: false, leftMs: 0})});
    h.setLiveAccount({id: 1, email: "old@example.com", auth: {accessToken: "new-at"}});
    const result = await h.service.prepare({id: 1, email: "old@example.com", auth: {accessToken: "old-at"}});

    assert.equal(result.ok, true);
    assert.equal(result.accessToken, "new-at");
    assert.equal(h.relogins.length, 1);
});

test("官方要求重新认证时按需绑定 2FA 后再次重登", async () => {
    let enrollCalls = 0;
    const h = createHarness({
        needsPwdReauth: () => false,
        enrollTotp: async () => { enrollCalls++; return {ok: true, secret: "totp", via: "http"}; },
    });
    h.setLiveAccount({id: 1, email: "old@example.com", auth: {accessToken: "renewed-at"}});
    const result = await h.service.reauthenticate(
        {id: 1, email: "old@example.com", password: "pw"},
        {fresh: {id: 1, email: "old@example.com", auth: {accessToken: "at"}}, token: {accountId: "a1"}, accessToken: "at"},
    );

    assert.equal(result.ok, true);
    assert.equal(result.accessToken, "renewed-at");
    assert.equal(enrollCalls, 1);
    assert.equal(h.updates[0].value.totp_secret, "totp");
    assert.equal(h.relogins.length, 1);
});

test("重登阶段透传子进程跟踪器并响应取消", async () => {
    const controller = new AbortController();
    const onChild = () => {};
    const h = createHarness({
        isSessionAlive: () => ({ok: false, leftMs: 0}),
        relogin: async (_account, options) => {
            assert.equal(options.onChild, onChild);
            controller.abort();
            return {ok: false, reason: "worker stopped"};
        },
    });

    const result = await h.service.prepare(
        {id: 1, email: "old@example.com", auth: {accessToken: "old-at"}},
        null,
        {signal: controller.signal, onChild},
    );

    assert.equal(result.cancelled, true);
    assert.equal(result.reason, "已取消换绑");
});
