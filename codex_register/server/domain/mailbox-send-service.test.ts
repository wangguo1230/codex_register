import assert from "node:assert/strict";
import test from "node:test";
import {createMailboxSendService} from "./mailbox-send-service.js";

function harness(mailbox, overrides: any = {}) {
    const logs: any[] = [];
    const mailboxLogs: string[] = [];
    const calls = {mailcom: [] as any[], gmail: [] as any[]};
    const send = createMailboxSendService({
        store: {
            getMailbox: async () => mailbox,
            getMailboxByEmail: async () => mailbox,
            insertLog: async (row) => { logs.push(row); },
            appendMailboxLog: async (_id, line) => { mailboxLogs.push(line); },
        },
        sendMailcom: async (opts) => { calls.mailcom.push(opts); return {ok: true, status: 202}; },
        sendGmail: async (opts) => { calls.gmail.push(opts); return {ok: true, status: 250}; },
        now: () => 123,
        ...overrides,
    });
    return {send, logs, mailboxLogs, calls};
}

test("mail.com 发信委托给代理池服务", async () => {
    const h = harness({id: 1, email: "sender@mail.com", provider: "mailcom", password: "pw"});
    const result = await h.send({mailboxId: 1, to: "to@example.com", subject: "subject", text: "body"});
    assert.equal(result.via, "mail.com");
    assert.equal(h.calls.mailcom.length, 1);
    assert.deepEqual(h.calls.mailcom[0].to, ["to@example.com"]);
    assert.equal(h.logs.length, 0);
});

test("Gmail 使用应用专用密码并写发送记录", async () => {
    const h = harness({id: 2, email: "sender@gmail.com", provider: "google", imap_password: "app pass"});
    const result = await h.send({mailboxId: 2, to: ["a@example.com", "b@example.com"], subject: "subject", text: "body"});
    assert.equal(result.via, "gmail-smtp");
    assert.equal(h.calls.gmail[0].appPassword, "app pass");
    assert.equal(h.logs[0].status, "sent");
    assert.equal(h.logs[0].to_email, "a@example.com,b@example.com");
    assert.match(h.mailboxLogs[0], /Gmail SMTP 成功/);
});

test("Gmail SMTP 发送可复用公共代理租约", async () => {
    const h = harness({id: 2, email: "sender@gmail.com", provider: "google", imap_password: "app pass"});
    const leases: string[] = [];
    const result = await h.send({
        mailboxId: 2,
        to: "a@example.com",
        subject: "subject",
        withProxy: async (_owner, task) => {
            leases.push("acquired");
            return task("socks5://exit.example:1080", "socks5://jump.example:1080");
        },
    });
    assert.equal(result.via, "gmail-smtp");
    assert.deepEqual(leases, ["acquired"]);
    assert.equal(h.calls.gmail[0].proxy, "socks5://exit.example:1080");
    assert.equal(h.calls.gmail[0].jump, "socks5://jump.example:1080");
    assert.equal(h.logs[0].proxy_url, "socks5://exit.example:1080");
    assert.equal(h.logs[0].jump_url, "socks5://jump.example:1080");
});

test("Gmail 缺少应用专用密码时拒绝发送", async () => {
    const h = harness({id: 2, email: "sender@gmail.com", provider: "google", imap_password: ""});
    await assert.rejects(() => h.send({mailboxId: 2, to: "a@example.com"}), /缺少 IMAP 应用专用密码/);
    assert.equal(h.calls.gmail.length, 0);
});

test("Gmail 发送失败写失败记录并保留原异常", async () => {
    const failure = new Error("smtp unavailable");
    const h = harness(
        {id: 2, email: "sender@gmail.com", provider: "google", imap_password: "app"},
        {sendGmail: async () => { throw failure; }},
    );
    await assert.rejects(() => h.send({mailboxId: 2, to: "a@example.com"}), failure);
    assert.equal(h.logs[0].status, "fail");
    assert.match(h.logs[0].error, /smtp unavailable/);
});
