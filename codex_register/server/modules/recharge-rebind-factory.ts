// @ts-nocheck
// 充值后换绑子系统装配：排队、执行、对账和管理服务。
import {
    needsPwdReauth,
    rebindNeedsFreshLogin,
    pwdAuthLeftMs,
    isSessionJsonAlive,
    fetchCurrentLoginEmail,
} from "../../src/change-email.js";
import {rememberGoogleCred} from "../../src/mail/google-account.js";
import {rememberMailcomPassword} from "../../src/mail/mailcom.js";
import {maskProxyUrl} from "../../src/mail/proxy-pool.js";
import {enrollTotp} from "../../src/mfa.js";
import {createGmailRebindChangeWorker} from "../domain/gmail-rebind-change-worker.js";
import {createGmailRebindQueueService} from "../domain/gmail-rebind-queue-service.js";
import {createRebindMailboxClaimer} from "../domain/gmail-rebind-mailbox-claimer.js";
import {createGmailRebindAuthService} from "../domain/gmail-rebind-auth-service.js";
import {createCurrentLoginEmailResolver} from "../domain/gmail-current-login-email.js";
import {createGmailRebindReconciler} from "../domain/gmail-rebind-reconciler.js";
import {createGmailRebindExecutor} from "../domain/gmail-rebind-executor.js";
import {createRechargeRebindManagement} from "./recharge-rebind-management-factory.js";
import {
    normalizeRebindTarget,
    rebindTargetLabel,
    resolveRebindTarget,
    normalizeRebindPool,
    rebindPoolHint,
    formatRebindUntil,
} from "../domain/gmail-rebind-policy.js";
import {isGoogleMailbox} from "../domain/account-credential-format.js";
import {isAuthorizeRateLimited} from "../domain/account-relogin-runner.js";
import {pickXrayBrowserProxy} from "../xray-proxy.js";
import {createPersistentTaskWorker} from "../domain/persistent-task-worker.js";
import {createMailProxyLease} from "../domain/mail-proxy-lease.js";
import {mailJumpPool, mailProxyPool, JUMP_MAX_EXITS} from "../../src/mail/proxy-pool.js";

export function createRechargeRebindFactory({
    db,
    scheduler,
    token,
    rechargeProxy,
    mailboxPrecheck,
    getAuthData,
    getRtData,
    extractEmails,
    syncQueue,
    runPool,
    log,
    broadcast,
    isRecoveryRunning = () => false,
    isExportRunning = () => false,
} = {}) {
    const liveMailboxIds = new Set();
    const changeEmailTimeoutMs = Math.max(240_000, Number(process.env.CHANGE_EMAIL_TIMEOUT_MS || 600_000));
    const capCooldownMs = Math.max(60_000, Number(process.env.REBIND_CAP_COOLDOWN_MS || 24 * 3600_000 + 300_000));
    const withLeasedImapProxy = createMailProxyLease({
        proxyPool: mailProxyPool,
        jumpPool: mailJumpPool,
        getFallbackProxy: () => scheduler.mailProxyFallback(),
        getFallbackJump: () => scheduler.mailProxyJump || "",
        getMaxPerTemplate: () => Math.max(1, Math.min(8, scheduler.rebindConcurrency || scheduler.rechargeConcurrency || 3)),
        maxPerJump: JUMP_MAX_EXITS,
    });
    const changeEmail = createGmailRebindChangeWorker({
        root: token.rootDir,
        tsxBin: token.tsxBin,
        timeoutMs: changeEmailTimeoutMs,
        pickProxy: () => pickXrayBrowserProxy(rechargeProxy(), scheduler.rtProxy, scheduler.regProxy),
        maskProxy: maskProxyUrl,
        leaseImapProxy: scheduler.proxyPoolEnabled("mail") ? withLeasedImapProxy : null,
    });

    let executeRebind;
    let rebindWorker = null;
    let pumpReconcile = async () => {};
    const requestReconcile = () => {
        void pumpReconcile().catch((error) => {
            log(`换绑对账后台异常: ${String(error?.message || error).slice(0, 160)}`);
        });
    };
    const queue = createGmailRebindQueueService({
        concurrency: () => scheduler.rebindConcurrency || scheduler.rechargeConcurrency || 3,
        execute: (queueId, _metadata, context) => executeRebind(queueId, context),
        store: {
            updateQueue: (id, updates) => db.updateQueueItem(id, updates),
            scheduleQueue: (id, options) => db.scheduleGmailRebind(id, options),
        },
        getTaskWorker: () => rebindWorker,
        cancelTask: (id) => db.cancelWorkTask("gmail_rebind", id),
        policy: {
            resolveTarget: resolveRebindTarget,
            normalizePool: normalizeRebindPool,
            targetLabel: rebindTargetLabel,
            formatUntil: formatRebindUntil,
        },
        poolGroup: db.REBIND_GMAIL_POOL_GRP,
        defaultTarget: () => scheduler.rebindAfterPaid,
        extractEmails,
        effects: {log, syncQueue, reconcile: requestReconcile},
        isRecoveryRunning,
        isExportRunning,
    });

    const claimMailbox = createRebindMailboxClaimer({
        listGmailCandidates: (options) => db.listRebindGmailCandidates(options),
        claimGmail: (mailboxId, options) => db.claimMailboxForRebind(mailboxId, options),
        claimMailcom: () => db.claimFreeMailcomMailbox(),
        explainGmailMiss: (emails) => db.explainRebindGmailMiss(emails),
        releaseMailbox: (mailboxId) => db.releaseMailboxToFree(mailboxId),
        markGmailUnavailable: (ids, reason) => db.markRebindGmailUnavailable(ids, reason),
        quarantineMailbox: (id, reason) => db.quarantineMailbox(id, reason),
        refreshGoogleState: (id, state) => db.refreshMailboxGoogleState(id, state),
        probeGmailLogin: mailboxPrecheck.probeRebindLogin,
        shouldProbeGmailLogin: () => scheduler.rebindGmailProbeLogin === true,
        poolHintOf: rebindPoolHint,
        liveMailboxIds,
        log,
    });
    const auth = createGmailRebindAuthService({
        getAccount: (id) => db.getAccount(id),
        updateAccount: (id, updates) => db.updateAccount(id, updates),
        getAuthData,
        extractTokens: token.extractTokens,
        isSessionAlive: isSessionJsonAlive,
        needsFreshLogin: rebindNeedsFreshLogin,
        pwdAuthLeftMs,
        needsPwdReauth,
        isGoogleMailbox,
        rememberGoogleCredentials: rememberGoogleCred,
        rememberMailcomPassword,
        relogin: token.runRelogin,
        reloginIdleMs: () => 90_000,
        enrollTotp,
        rechargeProxy,
        browserFallback: () => process.env.MFA_NO_BROWSER !== "1",
        log,
    });
    const currentLoginEmailOf = createCurrentLoginEmailResolver({
        pickProxy: () => pickXrayBrowserProxy(rechargeProxy(), scheduler.rtProxy, scheduler.regProxy),
        getAuthData,
        getRtData,
        extractTokens: token.extractTokens,
        fetchCurrentLoginEmail,
        refreshRt: token.refreshRtViaPool,
        relogin: token.runRelogin,
        getAccount: (id) => db.getAccount(id),
        log,
    });
    const reconciler = createGmailRebindReconciler({
        instanceId: db.instanceId,
        claimRows: (limit, instanceId) => db.claimRebindReconcile(limit, instanceId),
        claimSelectedRows: (ids, instanceId) => db.claimRebindReconcileItems(ids, instanceId),
        releaseRows: (ids, instanceId) => db.releaseRebindReconcile(ids, instanceId),
        getAccount: (id) => db.getAccount(id),
        updateQueueItem: (id, updates) => db.updateQueueItem(id, updates),
        rebindGptMailbox: (accountId, mailboxId) => db.rebindGptMailbox(accountId, mailboxId),
        completeRebind: (queueId, accountId, mailboxId, details) => db.completeGmailRebind(
            queueId,
            accountId,
            mailboxId,
            details,
            db.instanceId,
        ),
        setMailboxNote: (mailboxId, note) => db.setMailboxNote(mailboxId, note),
        releaseMailboxToFree: (mailboxId) => db.releaseMailboxToFree(mailboxId),
        currentLoginEmailOf,
        sync: syncQueue,
        log,
    });
    pumpReconcile = reconciler.pump;
    executeRebind = createGmailRebindExecutor({
        queueStore: {
            claimExecution: (id) => db.claimRebindExecution(id, db.instanceId),
            releaseExecution: (id) => db.releaseRebindExecution(id, db.instanceId),
            update: (id, updates) => db.updateQueueItem(id, updates),
            markAttempt: (id, attempt) => db.markRebindAttempt(id, attempt),
        },
        accountStore: {
            get: (id) => db.getAccount(id),
            rebindMailbox: (accountId, mailboxId) => db.rebindGptMailbox(accountId, mailboxId),
            completeRebind: (queueId, accountId, mailboxId, details) => db.completeGmailRebind(
                queueId,
                accountId,
                mailboxId,
                details,
                db.instanceId,
            ),
        },
        mailboxStore: {
            release: (id) => db.releaseMailboxToFree(id),
            setNote: (id, note) => db.setMailboxNote(id, note),
            quarantine: (id, reason) => db.quarantineMailbox(id, reason),
            refreshGoogleState: (id, state) => db.refreshMailboxGoogleState(id, state),
        },
        authService: auth,
        claimMailbox,
        changeEmail,
        currentLoginEmailOf,
        credentialStore: {isGoogleMailbox, rememberGoogle: rememberGoogleCred, rememberMailcom: rememberMailcomPassword},
        policy: {
            normalizeTarget: normalizeRebindTarget,
            targetLabel: rebindTargetLabel,
            isRateLimited: isAuthorizeRateLimited,
            capCooldownMs,
            formatUntil: formatRebindUntil,
        },
        runtime: {
            isCancelled: queue.isCancelled,
            getMetadata: queue.getMetadata,
            liveMailboxIds,
        },
        effects: {
            log,
            syncQueue,
            scheduleReconcile: requestReconcile,
            syncSuccess: async () => {
                try {
                    broadcast("snapshot", await db.listAccounts());
                    broadcast("stats", await db.stats());
                    broadcast("mailboxes", {stats: await db.mailboxStats()});
                    broadcast("rebind-pool", {
                        gmailFreeImap: await db.countFreeGoogleImapMailboxes(),
                        mailcomFree: await db.countFreeMailcomMailboxes(),
                    });
                } catch { /* 面板刷新失败不影响换绑 */ }
            },
        },
        getAuthData,
    });

    rebindWorker = createPersistentTaskWorker({
        kind: "gmail_rebind",
        instanceId: db.instanceId,
        concurrency: () => scheduler.rebindConcurrency || scheduler.rechargeConcurrency || 3,
        claim: (limit, leaseMs) => db.claimWorkTasks("gmail_rebind", db.instanceId, limit, leaseMs),
        heartbeat: (task, leaseMs) => db.heartbeatWorkTask(task.id, db.instanceId, task.lease_token, leaseMs),
        complete: (task, result) => db.completeWorkTask(task.id, db.instanceId, task.lease_token, result),
        fail: (task, error) => db.failWorkTask(task.id, db.instanceId, task.lease_token, error),
        release: (task, reason) => db.releaseWorkTask(task.id, db.instanceId, task.lease_token, reason),
        cancel: (task) => db.cancelWorkTask("gmail_rebind", task.entity_id),
        execute: (task, context) => executeRebind(task.entity_id, {
            ...context,
            metadata: typeof task.payload === "string" ? JSON.parse(task.payload || "{}") : (task.payload || {}),
        }),
        onTaskStart: queue.onTaskStart,
        onTaskFinish: queue.onTaskFinish,
        onChange: (state) => {
            if (state.error) log(`换绑分布式 worker 拉取失败: ${String(state.error?.message || state.error).slice(0, 140)}`);
        },
    });

    const management = createRechargeRebindManagement({
        db,
        mailboxPrecheck,
        queue,
        reconciler: {...reconciler, pump: pumpReconcile},
        runPool,
        extractEmails,
        syncQueue,
        log,
        scheduler,
    });

    return {
        queue,
        worker: rebindWorker,
        enqueue: queue.enqueue,
        reconciler,
        management,
        liveMailboxIds,
        pumpReconcile,
    };
}
