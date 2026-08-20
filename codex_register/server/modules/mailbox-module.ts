// @ts-nocheck
// 邮箱模块装配：资源、代理、投递、改密、整备和共享任务队列。
import {straightenImportRow, looksLikeEmail} from "../../src/mfa.js";
import {isBitTransientError, isProxyInfraError} from "../../src/bitbrowser.js";
import {mailProxyPool, gptProxyPool, mailJumpPool, gptJumpPool, maskProxyUrl, toProxyImportLine, kookeeySessionOf, probeMailProxy, JUMP_MAX_EXITS} from "../../src/mail/proxy-pool.js";
import {randomPassword} from "../../src/utils.js";
import {formatHardenPartialError} from "../../src/mail/google-state.js";
import {ensureMailcomProfile} from "../../src/mail/mailcom-fingerprint.js";
import {
    fetchInboxList,
    fetchMailBodyFor,
    changeMailcomPassword,
    verifyMailcomLogin,
    stopMailcomBrowserWorkers,
} from "../domain/mailbox-service.js";
import {sendMailboxViaProvider, sendMailcomViaPool, sendMailcomBatch, listMailSendLogsPublic, previewDeliveredSend, startTestSendDelivered, getDeliveredSendJob, stopDeliveredSend} from "../domain/mail-send.js";
import {runGmailBrowserTask} from "../domain/gmail-browser-worker.js";
import {createMailProxyLease} from "../domain/mail-proxy-lease.js";
import {createGmailMaintenanceService} from "../domain/gmail-maintenance-service.js";
import {createGmailHardenResultApplier} from "../domain/gmail-harden-result.js";
import {createMailJobCoordinator} from "../domain/mail-job-coordinator.js";
import {createGmailHardenService} from "../domain/gmail-harden-service.js";
import {createMailboxPasswordService} from "../domain/mailbox-password-service.js";
import {createMailJobExecutor} from "../domain/mail-job-executor.js";
import {createMailCheckService} from "../domain/mail-check-service.js";
import {extractMailboxEmails, parseMailboxAccounts} from "../domain/mailbox-import-parser.js";
import {registerProxyRoutes, registerSharedProxyRoutes} from "../routes/proxy-routes.js";
import {registerMailDeliveryRoutes} from "../routes/mail-delivery-routes.js";
import {registerMailboxResourceRoutes} from "../routes/mailbox-resource-routes.js";
import {registerMailJobRoutes} from "../routes/mail-job-routes.js";
import {registerMailCheckRoutes} from "../routes/mail-check-routes.js";

export function createMailboxModule({
    app,
    db,
    scheduler,
    applicationState,
    broadcast,
    logMailbox,
    rechargeBridge,
    runPool,
} = {}) {
    const parseAccounts = (text, fallbackPassword) => parseMailboxAccounts(text, {
        separator: scheduler.mailSeparator,
        fallbackPassword,
        straighten: straightenImportRow,
        isEmail: looksLikeEmail,
    });
    const extractEmails = (text) => extractMailboxEmails(text, {separator: scheduler.mailSeparator});

    const withLeasedMailProxy = createMailProxyLease({
        proxyPool: mailProxyPool,
        jumpPool: mailJumpPool,
        getFallbackProxy: () => scheduler.mailProxyFallback(),
        getFallbackJump: () => scheduler.mailProxyJump || "",
        getMaxPerTemplate: () => Math.max(1, Math.min(8, scheduler.pwConcurrency || 1)),
        maxPerJump: JUMP_MAX_EXITS,
        setMailboxProxy: (id, url, ip) => db.setMailboxProxy(id, url, ip),
    });
    const gmailMaintenance = createGmailMaintenanceService({
        withProxy: withLeasedMailProxy,
        withMailboxLock: (id, task) => db.withMailboxWorkLock(id, task),
        runWorker: runGmailBrowserTask,
        maskProxy: maskProxyUrl,
    });
    const applyHardenResult = createGmailHardenResultApplier({
        store: {
            setPassword: (id, password, status) => db.setMailboxPassword(id, password, status),
            setPasswordStatus: (id, status) => db.setMailboxPwStatus(id, status),
            commitTotp: (id, secret, previous) => db.commitRotatedTotp(id, secret, previous),
            applyUpdate: (email, updates) => db.applyMailboxUpdate(email, updates),
            refreshGoogleState: (id, state) => db.refreshMailboxGoogleState(id, state),
        },
    });

    registerProxyRoutes(app, {
        domains: [
            {
                basePath: "/api/mailboxes",
                getProxyUrls: () => scheduler.mailProxyPool || [],
                getJump: () => scheduler.mailProxyJump || "",
                proxySnapshot: () => scheduler.publicProxyPoolSnap("mail"),
                jumpSnapshot: () => scheduler.publicJumpPoolSnapshot(),
                setProxyPool: (text, options) => scheduler.setMailProxyPool(text, options),
                setJump: (jump) => scheduler.setMailProxyJump(jump),
                applyPrimaryJump: () => scheduler.ensureJumpFleet(),
                setJumpPool: (urls) => scheduler.setMailJumpPool(urls),
                checkJumpPool: () => mailJumpPool.checkAll(),
                updateJumpForProbe: (jump) => { if (jump) scheduler.setMailProxyJump(jump); },
            },
            {
                basePath: "/api/gpt",
                getProxyUrls: () => scheduler.gptProxyPool || [],
                getJump: () => scheduler.gptProxyJump || "",
                proxySnapshot: () => scheduler.gptProxyPoolSnap(),
                jumpSnapshot: () => scheduler.publicJumpPoolSnapshot(),
                setProxyPool: (text, options) => scheduler.setGptProxyPool(text, options),
                setJump: (jump) => scheduler.setGptProxyJump(jump),
                applyPrimaryJump: (jump) => scheduler.setGptJumpPool(jump ? [jump] : []),
                setJumpPool: (urls) => scheduler.setGptJumpPool(urls),
                checkJumpPool: () => gptJumpPool.checkAll(),
                updateJumpForProbe: (jump, provided) => { if (provided) scheduler.setGptProxyJump(jump); },
            },
        ],
        toImportLine: toProxyImportLine,
        probeProxy: probeMailProxy,
        maskProxy: maskProxyUrl,
    });
    registerSharedProxyRoutes(app, {
        getPoolUrls: () => scheduler.proxyPool || [],
        toImportLine: toProxyImportLine,
        poolSnapshot: () => scheduler.publicProxyPoolSnap(),
        setPool: (text, options) => scheduler.setProxyPool(text, options),
        poolScopes: () => ({mail: scheduler.proxyPoolMailEnabled !== false, gpt: scheduler.proxyPoolGptEnabled !== false}),
        setPoolScopes: (scopes) => scheduler.setProxyPoolScopes(scopes),
        getJumpLines: () => scheduler.proxyJumpPool || [],
        jumpSnapshot: () => scheduler.publicJumpPoolSnapshot(),
        setJumpPool: (urls) => scheduler.setProxyJumpPool(urls),
        jumpScopes: () => ({mail: scheduler.proxyJumpMailEnabled !== false, gpt: scheduler.proxyJumpGptEnabled !== false}),
        setJumpScopes: (scopes) => scheduler.setProxyJumpScopes(scopes),
        checkJumpPool: () => mailJumpPool.checkAll(),
    });
    registerMailDeliveryRoutes(app, {
        delivery: {
            sendMailbox: (payload) => sendMailboxViaProvider({
                ...payload,
                withProxy: scheduler.proxyPoolEnabled("mail") ? withLeasedMailProxy : null,
            }),
            sendOne: sendMailcomViaPool,
            sendBatch: sendMailcomBatch,
            listLogs: listMailSendLogsPublic,
            preview: previewDeliveredSend,
            startTest: (ids, options) => startTestSendDelivered(ids, {
                ...options,
                withProxy: scheduler.proxyPoolEnabled("mail") ? withLeasedMailProxy : null,
            }),
            getTestJob: getDeliveredSendJob,
            stopTest: stopDeliveredSend,
        },
        rechargeLog: rechargeBridge.log,
        broadcast,
    });

    let executeClaimedJob;
    const mailJobs = createMailJobCoordinator({
        store: {
            setClaimPaused: (paused) => db.setMailClaimPaused(paused),
            cancelPending: (kind) => db.cancelPendingMailJobs(kind),
            progress: () => db.mailJobsProgress(),
            isClaimPaused: () => db.isMailClaimPaused(),
            upsertInstance: (instanceId, state) => db.upsertMailInstance(instanceId, state),
            listInstances: () => db.listMailInstances(),
            requeueRunning: (instanceId, line) => db.requeueRunningOnInstance(instanceId, line),
            requeueRecentBitFailures: () => db.requeueRecentBitTransientFails(),
            reclaimStale: (maxAgeMs) => db.reclaimStaleMailJobs(maxAgeMs),
            recoverInterrupted: (ids, options) => db.recoverInterruptedMailJobs(ids, options),
            heartbeat: (instanceId, ids) => db.heartbeatMailJobs(instanceId, ids),
            failTimedOut: (maxAgeMs) => db.failTimedOutMailJobs(maxAgeMs),
            claim: (instanceId, limit, kind, maxRunning) => db.claimMailJobs(instanceId, limit, kind, maxRunning),
            getMailbox: (id) => db.getMailbox(id),
            enqueue: (items, kind) => db.enqueueMailJobs(items, kind),
            cancelUsablePending: () => db.cancelPendingHardenIfAlreadyUsable(),
            listNewestErrors: (kind) => db.listNewestBatchErrorJobs(kind),
            listResumable: (options) => db.listResumableMailJobs(options),
            listHardenGaps: (ids) => db.listGoogleHardenGaps(ids),
        },
        scheduler,
        jumpPool: mailJumpPool,
        maxExitsPerJump: JUMP_MAX_EXITS,
        executeJob: (job) => executeClaimedJob(job),
        effects: {broadcast, log: (...args) => console.log(...args), warn: (...args) => console.warn(...args)},
        instanceId: db.instanceId,
        isHttpReady: () => applicationState.httpReady,
        isShuttingDown: () => applicationState.shuttingDown,
    });
    const runHarden = createGmailHardenService({
        store: {
            getMailbox: (id) => db.getMailbox(id),
            refreshGoogleState: (id, state) => db.refreshMailboxGoogleState(id, state),
            setJobLine: (id, line) => db.setMailJobLine(id, line),
            setPassword: (id, password, status) => db.setMailboxPassword(id, password, status),
            commitTotp: (id, secret, previous) => db.commitRotatedTotp(id, secret, previous),
            applyUpdate: (email, updates) => db.applyMailboxUpdate(email, updates),
            setProxy: (id, url, ip) => db.setMailboxProxy(id, url, ip),
        },
        withProxy: withLeasedMailProxy,
        runWorker: runGmailBrowserTask,
        applyResult: applyHardenResult,
        runtime: {
            isStopped: mailJobs.isStopped,
            abortControllers: mailJobs.runtime.abortControllers,
            current: mailJobs.runtime.current,
        },
        effects: {
            log: logMailbox,
            scheduleBroadcast: mailJobs.scheduleBroadcast,
            syncMailboxes: async () => broadcast("mailboxes", {
                stats: await db.mailboxStats(),
                proxyPool: scheduler.mailProxyPoolSnap(),
            }),
        },
        maskProxy: maskProxyUrl,
        sessionOf: kookeeySessionOf,
        instanceId: db.instanceId,
    });
    registerMailboxResourceRoutes(app, {
        store: {
            import: (rows, group, usage, provider) => db.importFreeMailboxes(rows, group, usage, provider),
            refreshGoogleState: (id, state) => db.refreshMailboxGoogleState(id, state),
            list: (usage) => db.listMailboxes(usage),
            stats: () => db.mailboxStats(),
            freeGroups: () => db.freeMailboxGroups(),
            lookup: (emails) => db.lookupMailboxesByEmails(emails),
            get: (id) => db.getMailbox(id),
            enqueueJobs: (items, kind) => db.enqueueMailJobs(items, kind),
            allocateIds: (usage, ids, batch) => db.allocateMailboxIdsTo(usage, ids, batch),
            allocate: (usage, count, batch, group) => db.allocateMailboxesTo(usage, count, batch, group),
            remove: (id) => db.deleteMailbox(id),
            removeBatch: (ids) => db.batchDeleteMailbox(ids),
            setUsage: (id, usage) => db.setMailboxUsage(id, usage),
            setBatchUsage: (ids, usage) => db.setMailboxesUsage(ids, usage),
            setGroups: (ids, group) => db.setMailboxesGrp(ids, group),
            listLogs: (id) => db.listMailboxLogs(id),
            listAccounts: () => db.listAccounts(),
            accountStats: () => db.stats(),
            claudeStats: () => db.claudeStats(),
        },
        jobs: {begin: mailJobs.begin, afterEnqueue: mailJobs.afterEnqueue, startHarden: mailJobs.startHarden},
        scheduler: {tick: () => scheduler.tick()},
        parseAccounts,
        extractEmails,
        fetchInbox: fetchInboxList,
        fetchBody: fetchMailBodyFor,
        logMailbox,
        broadcast,
    });

    const changePassword = createMailboxPasswordService({
        store: {
            getMailbox: (id) => db.getMailbox(id),
            setPassword: (id, password, status) => db.setMailboxPassword(id, password, status),
            setBrowserFingerprint: (id, profile) => db.setMailboxBrowserFp(id, profile),
        },
        gmailMaintenance,
        withProxy: withLeasedMailProxy,
        changeMailcomPassword,
        ensureMailcomProfile,
        randomPassword,
        sessionOf: kookeeySessionOf,
        maskProxy: maskProxyUrl,
        syncMailboxes: async () => broadcast("mailboxes", {stats: await db.mailboxStats()}),
        log: logMailbox,
    });
    executeClaimedJob = createMailJobExecutor({
        store: {
            getMailbox: (id) => db.getMailbox(id),
            complete: (id, ok, error, result) => db.completeMailJob(id, ok, error, result),
            requeue: (id, reason) => db.requeueMailJob(id, reason),
            setLine: (id, line) => db.setMailJobLine(id, line),
            commitTotp: (id, secret, previous) => db.commitRotatedTotp(id, secret, previous),
            allocateMailbox: (usage, ids, batch) => db.allocateMailboxIdsTo(usage, ids, batch),
        },
        services: {
            changePassword,
            changeTotp: gmailMaintenance.changeTotp,
            harden: runHarden,
            parkForBitDown: mailJobs.parkForBitDown,
        },
        classifiers: {formatHardenError: formatHardenPartialError, isBitTransient: isBitTransientError, isProxyInfra: isProxyInfraError},
        runtime: mailJobs.runtime,
        effects: {
            logMailbox,
            warn: (...args) => console.warn(...args),
            syncAccounts: async () => {
                broadcast("snapshot", await db.listAccounts());
                broadcast("stats", await db.stats());
            },
            scheduleBroadcast: mailJobs.scheduleBroadcast,
            scheduleNext: () => setTimeout(() => { mailJobs.tick().catch(() => {}); }, 200),
        },
        instanceId: db.instanceId,
    });

    const refreshLegacyPasswordProgress = async () => {
        const legacy = await db.pwQueueProgress();
        broadcast("batchPw", {...mailJobs.snapshot(), legacy});
    };
    registerMailJobRoutes(app, {
        store: {
            getMailbox: (id) => db.getMailbox(id),
            enqueue: (items, kind) => db.enqueueMailJobs(items, kind),
            listNewestErrors: (kind) => db.listNewestBatchErrorJobs(kind),
            clearLegacyPasswordQueue: () => db.clearPwQueue(),
        },
        jobs: mailJobs,
        randomPassword,
        setConcurrency: (value) => scheduler.setPwConcurrency(value),
        refreshLegacyPasswordProgress,
        logMailbox,
    });
    const mailCheck = createMailCheckService({
        verifyLogin: verifyMailcomLogin,
        changePassword: changeMailcomPassword,
        randomPassword,
        runPool,
        concurrency: 2,
    });
    registerMailCheckRoutes(app, {mailCheck});

    return {
        mailJobs,
        stopBrowserWorkers: stopMailcomBrowserWorkers,
        stateExtras: mailJobs.stateExtras,
        refreshWindows: mailJobs.refreshWindows,
        parseAccounts,
        extractEmails,
    };
}
