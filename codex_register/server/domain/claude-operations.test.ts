import assert from "node:assert/strict";
import test from "node:test";
import {createClaudeOperations} from "./claude-operations.js";

function createHarness({mailResult, queryResult, queryError} = {}) {
    const dead = [];
    const info = [];
    let queryCalls = 0;
    const account = {id: 1, email: "a@example.com", password: "pw", auth_data: {sessionKey: "session"}};
    const operations = createClaudeOperations({
        store: {
            get: async () => account,
            stats: async () => ({}),
            setInfo: async (...args) => { info.push(args); },
            setDeadAt: async (...args) => { dead.push(args); },
            appendLog: async () => {},
        },
        api: {
            scanDisabledMail: async () => mailResult || {hit: false},
            queryInfo: async () => {
                queryCalls++;
                if (queryError) throw queryError;
                return queryResult || {alive: true};
            },
            chat: async () => ({ok: true}),
        },
        runPool: async (items, worker) => { for (const item of items) await worker(item); },
        readAuth: (value) => value.auth_data,
        getProxyUrl: () => "",
        effects: {broadcast: () => {}, warn: () => {}},
    });
    return {operations, account, dead, info, queryCalls: () => queryCalls};
}

test("禁用通知邮件命中时置失效且不再调用 Claude API", async () => {
    const h = createHarness({mailResult: {hit: true, via: "imap", subject: "Account disabled"}});

    const result = await h.operations.scanAccountDisabled(h.account);

    assert.equal(result.alive, false);
    assert.equal(result.source, "mail");
    assert.equal(h.dead.length, 1);
    assert.equal(h.queryCalls(), 0);
});

test("Claude API 异常保持存疑且不误标账号失效", async () => {
    const h = createHarness({queryError: new Error("proxy timeout")});

    const result = await h.operations.scanAccountDisabled(h.account);

    assert.equal(result.alive, null);
    assert.equal(result.source, "api-error");
    assert.equal(h.dead.length, 0);
    assert.equal(h.info.length, 0);
});
