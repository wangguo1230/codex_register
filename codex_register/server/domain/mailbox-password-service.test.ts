import assert from "node:assert/strict";
import test from "node:test";
import {createMailboxPasswordService, formatMailboxPasswordStamp} from "./mailbox-password-service.js";

function createHarness(provider, overrides = {}) {
    const writes = [];
    const fingerprints = [];
    let gmailCalls = 0;
    let mailcomCalls = 0;
    const mailbox = {id: 1, email: "a@example.com", provider, password: "old-pw", browser_fp: {seed: "a"}};
    const change = createMailboxPasswordService({
        store: {
            getMailbox: async () => mailbox,
            setPassword: async (...args) => { writes.push(args); },
            setBrowserFingerprint: async (...args) => { fingerprints.push(args); },
        },
        gmailMaintenance: {
            changePassword: async () => { gmailCalls++; return {ok: true, verified: true}; },
        },
        withProxy: async (_owner, task) => task("socks5://exit", "socks5://jump"),
        changeMailcomPassword: async () => { mailcomCalls++; return {ok: true, verified: true}; },
        ensureMailcomProfile: () => ({timezoneId: "America/New_York"}),
        randomPassword: () => "random-password",
        sessionOf: () => "session-1",
        maskProxy: (value) => value,
        stamp: () => "08-19 10:30",
        ...overrides,
    });
    return {change, mailbox, writes, fingerprints, gmailCalls: () => gmailCalls, mailcomCalls: () => mailcomCalls};
}

test("Gmail 改密委托维护 Worker 并写入已验证状态", async () => {
    const h = createHarness("google");
    const result = await h.change(1, h.mailbox.email, "old-pw", "new-pw");

    assert.equal(result.ok, true);
    assert.equal(h.gmailCalls(), 1);
    assert.equal(h.mailcomCalls(), 0);
    assert.deepEqual(h.writes[0], [1, "new-pw", "✅已改 08-19 10:30(验证)"]);
});

test("mail.com 改密复用代理并持久化浏览器指纹", async () => {
    const h = createHarness("mailcom");
    const result = await h.change(1, h.mailbox.email, "old-pw", "new-pw");

    assert.equal(result.ok, true);
    assert.equal(h.mailcomCalls(), 1);
    assert.equal(h.fingerprints.length, 1);
    assert.equal(h.writes[0][1], "new-pw");
});

test("真实改密失败时保留数据库中的当前密码并记录候选密码", async () => {
    const h = createHarness("mailcom", {
        changeMailcomPassword: async () => ({ok: false, detail: "form rejected"}),
    });
    const result = await h.change(1, h.mailbox.email, "old-pw", "candidate-pw");

    assert.equal(result.ok, false);
    assert.equal(h.writes[0][1], "old-pw");
    assert.match(h.writes[0][2], /candidate-pw/);
});

test("默认改密时间格式保持月日时分契约", () => {
    assert.equal(formatMailboxPasswordStamp(new Date(2026, 7, 9, 6, 5)), "08-09 06:05");
});
