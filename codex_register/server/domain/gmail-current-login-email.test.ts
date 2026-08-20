import assert from "node:assert/strict";
import test from "node:test";
import {createCurrentLoginEmailResolver} from "./gmail-current-login-email.js";

function createResolver(overrides = {}) {
    return createCurrentLoginEmailResolver({
        pickProxy: async () => "http://127.0.0.1:10808",
        getAuthData: (account) => account.auth,
        getRtData: (account) => account.rt,
        extractTokens: (data) => data,
        fetchCurrentLoginEmail: async () => ({ok: true, email: "target@gmail.com"}),
        refreshRt: async () => ({ok: false, reason: "unused"}),
        relogin: async () => ({ok: false, reason: "unused"}),
        getAccount: async (id) => ({id, auth: {accessToken: "fresh-at"}}),
        ...overrides,
    });
}

test("现有 AT 可用时不触发 RT 和重登", async () => {
    let refreshCalls = 0;
    let reloginCalls = 0;
    const resolve = createResolver({
        refreshRt: async () => { refreshCalls++; return {ok: false}; },
        relogin: async () => { reloginCalls++; return {ok: false}; },
    });

    const result = await resolve({id: 1, email: "old@example.com", auth: {accessToken: "at"}});
    assert.equal(result.email, "target@gmail.com");
    assert.equal(refreshCalls, 0);
    assert.equal(reloginCalls, 0);
});

test("AT 失效后按顺序使用 RT 换取新 AT", async () => {
    const reads = [];
    const resolve = createResolver({
        fetchCurrentLoginEmail: async (accessToken) => {
            reads.push(accessToken);
            return accessToken === "old-at"
                ? {ok: false, needReauth: true, email: ""}
                : {ok: true, email: "target@gmail.com"};
        },
        refreshRt: async () => ({ok: true, tokens: {access_token: "new-at", account_id: "a1"}}),
    });

    const result = await resolve({
        id: 1,
        email: "old@example.com",
        auth: {accessToken: "old-at"},
        rt: {refreshToken: "rt"},
    });
    assert.equal(result.email, "target@gmail.com");
    assert.deepEqual(reads, ["old-at", "new-at"]);
});

test("AT 和 RT 不可用时仅将原邮箱重登作为最后兜底", async () => {
    let reloginCalls = 0;
    const resolve = createResolver({
        fetchCurrentLoginEmail: async (accessToken) => accessToken === "fresh-at"
            ? {ok: true, email: "target@gmail.com"}
            : {ok: false, needReauth: true, email: ""},
        refreshRt: async () => ({ok: false, reason: "expired"}),
        relogin: async () => { reloginCalls++; return {ok: true}; },
    });

    const result = await resolve({
        id: 1,
        email: "old@example.com",
        auth: {accessToken: "old-at"},
        rt: {refreshToken: "rt"},
    });
    assert.equal(result.email, "target@gmail.com");
    assert.equal(reloginCalls, 1);
});
