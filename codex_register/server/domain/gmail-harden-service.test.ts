import assert from "node:assert/strict";
import test from "node:test";
import {createGmailHardenService} from "./gmail-harden-service.js";

function createHarness(overrides = {}) {
    const states = [];
    const passwords = [];
    const proxies = [];
    const updates = [];
    const abortControllers = new Map();
    const current = new Map();
    let workerCalls = 0;
    let applied = 0;
    const mailbox = {
        id: 1,
        email: "a@gmail.com",
        provider: "google",
        password: "old-pw",
        totp_secret: "old-totp",
        google_state: {},
    };
    const service = createGmailHardenService({
        store: {
            getMailbox: async () => mailbox,
            refreshGoogleState: async (id, state) => { states.push({id, state}); },
            setJobLine: async () => {},
            setPassword: async (...args) => { passwords.push(args); },
            commitTotp: async (_id, secret) => ({ok: true, totp: secret}),
            applyUpdate: async (...args) => { updates.push(args); },
            setProxy: async (...args) => { proxies.push(args); },
        },
        withProxy: async (_owner, task) => task("socks5://exit", "", () => {}),
        runWorker: async (_task, options) => {
            workerCalls++;
            await options.onCheckpoint({password: "new-pw", verified: true, imapPassword: "imap"});
            return {ok: true, passwordChanged: true, password: "new-pw", imapPassword: "imap", missing: [], errors: []};
        },
        applyResult: async () => { applied++; },
        runtime: {isStopped: () => false, abortControllers, current},
        effects: {log: () => {}, scheduleBroadcast: () => {}, syncMailboxes: async () => {}},
        maskProxy: (value) => value,
        sessionOf: () => "session-1",
        instanceId: "instance-1",
        now: () => new Date(2026, 7, 19, 10, 30).getTime(),
        ...overrides,
    });
    return {
        service,
        mailbox,
        states,
        passwords,
        proxies,
        updates,
        abortControllers,
        current,
        workerCalls: () => workerCalls,
        applied: () => applied,
    };
}

test("最低整备条件已齐时跳过开窗", async () => {
    const h = createHarness();
    h.mailbox.imap_password = "imap";
    h.mailbox.google_state = {totp_rotated: true};
    const result = await h.service(1);

    assert.equal(result.ok, true);
    assert.equal(result.skipped, true);
    assert.equal(h.workerCalls(), 0);
});

test("Worker 检查点先落库，完成后清理运行态", async () => {
    const h = createHarness();
    const result = await h.service(1, {jobId: 10});

    assert.equal(result.ok, true);
    assert.equal(h.applied(), 1);
    assert.equal(h.passwords[0][1], "new-pw");
    assert.equal(h.updates[0][1].imap_password, "imap");
    assert.equal(h.abortControllers.size, 0);
    assert.equal(h.current.size, 0);
});

test("连续代理拒绝达到阈值时清除粘性出口并判登录失败", async () => {
    const h = createHarness({
        runWorker: async () => { throw new Error("signin/rejected 出口被拒"); },
    });
    h.mailbox.google_state = {proxy_rotates: 1};
    h.mailbox.proxy_url = "socks5://old";
    const result = await h.service(1);

    assert.equal(result.ok, false);
    assert.deepEqual(h.proxies, [[1, "", ""]]);
    const failure = h.states.find((entry) => entry.state.proxy_rotates === 2);
    assert.equal(failure.state.login, "fail");
    assert.equal(failure.state.login_error, "rejected");
});

test("停止标记存在时不读取代理也不开 Worker", async () => {
    const h = createHarness({
        runtime: {isStopped: () => true, abortControllers: new Map(), current: new Map()},
    });
    const result = await h.service(1);
    assert.deepEqual(result, {ok: false, error: "已停止"});
    assert.equal(h.workerCalls(), 0);
});
