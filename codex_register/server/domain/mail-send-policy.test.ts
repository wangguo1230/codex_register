import assert from "node:assert/strict";
import test from "node:test";
import {buildTestMailContent, refundSenderOf} from "./mail-send-policy.js";

test("换绑后退款发信始终使用原邮箱", () => {
    assert.equal(refundSenderOf({email: "new@gmail.com", rebind_from: "old@mail.com", rebind_status: "ok"}), "old@mail.com");
    assert.equal(refundSenderOf({email: "new@gmail.com", rebind_status: "ok"}), "");
    assert.equal(refundSenderOf({email: "same@mail.com", rebind_status: ""}), "same@mail.com");
});

test("测试邮件 HTML 转义发件人与收件人", () => {
    const mail = buildTestMailContent({from: "<from@mail.com", to: "<to@example.com", subject: "subject"});
    assert.equal(mail.subject, "subject");
    assert.match(mail.html, /&lt;from@mail\.com/);
    assert.match(mail.html, /&lt;to@example\.com/);
});
