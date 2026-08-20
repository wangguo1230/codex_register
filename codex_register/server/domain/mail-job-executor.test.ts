import assert from "node:assert/strict";
import test from "node:test";
import {createMailJobExecutor} from "./mail-job-executor.js";

function createHarness(overrides = {}) {
    const completed = [];
    const requeued = [];
    const allocated = [];
    const localMailboxIds = new Set();
    const abortControllers = new Map([[1, {}]]);
    const current = new Map([[1, {}]]);
    let accountSyncs = 0;
    let nextRuns = 0;
    const execute = createMailJobExecutor({
        store: {
            getMailbox: async () => ({id: 1, email: "a@gmail.com", totp_secret: "old"}),
            complete: async (...args) => { completed.push(args); },
            requeue: async (...args) => { requeued.push(args); },
            setLine: async () => {},
            commitTotp: async (_id, secret) => ({ok: true, totp: secret}),
            allocateMailbox: async (...args) => { allocated.push(args); },
        },
        services: {
            changePassword: async () => ({ok: true, np: "new-pw", detail: ""}),
            changeTotp: async () => ({ok: true, totpSecret: "new-totp"}),
            harden: async () => ({ok: true, imapPassword: "imap", totpRotated: true}),
            parkForBitDown: async () => {},
        },
        classifiers: {
            formatHardenError: (result) => result.error || "",
            isBitTransient: (message) => /bit-down/.test(message),
            isProxyInfra: (message) => /proxy-down/.test(message),
        },
        runtime: {localMailboxIds, abortControllers, current},
        effects: {
            logMailbox: () => {},
            warn: () => {},
            syncAccounts: async () => { accountSyncs++; },
            scheduleBroadcast: () => {},
            scheduleNext: () => { nextRuns++; },
        },
        instanceId: "instance-1",
        ...overrides,
    });
    return {
        execute,
        completed,
        requeued,
        allocated,
        localMailboxIds,
        abortControllers,
        current,
        accountSyncs: () => accountSyncs,
        nextRuns: () => nextRuns,
    };
}

test("改密任务成功后按 payload 分配邮箱并刷新账号视图", async () => {
    const h = createHarness();
    await h.execute({
        id: 10,
        mailbox_id: 1,
        email: "a@example.com",
        kind: "pw",
        payload: JSON.stringify({oldPw: "old", afterAllocate: {usage: "gpt", batch: "b1"}}),
    });

    assert.equal(h.completed[0][1], true);
    assert.deepEqual(h.allocated[0], ["gpt", [1], "b1"]);
    assert.equal(h.accountSyncs(), 1);
});

test("2FA CAS 冲突时任务失败且不覆盖新密钥", async () => {
    const h = createHarness({
        store: {
            getMailbox: async () => ({id: 1, totp_secret: "old"}),
            complete: async (...args) => { h.completed.push(args); },
            requeue: async (...args) => { h.requeued.push(args); },
            setLine: async () => {},
            commitTotp: async () => ({ok: false, reason: "stale"}),
            allocateMailbox: async () => {},
        },
    });
    await h.execute({id: 10, mailbox_id: 1, email: "a@gmail.com", kind: "2fa"});

    assert.equal(h.completed[0][1], false);
    assert.match(h.completed[0][2], /其他实例/);
});

test("代理基础设施故障将整备任务退回队列而不是标失败", async () => {
    const h = createHarness({
        services: {
            changePassword: async () => ({ok: true}),
            changeTotp: async () => ({ok: true}),
            harden: async () => ({ok: false, error: "proxy-down"}),
            parkForBitDown: async () => {},
        },
    });
    await h.execute({id: 10, mailbox_id: 1, email: "a@gmail.com", kind: "harden"});

    assert.deepEqual(h.requeued, [[10, "跳板/代理异常，退回排队"]]);
    assert.equal(h.completed.length, 0);
});

test("无论任务结果如何都释放本机运行态并触发补位", async () => {
    const h = createHarness();
    await h.execute({id: 10, mailbox_id: 1, email: "a@gmail.com", kind: "harden"});

    assert.equal(h.localMailboxIds.size, 0);
    assert.equal(h.abortControllers.size, 0);
    assert.equal(h.current.size, 0);
    assert.equal(h.nextRuns(), 1);
});
