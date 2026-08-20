import assert from "node:assert/strict";
import test from "node:test";
import {createGmailRebindManagementService} from "./gmail-rebind-management-service.js";

function createHarness({mailboxes = [], imap, login, queueItems = [], reconcileSelected, cancelResult, cancelUnclaimed} = {}) {
    const moved = [];
    const quarantined = [];
    const queued = [];
    let loginCalls = 0;
    const service = createGmailRebindManagementService({
        store: {
            poolGroup: "换绑池",
            listPool: async () => ({}),
            getMailbox: async (id) => mailboxes.find((item) => item.id === id),
            moveToPool: async (ids) => { moved.push(...ids); return {count: ids.length, skipped: []}; },
            moveFromPool: async () => 0,
            markUnavailable: async () => 0,
            quarantine: async (id) => { quarantined.push(id); },
            refreshGoogleState: async () => {},
            countFreeGoogleImap: async () => 1,
            countFreeMailcom: async () => 2,
            getQueue: async (id) => queueItems.find((item) => item.id === id),
            updateQueue: async () => {},
            cancelUnclaimed: cancelUnclaimed || (async () => true),
            countReconcile: async () => 0,
        },
        probes: {
            imap: imap || (async () => ({ok: true})),
            login: async (...args) => { loginCalls++; return login ? login(...args) : {ok: true}; },
            isImapTransient: (error) => /timeout/i.test(String(error)),
            isImapAuthDead: (error) => /auth/i.test(String(error)),
        },
        queue: {
            has: () => false,
            enqueue: (item) => { queued.push(item.id); return true; },
            cancel: () => cancelResult || ({found: false, active: false}),
        },
        reconcile: {
            selected: reconcileSelected || (async (ids) => ({done: ids.length, claimedIds: ids, failures: []})),
            pump: async () => {},
        },
        policy: {
            normalizeTarget: (value) => value || "gmail",
            normalizePool: () => ({}),
            extractEmails: () => [],
            resolveTarget: (_item, options) => options.target,
            poolHint: () => "",
            targetLabel: (value) => value,
        },
        runPool: async (items, worker) => Promise.all(items.map(worker)),
        effects: {log() {}, syncQueue: async () => {}},
        defaultTarget: () => "gmail",
    });
    return {service, moved, quarantined, queued, loginCalls: () => loginCalls};
}

test("默认迁入只并发探 IMAP，通一条立即迁入且不开网页登录", async () => {
    const h = createHarness({mailboxes: [
        {id: 1, email: "a@gmail.com", password: "pw", totp_secret: "totp", imap_password: "imap"},
        {id: 2, email: "b@gmail.com", password: "pw", totp_secret: "totp", imap_password: "imap"},
    ]});

    const result = await h.service.migrate([1, 2]);

    assert.deepEqual(h.moved.sort(), [1, 2]);
    assert.equal(h.loginCalls(), 0);
    assert.equal(result.count, 2);
});

test("IMAP 认证失败隔离邮箱，线路超时只保留为可重试", async () => {
    const mailboxes = [
        {id: 1, email: "a@gmail.com", password: "pw", totp_secret: "totp", imap_password: "imap"},
        {id: 2, email: "b@gmail.com", password: "pw", totp_secret: "totp", imap_password: "imap"},
    ];
    const h = createHarness({
        mailboxes,
        imap: async (email) => ({ok: false, error: email.startsWith("a") ? "AUTH failed" : "timeout"}),
    });

    const result = await h.service.migrate([1, 2]);

    assert.deepEqual(h.quarantined, [1]);
    assert.equal(result.skipped.length, 2);
    assert.deepEqual(h.moved, []);
});

test("只有已付费队列项进入换绑队列，已交付必须显式允许且只能换绑 Gmail", async () => {
    const h = createHarness({queueItems: [
        {id: 1, email: "paid@example.com", status: "done", task_status: "paid"},
        {id: 2, email: "pending@example.com", status: "pending", task_status: "queued"},
        {id: 3, email: "delivered@example.com", status: "done", task_status: "paid", delivery_status: "delivered"},
    ]});

    const result = await h.service.enqueue([1, 2], {target: "gmail"});

    assert.deepEqual(h.queued, [1]);
    assert.equal(result.queued, 1);
    assert.deepEqual(result.skipped, [{email: "pending@example.com", reason: "未付费(queued)"}]);

    const deliveredWithoutPermission = await h.service.enqueue([3], {target: "gmail"});
    assert.equal(deliveredWithoutPermission.queued, 0);
    assert.deepEqual(deliveredWithoutPermission.skipped, [{email: "delivered@example.com", reason: "已交付记录需明确开启人工换绑"}]);

    const deliveredMailcom = await h.service.enqueue([3], {target: "mailcom", allowDelivered: true});
    assert.equal(deliveredMailcom.queued, 0);
    assert.deepEqual(deliveredMailcom.skipped, [{email: "delivered@example.com", reason: "已交付记录仅支持人工换绑 Gmail"}]);

    const delivered = await h.service.enqueue([3], {target: "gmail", allowDelivered: true});
    assert.equal(delivered.queued, 1);
    assert.equal(h.queued.filter((id) => id === 3).length, 1);
});

test("手工对账只执行成功取得租约的行", async () => {
    const h = createHarness({
        queueItems: [
            {id: 1, email: "a@example.com", rebind_status: "unknown"},
            {id: 2, email: "b@example.com", rebind_status: "unknown"},
        ],
        reconcileSelected: async () => ({done: 1, claimedIds: [1], failures: []}),
    });

    const result = await h.service.reconcileNow([1, 2]);

    assert.equal(result.done, 1);
    assert.deepEqual(result.skipped, [{email: "b@example.com", reason: "已由其他实例认领或状态已变化"}]);
});

test("取消不会覆盖其他实例正在执行的换绑", async () => {
    const h = createHarness({
        queueItems: [{
            id: 3,
            email: "remote@example.com",
            rebind_status: "pending",
            rebind_instance: "server-b",
        }],
        cancelResult: {found: false, active: false},
        cancelUnclaimed: async () => false,
    });

    const result = await h.service.cancel([3]);

    assert.equal(result.count, 0);
    assert.deepEqual(result.skipped, [{email: "remote@example.com", reason: "已由实例 server-b 执行，无法跨实例中止"}]);
});
