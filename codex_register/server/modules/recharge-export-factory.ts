// @ts-nocheck
// 充值导出工厂：RT 获取、sub2json 和套餐探测。
import {buildProxyDispatcher, probePlan} from "../../src/token-check.js";
import {createRechargeRtAcquireService} from "../domain/recharge-rt-acquire.js";
import {createSub2jsonExportService} from "../domain/recharge-sub2json-export.js";
import {createRechargeExportService} from "../domain/recharge-export-service.js";
import {extractSession, formatAccountExportLine} from "../domain/account-credential-format.js";

export function createRechargeExportFactory({
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
    isRechargeOperationRunning,
    isRecoveryRunning,
    isRebindRunning,
} = {}) {
    const rtAcquire = createRechargeRtAcquireService({
        getAccount: (id) => db.getAccount(id),
        getAccounts: (ids) => db.getAccounts(ids),
        getAuthData,
        getRtData,
        extractTokens: token.extractTokens,
        relogin: token.runRelogin,
        acquireRt: token.testRt,
        attachChild: rechargeBridge.attachExportChild,
    });
    const sub2json = createSub2jsonExportService({
        getAccount: (id) => db.getAccount(id),
        getAccounts: (ids) => db.getAccounts(ids),
        getRtData,
        extractTokens: token.extractTokens,
        testOneRt: token.testRt,
        refreshRtViaPool: token.refreshRtViaPool,
        attachChild: rechargeBridge.attachExportChild,
    });
    const rechargeExports = createRechargeExportService({
        store: {
            listFull: (ids, batch, options) => db.listRechargeQueueFull(ids, batch, options),
            getQueue: (id) => db.getRechargeQueueItem(id),
            getQueues: (ids) => db.getRechargeQueueItems(ids),
            listQueue: (delivery) => db.listRechargeQueue(delivery),
            getAccount: (id) => db.getAccount(id),
            getAccounts: (ids) => db.getAccounts(ids),
            updateQueue: (id, updates) => db.updateQueueItem(id, updates),
        },
        credentials: {
            readJson: credentialFiles.readJson,
            readAuth: getAuthData,
            readRt: getRtData,
            extractTokens: token.extractTokens,
            extractSession,
        },
        formatLine: formatAccountExportLine,
        rtAcquire,
        distributedRt: {
            enqueue: (ids, payload) => db.enqueueWorkTasks("rt_account", ids.map((id) => ({
                entityId: id,
                payload,
                priority: 5,
            }))),
            list: (ids) => db.listLatestWorkTasks("rt_account", ids),
            wake: () => token.rtWorker?.wake?.(),
        },
        sub2json,
        plans: {buildDispatcher: buildProxyDispatcher, probe: probePlan},
        config: {rtConcurrency: () => scheduler.rtConcurrency, regProxy: () => scheduler.regProxy},
        effects: {
            log,
            jobsChanged: broadcastJobs,
            ready: (payload) => broadcast("rechargeExportReady", payload),
            syncQueue,
        },
        isRechargeOperationRunning,
        isRecoveryRunning,
        isRebindRunning,
    });

    return rechargeExports;
}
