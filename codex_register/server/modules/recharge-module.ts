// @ts-nocheck
// 充值模块装配：卡密、提交/重登、轮询、RT 导出、Gmail 换绑与人工对账。
import path from "node:path";
import {mailProxyPool, gptProxyPool, maskProxyUrl} from "../../src/mail/proxy-pool.js";
import {testGmailImap, isImapTransientError} from "../../src/mail/google-imap.js";
import {gmailWebLoginFresh} from "../../src/mail/google-state.js";
import {rememberMailcomPassword} from "../../src/mail/mailcom.js";
import {verifyMailcomLogin} from "../domain/mailbox-service.js";
import {runGmailLoginWorker} from "../domain/gmail-rebind-probe.js";
import {createRechargeMailboxPrecheckService} from "../domain/recharge-mailbox-precheck-service.js";
import {createRechargeApiClient} from "../domain/recharge-api-client.js";
import {createRechargeLogStore} from "../domain/recharge-log-store.js";
import {createRechargeRuntime} from "../domain/recharge-runtime.js";
import {createRechargeAdminService} from "../domain/recharge-admin-service.js";
import {createRechargeQueueService} from "../domain/recharge-queue-service.js";
import {createRechargeLifecycle} from "../domain/recharge-lifecycle.js";
import {createRechargeManualRecoveryService} from "../domain/recharge-manual-recovery-service.js";
import {cardBoundToOtherAccount} from "../domain/recharge-card-policy.js";
import {extractSession, isGoogleMailbox, isMailcomMailbox} from "../domain/account-credential-format.js";
import {registerRechargeAdminRoutes} from "../routes/recharge-admin-routes.js";
import {registerRechargeQueueRoutes} from "../routes/recharge-queue-routes.js";
import {registerRechargeOperationRoutes} from "../routes/recharge-operation-routes.js";
import {registerGmailRebindManagementRoutes} from "../routes/gmail-rebind-management-routes.js";
import {registerRechargeExportRoutes} from "../routes/recharge-export-routes.js";
import {createRechargeOperationFactory} from "./recharge-operation-factory.js";
import {createRechargeExportFactory} from "./recharge-export-factory.js";
import {createRechargeRebindFactory} from "./recharge-rebind-factory.js";

export function createRechargeModule({
    app,
    db,
    scheduler,
    rootDir,
    broadcast,
    credentialFiles,
    token,
    rechargeBridge,
    runPool,
    extractEmails,
} = {}) {
    const getAuthData = credentialFiles.readAuth;
    const getRtData = credentialFiles.readRt;
    const rechargeProxy = token.rechargeProxy;
    const logStore = createRechargeLogStore({
        filePath: path.resolve(rootDir, "data", "recharge-logs.jsonl"),
        onAppend: (entry) => broadcast("rechargeLog", entry),
    });
    logStore.load();
    const log = logStore.append;
    const callApi = createRechargeApiClient({
        getConfig: () => ({
            baseUrl: scheduler.rechargeBaseUrl,
            apiKey: scheduler.rechargeApiKey,
            forwardIp: scheduler.rechargeForwardIp,
        }),
    });

    let rechargeRelogin;
    let rechargeSubmit;
    let rechargeBatch;
    let rechargeExports;
    let rechargeRecovery;
    const isRecoveryRunning = () => rechargeRecovery?.isRunning() || false;
    const runtime = createRechargeRuntime({
        store: {
            listCards: () => db.listRechargeCards(),
            listQueue: () => db.listRechargeQueue(),
        },
        jobs: {
            reloginRunning: () => rechargeRelogin?.isRunning() || false,
            batchRunning: () => rechargeSubmit?.isRunning() || rechargeBatch?.isRunning() || false,
            exportRunning: () => rechargeExports?.isRunning() || false,
        },
        publish: broadcast,
    });
    const syncCards = runtime.syncCards;
    const syncQueue = runtime.syncQueue;
    const broadcastJobs = runtime.broadcastJobs;

    const mailboxPrecheck = createRechargeMailboxPrecheckService({
        store: {
            getAccount: (id) => db.getAccount(id),
            refreshGoogleState: (id, state) => db.refreshMailboxGoogleState(id, state),
        },
        mailbox: {isGoogle: isGoogleMailbox, isMailcom: isMailcomMailbox, rememberMailcomPassword, verifyMailcom: verifyMailcomLogin},
        imap: {test: testGmailImap, isTransient: isImapTransientError},
        proxy: {mailPool: mailProxyPool, gptPool: gptProxyPool, mask: maskProxyUrl},
        settings: {
            mailJump: () => scheduler.mailProxyJump || "",
            gptJump: () => scheduler.gptProxyJump || "",
            rechargeProxy,
        },
        web: {probe: runGmailLoginWorker, fresh: gmailWebLoginFresh},
        effects: {log},
        credentials: {read: getAuthData, extractSession},
    });

    const rebindServices = createRechargeRebindFactory({
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
        isRecoveryRunning,
        isExportRunning: () => rechargeExports?.isRunning() || false,
    });
    const enqueueGmailRebind = rebindServices.enqueue;

    const rechargeAdmin = createRechargeAdminService({
        settings: scheduler,
        store: {
            countFreeGoogleImap: () => db.countFreeGoogleImapMailboxes(),
            countFreeMailcom: () => db.countFreeMailcomMailboxes(),
            listCards: () => db.listRechargeCards(),
            getCard: (id) => db.getRechargeCard(id),
            getCards: (ids) => db.getRechargeCards(ids),
            importCards: (codes, batch) => db.importRechargeCards(codes, batch),
            deleteCards: (ids) => db.deleteRechargeCards(ids),
            updateCard: (id, updates) => db.updateRechargeCard(id, updates),
            unpairCards: (ids) => db.unpairRechargeCards(ids),
            applyValidation: (id, expectedStatus, result) => db.applyRechargeCardValidation(id, expectedStatus, result),
        },
        logs: logStore,
        api: {call: callApi},
        effects: {log, syncCards, scheduleAll: runtime.scheduleAll, flushAll: runtime.flushAll},
        getJobState: runtime.jobState,
        instanceId: db.instanceId,
    });
    const rechargeQueue = createRechargeQueueService({
        store: {
            listSuccessAccounts: () => db.listAccounts("success"),
            list: (delivery) => db.listRechargeQueue(delivery),
            listBatches: (delivery) => db.rechargeQueueBatches(delivery),
            get: (id) => db.getRechargeQueueItem(id),
            getMany: (ids) => db.getRechargeQueueItems(ids),
            add: (ids, batch) => db.addToRechargeQueue(ids, batch),
            deliver: (ids) => db.deliverRechargeQueue(ids),
            undeliver: (ids) => db.undeliverRechargeQueue(ids),
            setBatch: (ids, batch) => db.setRechargeQueueBatch(ids, batch),
            reset: (ids) => db.resetRechargeQueue(ids),
            markError: (ids, reason) => db.markRechargeQueueError(ids, reason),
            unpairCards: (ids) => db.unpairRechargeCards(ids),
            updateCard: (id, updates) => db.updateRechargeCard(id, updates),
        },
        api: {call: callApi},
        cardPolicy: {boundToOtherAccount: cardBoundToOtherAccount},
        effects: {log, syncQueue, syncCards, syncAccounts: async () => broadcast("snapshot", await db.listAccounts())},
    });
    registerRechargeAdminRoutes(app, {admin: rechargeAdmin});
    registerRechargeQueueRoutes(app, {queue: rechargeQueue});

    const operations = createRechargeOperationFactory({
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
        isRecoveryRunning,
    });
    rechargeBatch = operations.batch;
    rechargeRelogin = operations.relogin;
    rechargeSubmit = operations.submit;
    const rechargePoll = operations.poll;
    rechargeRecovery = createRechargeManualRecoveryService({
        runtime: {
            jobState: runtime.jobState,
            pollRunning: rechargePoll.isRunning,
            rebindRunning: rebindServices.queue.isBusy,
        },
        store: {
            recover: async (ids) => {
                const [legacy, submitTasks, reloginSubmitTasks, rebindTasks] = await Promise.all([
                    db.recoverRechargeWorkItems(ids, db.instanceId),
                    db.recoverStaleWorkTasks({kind: "recharge_submit", ids}),
                    db.recoverStaleWorkTasks({kind: "recharge_relogin_submit", ids}),
                    db.recoverStaleWorkTasks({kind: "gmail_rebind", ids}),
                ]);
                return {...legacy, tasks: Number(submitTasks || 0) + Number(reloginSubmitTasks || 0) + Number(rebindTasks || 0)};
            },
        },
        effects: {log, sync: runtime.syncAll},
    });
    registerRechargeOperationRoutes(app, {
        submit: rechargeSubmit,
        relogin: rechargeRelogin,
        poll: rechargePoll,
        recovery: rechargeRecovery,
        admin: rechargeAdmin,
    });

    registerGmailRebindManagementRoutes(app, {rebind: rebindServices.management});

    rechargeExports = createRechargeExportFactory({
        db,
        token,
        credentialFiles,
        rechargeBridge,
        scheduler,
        getAuthData,
        getRtData,
        log,
        broadcastJobs,
        syncQueue,
        broadcast,
        isRechargeOperationRunning: () => !!(rechargeSubmit?.isRunning?.() || rechargeRelogin?.isRunning()),
        isRecoveryRunning,
        isRebindRunning: rebindServices.queue.isBusy,
    });
    registerRechargeExportRoutes(app, {exports: rechargeExports});
    rechargeBridge.bind({syncQueue, attachExportChild: rechargeExports.attachChild, log});

    const lifecycle = createRechargeLifecycle({
        relogin: rechargeRelogin,
        batch: rechargeBatch,
        exports: rechargeExports,
        rebind: {
            start: rebindServices.worker?.start,
            stop: rebindServices.worker?.stop,
            requestStop: rebindServices.worker ? () => {} : rebindServices.queue.cancelAll,
            waitForIdle: rebindServices.queue.waitForIdle,
        },
        workers: [operations.submitWorker, operations.reloginSubmitWorker, operations.pollWorker],
    });

    return {
        lifecycle,
        log,
        broadcastJobs,
    };
}
