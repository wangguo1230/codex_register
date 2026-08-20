import assert from "node:assert/strict";
import test from "node:test";
import {createGptMfaService} from "./gpt-mfa-service.js";

function createHarness({account, enrollTotp, relogin} = {}) {
    let live = account || {id: 1, auth_data: {}};
    const updates = [];
    const service = createGptMfaService({
        store: {
            get: async () => live,
            update: async (_id, fields) => {
                updates.push(fields);
                live = {...live, ...fields};
            },
            list: async () => [live],
        },
        enrollTotp: enrollTotp || (async () => ({ok: true, secret: "secret"})),
        relogin: relogin || (async () => ({ok: true})),
        readAuth: (value) => value.auth_data,
        extractTokens: (auth) => ({accessToken: auth?.accessToken || "", accountId: auth?.accountId || ""}),
        decodeJwt: () => ({}),
        getProxy: () => "",
        effects: {log() {}, broadcast() {}, warn() {}},
    });
    return {service, updates, setLive: (value) => { live = value; }};
}

test("无 AT 时标记状态并跳过绑定", async () => {
    let enrollCalls = 0;
    const h = createHarness({
        account: {id: 1, auth_data: {}},
        enrollTotp: async () => { enrollCalls++; return {ok: true}; },
    });

    await h.service.processAccount({id: 1, auth_data: {}});

    assert.equal(enrollCalls, 0);
    assert.deepEqual(h.updates, [{mfa_status: "❌无AT"}]);
});

test("pwd_auth 过期后重登并向绑定流程提供新 AT", async () => {
    let reauthResult;
    let reloginCalls = 0;
    const h = createHarness({
        account: {id: 1, auth_data: {accessToken: "old-at", cookie: "old-cookie"}},
        relogin: async () => {
            reloginCalls++;
            h.setLive({id: 1, auth_data: {accessToken: "new-at", accountId: "new-account", cookie: "new-cookie"}});
            return {ok: true};
        },
        enrollTotp: async (_accessToken, options) => {
            reauthResult = await options.reauth();
            return {ok: true, secret: "new-secret", via: "http"};
        },
    });

    await h.service.processAccount({id: 1, auth_data: {accessToken: "old-at", cookie: "old-cookie"}});

    assert.equal(reloginCalls, 1);
    assert.deepEqual(reauthResult, {
        accessToken: "new-at",
        accountId: "new-account",
        cookie: "new-cookie",
    });
    assert.deepEqual(h.updates.at(-1), {totp_secret: "new-secret", mfa_status: "✅已绑"});
});
