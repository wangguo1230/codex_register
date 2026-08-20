import assert from "node:assert/strict";
import test from "node:test";
import {createGmailRebindReconciler} from "./gmail-rebind-reconciler.js";

function createHarness(currentResult) {
    const updates = [];
    const released = [];
    const rebound = [];
    const notes = [];
    const leaseReleases = [];
    const reconciler = createGmailRebindReconciler({
        instanceId: "instance-1",
        claimRows: async () => [],
        claimSelectedRows: async () => [queueItem],
        releaseRows: async (ids) => { leaseReleases.push(...ids); },
        getAccount: async () => ({id: 9, email: "old@example.com"}),
        updateQueueItem: async (id, value) => { updates.push({id, value}); },
        rebindGptMailbox: async (accountId, mailboxId) => { rebound.push({accountId, mailboxId}); },
        setMailboxNote: async (mailboxId, note) => { notes.push({mailboxId, note}); },
        releaseMailboxToFree: async (mailboxId) => { released.push(mailboxId); },
        currentLoginEmailOf: async () => currentResult,
    });
    return {reconciler, updates, released, rebound, notes, leaseReleases};
}

const queueItem = {
    id: 7,
    account_id: 9,
    email: "old@example.com",
    rebind_attempt_email: "target@gmail.com",
    rebind_attempt_mailbox_id: 11,
};

test("官方邮箱不可读时保持 unknown 且不释放目标邮箱", async () => {
    const h = createHarness({ok: false, email: "", reason: "timeout"});
    assert.equal(await h.reconciler.reconcileOne(queueItem), "unknown");
    assert.equal(h.released.length, 0);
    assert.equal(h.rebound.length, 0);
    assert.match(h.updates[0].value.rebind_error, /对账未定论/);
    assert.equal(h.updates[0].value.rebind_status, undefined);
});

test("官方邮箱已变更时补齐账号指针并标记成功", async () => {
    const h = createHarness({ok: true, email: "target@gmail.com"});
    assert.equal(await h.reconciler.reconcileOne(queueItem), "ok");
    assert.deepEqual(h.rebound, [{accountId: 9, mailboxId: 11}]);
    assert.equal(h.released.length, 0);
    assert.equal(h.updates[0].value.rebind_status, "ok");
    assert.equal(h.updates[0].value.rebind_from, "old@example.com");
});

test("官方确认未换绑时才释放目标邮箱并标记失败", async () => {
    const h = createHarness({ok: true, email: "old@example.com"});
    assert.equal(await h.reconciler.reconcileOne(queueItem), "fail");
    assert.deepEqual(h.released, [11]);
    assert.deepEqual(h.notes, [{mailboxId: 11, note: ""}]);
    assert.equal(h.updates[0].value.rebind_status, "fail");
});

test("手工指定对账先认领并在完成后释放", async () => {
    const h = createHarness({ok: false, email: "", reason: "timeout"});
    const result = await h.reconciler.reconcileSelected([queueItem.id]);

    assert.equal(result.done, 1);
    assert.deepEqual(result.claimedIds, [queueItem.id]);
    assert.deepEqual(h.leaseReleases, [queueItem.id]);
});
