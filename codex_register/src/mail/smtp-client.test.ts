import assert from "node:assert/strict";
import test from "node:test";
import {buildSmtpMime} from "./smtp-client.js";

test("SMTP MIME 同时保留纯文本、HTML 和点号转义", () => {
    const mime = buildSmtpMime({
        from: "sender@mail.com",
        to: ["a@example.com", "b@example.com"],
        subject: "测试主题",
        text: ".第一行\n正文",
        html: "<p>正文</p>",
        fromName: "测试发件人",
    });
    assert.match(mime, /From: =?\?UTF-8\?B\?/);
    assert.match(mime, /To: a@example\.com, b@example\.com/);
    assert.match(mime, /Subject: =\?UTF-8\?B\?/);
    assert.match(mime, /\r\n\.\.第一行\r\n/);
    assert.match(mime, /Content-Type: text\/html; charset=utf-8/);
});
