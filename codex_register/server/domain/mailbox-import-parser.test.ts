import assert from "node:assert/strict";
import test from "node:test";
import {extractMailboxEmails, parseMailboxAccounts} from "./mailbox-import-parser.js";

test("解析邮箱密码并保留辅助邮箱与 TOTP 字段", () => {
    const rows = parseMailboxAccounts("A@Example.com----pw----backup@example.com----SECRET", {
        straighten: (value) => value,
    });

    assert.deepEqual(rows, [{
        email: "a@example.com",
        password: "pw",
        recovery_email: "backup@example.com",
        totp_secret: "SECRET",
    }]);
});

test("提取混合文本中的邮箱并去重", () => {
    const emails = extractMailboxEmails("A@example.com----pw\ntext b@example.com and A@example.com");

    assert.deepEqual(emails, ["a@example.com", "b@example.com"]);
});
