import assert from "node:assert/strict";
import test from "node:test";
import {createOperationLogService} from "./operation-log-service.js";

test("账号与邮箱日志使用独立存储和 SSE 事件", async () => {
    const stored: string[] = [];
    const events: string[] = [];
    const logs = createOperationLogService({
        store: {
            appendAccount: async () => { stored.push("account"); },
            appendMailbox: async () => { stored.push("mailbox"); },
        },
        publish: (event) => events.push(event),
        now: () => 1,
    });
    logs.account(1, "a");
    logs.mailbox(2, "b");
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(stored, ["account", "mailbox"]);
    assert.deepEqual(events, ["log", "mbLog"]);
});
