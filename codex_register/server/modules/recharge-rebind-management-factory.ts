// @ts-nocheck
// 换绑管理服务装配：池管理、手工对账和管理面板所需的适配器。
import {createGmailRebindManagementService} from "../domain/gmail-rebind-management-service.js";
import {testGmailImap, isImapTransientError} from "../../src/mail/google-imap.js";
import {
    normalizeRebindTarget,
    rebindTargetLabel,
    resolveRebindTarget,
    normalizeRebindPool,
    rebindPoolHint,
} from "../domain/gmail-rebind-policy.js";

export function createRechargeRebindManagement({
    db,
    mailboxPrecheck,
    queue,
    reconciler,
    runPool,
    extractEmails,
    syncQueue,
    log,
    scheduler,
} = {}) {
    return createGmailRebindManagementService({
        store: {
            poolGroup: db.REBIND_GMAIL_POOL_GRP,
            listPool: () => db.listRebindGmailPool(),
            getMailbox: (id) => db.getMailbox(id),
            getMailboxes: (ids) => db.getMailboxes(ids),
            moveToPool: (ids) => db.moveMailboxesToRebindPool(ids),
            moveFromPool: (ids, group) => db.moveMailboxesFromRebindPool(ids, group),
            markUnavailable: (ids, reason) => db.markRebindGmailUnavailable(ids, reason),
            quarantine: (id, reason) => db.quarantineMailbox(id, reason),
            refreshGoogleState: (id, state) => db.refreshMailboxGoogleState(id, state),
            countFreeGoogleImap: () => db.countFreeGoogleImapMailboxes(),
            countFreeMailcom: () => db.countFreeMailcomMailboxes(),
            getQueue: (id) => db.getRechargeQueueItem(id),
            getQueues: (ids) => db.getRechargeQueueItems(ids),
            updateQueue: (id, updates) => db.updateQueueItem(id, updates),
            cancelUnclaimed: (id) => db.cancelUnclaimedGmailRebind(id),
            countReconcile: () => db.countRebindReconcile(),
        },
        probes: {
            imap: testGmailImap,
            login: mailboxPrecheck.probeWebLogin,
            isImapTransient: isImapTransientError,
            isImapAuthDead: mailboxPrecheck.isImapAuthDead,
        },
        queue: {has: queue.has, enqueue: queue.enqueue, cancel: queue.cancel},
        reconcile: {selected: reconciler.reconcileSelected, pump: reconciler.pump},
        policy: {
            normalizeTarget: normalizeRebindTarget,
            normalizePool: normalizeRebindPool,
            extractEmails,
            resolveTarget: resolveRebindTarget,
            poolHint: rebindPoolHint,
            targetLabel: rebindTargetLabel,
        },
        runPool,
        concurrency: () => scheduler.rebindConcurrency || scheduler.rechargeConcurrency || 3,
        effects: {log, syncQueue},
        defaultTarget: () => scheduler.rebindAfterPaid,
    });
}
