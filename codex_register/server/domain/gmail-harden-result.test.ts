import assert from "node:assert/strict";
import test from "node:test";
import {createGmailHardenResultApplier} from "./gmail-harden-result.js";

function createHarness(mailbox) {
    const passwords = [];
    const statuses = [];
    const totps = [];
    const updates = [];
    const googleStates = [];
    const apply = createGmailHardenResultApplier({
        now: () => new Date(2026, 7, 19, 10, 30).getTime(),
        store: {
            setPassword: async (...args) => { passwords.push(args); },
            setPasswordStatus: async (...args) => { statuses.push(args); },
            commitTotp: async (...args) => { totps.push(args); return {ok: true}; },
            applyUpdate: async (...args) => { updates.push(args); },
            refreshGoogleState: async (...args) => { googleStates.push(args); },
        },
    });
    return {apply: (result) => apply(mailbox.id, mailbox, result), passwords, statuses, totps, updates, googleStates};
}

test("整备成功时原子写入密码、TOTP、IMAP 和完成状态", async () => {
    const mailbox = {id: 1, email: "a@gmail.com", totp_secret: "old", google_state: {}};
    const h = createHarness(mailbox);
    await h.apply({
        ok: true,
        passwordChanged: true,
        password: "new-password",
        totpChanged: true,
        totpSecret: "new-totp",
        imapPassword: "imap-password",
        recoveryCleared: true,
    });

    assert.deepEqual(h.passwords[0], [1, "new-password", "✅整备 08-19 10:30"]);
    assert.deepEqual(h.totps[0], [1, "new-totp", "old"]);
    assert.equal(h.updates[0][1].imap_password, "imap-password");
    assert.equal(h.googleStates[0][1].login, "ok");
    assert.equal(h.googleStates[0][1].imap, "ok");
    assert.equal(h.googleStates[0][1].totp_rotated, true);
});

test("Google 拒发应用密码时递增失败计数并设置线性退避", async () => {
    const now = new Date(2026, 7, 19, 10, 30).getTime();
    const mailbox = {id: 1, email: "a@gmail.com", google_state: {imap_gen_fail: 1}};
    const h = createHarness(mailbox);
    await h.apply({ok: false, errors: ["拒绝生成应用密码"]});

    const state = h.googleStates[0][1];
    assert.equal(state.imap_gen_fail, 2);
    assert.equal(state.imap_next_try, now + 90 * 60 * 1000);
    assert.equal(state.imap, "fail");
});

test("已有可用 2FA 和 IMAP 的邮箱部分失败时不降级密码状态", async () => {
    const mailbox = {
        id: 1,
        email: "a@gmail.com",
        imap_password: "imap",
        pw_status: "",
        google_state: {totp_rotated: true},
    };
    const h = createHarness(mailbox);
    await h.apply({ok: false, error: "页面超时"});

    assert.equal(h.statuses.length, 0);
    assert.notEqual(h.googleStates[0][1].login, "fail");
});
