import assert from "node:assert/strict";
import test from "node:test";
import {createGmailMaintenanceService} from "./gmail-maintenance-service.js";

test("换 2FA 在邮箱级互斥锁内执行并透传代理租约", async () => {
    const order = [];
    const service = createGmailMaintenanceService({
        withMailboxLock: async (id, task) => { order.push(`lock:${id}`); return task(); },
        withProxy: async (_owner, task) => {
            order.push("lease");
            return task("socks5://exit", "socks5://jump", () => {});
        },
        runWorker: async (task) => { order.push(`worker:${task.kind}`); return {ok: true, totpSecret: "secret"}; },
        maskProxy: (value) => value,
    });

    const result = await service.changeTotp({id: 1, email: "a@gmail.com"}, () => {});
    assert.equal(result.ok, true);
    assert.deepEqual(order, ["lock:1", "lease", "worker:totp"]);
});
