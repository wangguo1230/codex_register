// @ts-nocheck
// 充值操作工厂：卡密分配、提交、重登提交和平台状态轮询。
import {createRechargeBatchRuntime} from "../domain/recharge-batch-runtime.js";
import {createRechargeCardRecovery} from "../domain/recharge-card-recovery.js";
import {createRechargeCardAllocator} from "../domain/recharge-card-allocator.js";
import {createRechargeSubmitter} from "../domain/recharge-submitter.js";
import {createRechargeTaskReconciler} from "../domain/recharge-task-reconciler.js";
import {createRechargePollService} from "../domain/recharge-poll-service.js";
import {createRechargeReloginService} from "../domain/recharge-relogin-service.js";
import {createRechargeSubmitService} from "../domain/recharge-submit-service.js";
import {
    cardBoundToOtherAccount,
    describeCardAllocationFailure,
    isPlatformFlagOn,
} from "../domain/recharge-card-policy.js";
import {isAccountDeadReason, isAuthorizeRateLimited} from "../domain/account-relogin-runner.js";
import {createRechargePollWorker} from "./recharge-poll-worker-factory.js";
import {createRechargeReloginSubmitWorker} from "./recharge-relogin-submit-worker-factory.js";
import {createRechargeSubmitWorker} from "./recharge-submit-worker-factory.js";

export function createRechargeOperationFactory({
    db,
    scheduler,
    token,
    credentialFiles,
    runtime,
    mailboxPrecheck,
    callApi,
    getAuthData,
    extractSession,
    enqueueGmailRebind,
    broadcastJobs,
    syncQueue,
    runPool,
    log,
    isRecoveryRunning = () => false,
} = {}) {
    const isExportRunning = () => runtime.jobState().exportRt === true;
    const intervalSeconds = () => {
        const value = Number(scheduler.rechargeInterval);
        return Number.isFinite(value) ? Math.max(0, Math.min(60, value)) : 5;
    };
    const isRechargeApiConfigured = () => !!String(scheduler.rechargeBaseUrl || "").trim()
        && !!String(scheduler.rechargeApiKey || "").trim();
    const rechargeLockStuckMs = Math.max(60_000, Number(process.env.RECHARGE_LOCK_STUCK_MS || 30 * 60_000));
    const rechargeBatch = createRechargeBatchRuntime({onChange: broadcastJobs});
    const reviveErrorCards = createRechargeCardRecovery({
        listCards: () => db.listRechargeCards(),
        listErrorCards: () => db.listErrorRechargeCards(),
        validateCard: async (code) => (await callApi("POST", "/redeem-codes/validate", {redeem_code: code})).result || {},
        unpairCards: (ids) => db.unpairRechargeCards(ids),
        isAllowed: isPlatformFlagOn,
        isRateLimited: isAuthorizeRateLimited,
        log,
    });
    const lockCard = async (cardId, error) => {
        if (!cardId) return;
        await db.updateRechargeCard(cardId, {status: "error", error: String(error || "提交失败，锁定不复用").slice(0, 200)});
    };
    const takeReusableCard = createRechargeCardAllocator({
        isStopped: rechargeBatch.isStopped,
        claimUnusedCards: (count, options) => db.claimUnusedCards(count, options),
        reviveErrorCards,
        validateCard: async (code) => (await callApi("POST", "/redeem-codes/validate", {redeem_code: code})).result || {},
        unpairCards: (ids) => db.unpairRechargeCards(ids),
        lockCard,
        cardBoundToOtherAccount,
        isRateLimited: isAuthorizeRateLimited,
        log,
    });
    const submitOne = createRechargeSubmitter({
        getAccount: (id) => db.getAccount(id),
        getAuthData,
        readAuthFile: credentialFiles.readJson,
        extractSession,
        callApi,
        updateQueueItem: (id, updates) => db.updateQueueItem(id, updates),
        updateRechargeCard: (id, updates) => db.updateRechargeCard(id, updates),
        beginSubmission: (queueId, cardId) => db.beginRechargeSubmission(queueId, cardId, db.instanceId),
        cancelSubmission: (queueId, cardId) => db.cancelPairedRechargeSubmission(queueId, cardId, db.instanceId, {allowSubmitting: true}),
        completeSubmission: (queueId, cardId, task) => db.completeRechargeSubmission(queueId, cardId, task, db.instanceId),
        failSubmission: (queueId, cardId, failure) => db.failRechargeSubmission(queueId, cardId, failure, db.instanceId),
        markSubmissionUnknown: (queueId, cardId, message) => db.markRechargeSubmissionUnknown(queueId, cardId, message, db.instanceId),
        cardBoundToOtherAccount,
        onPaid: enqueueGmailRebind,
        onSubmitted: (item) => db.enqueueWorkTask("recharge_poll", item.id, {}, {
            priority: 0,
            availableAt: Date.now() + Math.max(1_000, intervalSeconds() * 1000),
        }),
        log,
    });
    const reconcileSubmitted = createRechargeTaskReconciler({
        lookupTasks: (codes) => callApi("POST", "/tasks/lookup-batch", {redeem_codes: codes}),
        updateQueueItem: (id, updates) => db.updateQueueItem(id, updates),
        updateRechargeCard: (id, updates) => db.updateRechargeCard(id, updates),
        unpairRechargeCards: (ids) => db.unpairRechargeCards(ids),
        applyResult: (queueId, cardId, updates, options) => db.applyRechargeTaskResult(queueId, cardId, updates, options),
        onPaid: enqueueGmailRebind,
        log,
    });
    const rechargePoll = createRechargePollService({
        store: {
            get: (id) => db.getRechargeQueueItem(id),
            getMany: (ids) => db.getRechargeQueueItems(ids),
            listPending: () => db.listQueueSubmittedPending(),
            withLease: (task) => db.withRechargePollLease(task),
        },
        reconcile: reconcileSubmitted,
        runtime: {isStopped: rechargeBatch.isStopped},
        effects: {log, syncAll: runtime.flushAll || runtime.syncAll},
        hasApiKey: isRechargeApiConfigured,
        isRecoveryRunning,
    });
    const rechargePollWorker = createRechargePollWorker({db, scheduler, isConfigured: isRechargeApiConfigured, reconcile: reconcileSubmitted, syncQueue, log});
    let rechargeSubmit;
    const rechargeRelogin = createRechargeReloginService({
        instanceId: db.instanceId,
        batchRuntime: rechargeBatch,
        store: {
            claim: (ids, instanceId, options) => db.claimRechargeQueueItems(ids, instanceId, options),
            releaseByInstance: (instanceId, ids) => db.releaseRechargeQueueByInstance(instanceId, ids),
            getQueue: (id) => db.getRechargeQueueItem(id),
            getMany: (ids) => db.getRechargeQueueItems(ids),
            getAccount: (id) => db.getAccount(id),
            getCard: (id) => db.getRechargeCard(id),
            updateQueueAuth: (id, file, data) => db.updateQueueAuth(id, file, data),
            updateQueue: (id, updates) => db.updateQueueItem(id, updates),
            updateAccount: (id, updates) => db.updateAccount(id, updates),
            updateCard: (id, updates) => db.updateRechargeCard(id, updates),
            assignCard: (queueId, cardId, accountId, email, instanceId) => db.assignClaimedRechargeCard(queueId, cardId, accountId, email, instanceId),
            cancelPair: (queueId, cardId, instanceId) => db.cancelPairedRechargeSubmission(queueId, cardId, instanceId),
            enqueueTask: (queueId, options) => db.enqueueWorkTask("recharge_relogin_submit", queueId, {}, options),
            enqueueTasks: (items) => db.enqueueWorkTasks("recharge_relogin_submit", items.map((item) => ({
                entityId: item.entityId,
                payload: item.payload || {},
                priority: item.priority,
                availableAt: item.availableAt,
            }))),
        },
        relogin: token.runRelogin,
        credentials: {readAuth: getAuthData, extractSession},
        api: {call: callApi},
        cards: {
            takeReusable: takeReusableCard,
            failureReason: describeCardAllocationFailure,
            release: (ids) => db.unpairRechargeCards(ids),
        },
        submitOne,
        poll: rechargePoll,
        policy: {isAccountDeadReason},
        config: {
            intervalSeconds,
            isConfigured: isRechargeApiConfigured,
        },
        effects: {log, jobsChanged: broadcastJobs, syncQueue, syncAll: runtime.flushAll || runtime.syncAll, scheduleAll: runtime.scheduleAll},
        isSubmitRunning: () => rechargeSubmit?.isRunning?.() || rechargeBatch.isRunning(),
        isExportRunning,
        isRecoveryRunning,
    });
    const rechargeReloginSubmitWorker = createRechargeReloginSubmitWorker({db, scheduler, relogin: rechargeRelogin, log});
    rechargeRelogin.bindDistributedWorker(rechargeReloginSubmitWorker);
    rechargeSubmit = createRechargeSubmitService({
        instanceId: db.instanceId,
        runtime: rechargeBatch,
        store: {
            claim: (ids, instanceId) => db.claimRechargeQueueItems(ids, instanceId),
            release: (ids, instanceId) => db.releaseRechargeQueueItems(ids, instanceId),
            releaseByInstance: (instanceId, ids) => db.releaseRechargeQueueByInstance(instanceId, ids),
            get: (id) => db.getRechargeQueueItem(id),
            getMany: (ids) => db.getRechargeQueueItems(ids),
            getAccounts: (ids) => db.getAccounts(ids),
            getCard: (id) => db.getRechargeCard(id),
            unusedCardCount: () => db.rechargeUnusedCount(),
            updateQueue: (id, updates) => db.updateQueueItem(id, updates),
            updateCard: (id, updates) => db.updateRechargeCard(id, updates),
            assignCard: (queueId, cardId, accountId, email, instanceId) => db.assignClaimedRechargeCard(queueId, cardId, accountId, email, instanceId),
            cancelPair: (queueId, cardId, instanceId) => db.cancelPairedRechargeSubmission(queueId, cardId, instanceId),
            enqueueTask: (queueId, options) => db.enqueueWorkTask("recharge_submit", queueId, {}, options),
            enqueueTasks: (items) => db.enqueueWorkTasks("recharge_submit", items.map((item) => ({
                entityId: item.entityId,
                payload: item.payload || {},
                priority: item.priority,
                availableAt: item.availableAt,
            }))),
        },
        cards: {takeReusable: takeReusableCard, failureReason: describeCardAllocationFailure, release: (ids) => db.unpairRechargeCards(ids)},
        precheck: mailboxPrecheck.precheck,
        submitOne,
        poll: rechargePoll,
        runPool,
        config: {
            intervalSeconds,
            concurrency: () => scheduler.rechargeConcurrency || 3,
            baseUrl: () => scheduler.rechargeBaseUrl || "",
            isConfigured: isRechargeApiConfigured,
        },
        effects: {log, syncQueue, syncAll: runtime.flushAll || runtime.syncAll, scheduleAll: runtime.scheduleAll},
        isReloginRunning: rechargeRelogin.isRunning,
        isExportRunning,
        isRecoveryRunning,
        stuckMs: rechargeLockStuckMs,
    });
    const rechargeSubmitWorker = createRechargeSubmitWorker({db, scheduler, submit: rechargeSubmit, log});
    rechargeSubmit.bindDistributedWorker(rechargeSubmitWorker);

    return {
        batch: rechargeBatch,
        relogin: rechargeRelogin,
        submit: rechargeSubmit,
        submitWorker: rechargeSubmitWorker,
        reloginSubmitWorker: rechargeReloginSubmitWorker,
        pollWorker: rechargePollWorker,
        poll: rechargePoll,
    };
}
