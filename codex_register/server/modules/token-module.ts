// @ts-nocheck
// Token/GPT 模块装配：AT/RT、重登、聊天、MFA、短信、导出、维护任务与控制路由。
import {existsSync} from "node:fs";
import path from "node:path";
import {spawn} from "node:child_process";
import {cleanSpawnEnv} from "../strip-env-proxy.js";
import {gptJumpPool, gptProxyPool, maskProxyUrl, JUMP_MAX_EXITS} from "../../src/mail/proxy-pool.js";
import {bitHealth} from "../../src/bitbrowser.js";
import {peekSms, buildSmsLink, classifySms} from "../../src/sms-broker.js";
import {probeAt, probePlan, refreshRt, buildProxyDispatcher, decodeJwt} from "../../src/token-check.js";
import {enrollTotp} from "../../src/mfa.js";
import {setMailProxy} from "../domain/mailbox-service.js";
import {createTokenCredentials} from "../domain/token-credentials.js";
import {createGptProxyLease, pickBrowserCompatibleProxy as pickMailcomBrowserProxy, proxyHasSocksAuth, resolveReloginProxy} from "../domain/gpt-proxy-lease.js";
import {pipeWorkerOutput} from "../domain/worker-output.js";
import {createAccountRtWorker} from "../domain/account-rt-worker.js";
import {createAccountReloginRunner} from "../domain/account-relogin-runner.js";
import {createAccountTokenService} from "../domain/account-token-service.js";
import {createChatWorkerRunner} from "../domain/chat-worker-runner.js";
import {createTokenBatchService} from "../domain/token-batch-service.js";
import {createGptMfaService} from "../domain/gpt-mfa-service.js";
import {createXrayControlService} from "../domain/xray-control-service.js";
import {createSmsService} from "../domain/sms-service.js";
import {createDailyMaintenanceService} from "../domain/daily-maintenance-service.js";
import {createAccountExportService} from "../domain/account-export-service.js";
import {extractSession, isGoogleMailbox, isMailcomMailbox} from "../domain/account-credential-format.js";
import {registerTokenRoutes} from "../routes/token-routes.js";
import {registerControlRoutes} from "../routes/control-routes.js";
import {registerSmsRoutes} from "../routes/sms-routes.js";
import {registerDailyMaintenanceRoutes} from "../routes/daily-maintenance-routes.js";
import {registerAccountExportRoutes} from "../routes/account-export-routes.js";
import {registerTokenToolRoutes} from "../routes/token-tool-routes.js";
import {startXray, stopXray, xrayStatus, listJumpXrays, isVlessUrl, stopJumpFleet, pickXrayBrowserProxy} from "../xray-proxy.js";
import {createTokenToolFactory} from "./token-tool-factory.js";
import {createPersistentTaskWorker} from "../domain/persistent-task-worker.js";
import {normalizeConcurrency} from "../domain/concurrency.js";

export function createTokenModule({
    app,
    db,
    scheduler,
    config,
    rootDir,
    broadcast,
    logAccount,
    credentialFiles,
    mailJobs,
    rechargeBridge,
    runPool,
} = {}) {
    const isWindows = process.platform === "win32";
    const tsxBin = (() => {
        const local = path.resolve(rootDir, "node_modules", ".bin", `tsx${isWindows ? ".cmd" : ""}`);
        return existsSync(local) ? local : "tsx";
    })();
    const spawnWorker = (args, env) => spawn(tsxBin, args, {shell: isWindows, cwd: rootDir, env});
    const rechargeProxy = () => String(scheduler.rtProxy || scheduler.regProxy || "").trim();
    const getAuthData = credentialFiles.readAuth;
    const getRtData = credentialFiles.readRt;
    const tokenCredentials = createTokenCredentials({readJson: credentialFiles.readJson, decodeJwt});
    const extractTokens = tokenCredentials.extract;
    const readAuthTokens = tokenCredentials.readFile;
    const persistRtFile = async (id, file, data) => {
        const stable = credentialFiles.writeRtForAccount?.(id, data) || file || "";
        await db.setAccountRtFile(id, stable, data);
        return stable;
    };

    const waitRegistrationIdle = () => {
        if (scheduler.running.size === 0) return Promise.resolve();
        return new Promise((resolve) => {
            const check = () => {
                if (scheduler.running.size !== 0) return;
                scheduler.removeListener("stats", check);
                resolve();
            };
            scheduler.on("stats", check);
        });
    };
    const pickAccounts = async (ids) => {
        if (Array.isArray(ids) && ids.length) {
            return (await Promise.all(ids.map((id) => db.getAccount(Number(id))))).filter(Boolean);
        }
        return db.listAccounts("success");
    };

    const withLeasedGptProxy = createGptProxyLease({
        proxyPool: gptProxyPool,
        jumpPool: gptJumpPool,
        settings: {
            rechargeProxy,
            hasJumpConfig: () => typeof scheduler.hasGptJumpConfig === "function"
                ? scheduler.hasGptJumpConfig()
                : !!(scheduler.gptProxyJump || (scheduler.gptJumpPool || []).length),
            configuredJump: () => scheduler.gptProxyJump || "",
            hasPoolConfig: () => scheduler.proxyPoolEnabled?.("gpt") !== false && !!scheduler.gptProxyPool?.length,
        },
        maskProxyUrl,
        maxJumpExits: JUMP_MAX_EXITS,
    });
    const resolveReloginExitProxy = (explicit) => resolveReloginProxy(
        explicit,
        () => rechargeProxy() || String(scheduler.regProxy || "").trim(),
    );

    let accountTokens;
    const accountRtWorker = createAccountRtWorker({
        runtime: {
            spawn: spawnWorker,
            cleanEnv: cleanSpawnEnv,
            pipeOutput: pipeWorkerOutput,
        },
        store: {
            setRtFile: persistRtFile,
            setPhone: (id, phone) => db.setAccountPhone(id, phone),
            setCard: (id, card) => db.setAccountCard(id, card),
        },
        files: {writeCredential: credentialFiles.writeMailbox, readJson: credentialFiles.readJson},
        settings: {
            rtProxy: () => scheduler.rtProxy || "",
            regProxy: () => scheduler.regProxy || "",
            rechargeProxy,
            mailProxyEnabled: () => scheduler.mailProxyEnabled !== false,
            mailProxy: () => scheduler.mailProxy || "",
            smsLinkTemplate: () => scheduler.smsLinkTemplate || "",
            smsMaxBind: () => scheduler.smsMaxBind ?? 0,
            defaultPassword: () => config.defaultPassword || "",
        },
        proxy: {
            withLease: withLeasedGptProxy,
            pickXray: pickXrayBrowserProxy,
            pickMailBrowser: pickMailcomBrowserProxy,
            mask: maskProxyUrl,
        },
        effects: {
            setStatus: (...args) => accountTokens.setStatus(...args),
            emitSmsStats: async () => scheduler.emit("sms", {stats: await db.smsStats()}),
            syncPlan: (...args) => accountTokens.syncPlan(...args),
        },
        credentials: {extract: extractTokens},
    });

    const accountReloginRunner = createAccountReloginRunner({
        runtime: {
            spawn: spawnWorker,
            cleanEnv: cleanSpawnEnv,
            pipeOutput: pipeWorkerOutput,
        },
        store: {
            updateAccount: (id, updates) => db.updateAccount(id, updates),
            updateQueueAuth: (id, file, data) => db.updateQueueAuthByAccount(id, file, data),
        },
        files: {writeCredential: credentialFiles.writeMailbox, readJson: credentialFiles.readJson},
        settings: {
            resolveExitProxy: resolveReloginExitProxy,
            defaultJump: () => scheduler.gptProxyJump || scheduler.mailProxyJump || "",
            rechargeProxy,
            rtProxy: () => scheduler.rtProxy || "",
            regProxy: () => scheduler.regProxy || "",
            mailProxyEnabled: () => scheduler.mailProxyEnabled !== false,
            mailProxy: () => scheduler.mailProxy || "",
            defaultPassword: () => config.defaultPassword || "",
            poolSize: () => scheduler.gptProxyPoolSnap?.total || gptProxyPool.urls?.length || 0,
        },
        proxy: {
            pickXray: pickXrayBrowserProxy,
            pickMailBrowser: pickMailcomBrowserProxy,
            hasSocksAuth: proxyHasSocksAuth,
            mask: maskProxyUrl,
            withLease: withLeasedGptProxy,
        },
        effects: {
            logAccount,
            syncQueue: rechargeBridge.syncQueue,
            snapshot: async () => broadcast("snapshot", await db.listAccounts()),
        },
    });
    let accountLockSequence = 0;
    const withAccountWorkLock = async (account, kind, work) => {
        if (!account?.mailbox_id || !db.withMailboxWorkLock) return work();
        const owner = `${db.instanceId}:${kind}:${account.id}:${++accountLockSequence}`;
        const result = await db.withMailboxWorkLock(account.mailbox_id, work, owner);
        if (result?.locked) {
            return {...result, ok: false, reason: result.error || "该账号正在被其他实例操作"};
        }
        return result;
    };
    const runRelogin = (account, options) => withAccountWorkLock(
        account,
        "relogin",
        () => accountReloginRunner.runPooled(account, options),
    );

    accountTokens = createAccountTokenService({
        store: {
            setTestStatus: (id, kind, status) => db.setTestStatus(id, kind, status),
            getAccount: (id) => db.getAccount(id),
            setDeadAt: (id, value) => db.setDeadAt(id, value),
            updateAccount: (id, updates) => db.updateAccount(id, updates),
            updateQueuePlan: (id, plan) => db.updateRechargeQueuePlanByAccount(id, plan),
            updateRtData: (id, data) => db.updateRtData(id, data),
        },
        credentials: {readAuth: getAuthData, readRt: getRtData, readFile: readAuthTokens, extract: extractTokens},
        http: {probeAt, refreshRt, probePlan, buildDispatcher: buildProxyDispatcher},
        settings: {
            tokenProxy: () => rechargeProxy() || scheduler.rtProxy || scheduler.regProxy || "",
            rechargeProxy,
            maskProxy: maskProxyUrl,
        },
        files: {writeRt: credentialFiles.writeJson},
        relogin: {run: runRelogin},
        rtWorker: accountRtWorker,
        effects: {
            status: (id, account) => broadcast("status", {id, ...account}),
            logAccount,
            syncQueue: rechargeBridge.syncQueue,
        },
    });
    const testRt = (account, options) => withAccountWorkLock(
        account,
        "rt",
        () => accountTokens.testRt(account, options),
    );
    const refreshRtViaPool = (account, refreshToken, progress) => withAccountWorkLock(
        account,
        "rt-refresh",
        () => accountTokens.refreshRtViaPool(account, refreshToken, progress),
    );

    const chatWorkers = createChatWorkerRunner({
        runtime: {spawn: spawnWorker, cleanEnv: cleanSpawnEnv, pipeOutput: pipeWorkerOutput},
        credentials: {readAuth: getAuthData},
        proxy: {pick: () => pickXrayBrowserProxy(scheduler.regProxy, scheduler.rtProxy, rechargeProxy())},
        effects: {
            setStatus: accountTokens.setStatus,
            log: (id, line) => broadcast("log", {id, line, ts: Date.now()}),
            logError: logAccount,
        },
    });
    const runChat = chatWorkers.run;
    const tokenBatch = createTokenBatchService({
        scheduler: {
            get maintLock() { return scheduler.maintLock; },
            set maintLock(value) { scheduler.maintLock = value; },
            get running() { return scheduler.running; },
            get concurrency() { return scheduler.concurrency; },
            acquireLock: (name) => scheduler.acquireLock(name),
            releaseLock: (name) => scheduler.releaseLock(name),
            tick: () => scheduler.tick(),
            waitRegistrationIdle,
        },
        store: {getAccount: (id) => db.getAccount(id)},
        testAt: accountTokens.testAt,
        testRt,
        pickAccounts,
        runPool,
        effects: {broadcast, logAccount, info: (...args) => console.log(...args), warn: (...args) => console.warn(...args)},
        taskStore: {
            enqueue: (id, payload) => db.enqueueWorkTask("rt_account", id, payload, {priority: 5}),
            enqueueMany: (items) => db.enqueueWorkTasks("rt_account", items),
        },
    });
    const distributedRtWorker = createPersistentTaskWorker({
        kind: "rt_account",
        instanceId: db.instanceId,
        concurrency: () => normalizeConcurrency(scheduler.rtConcurrency || scheduler.concurrency, 4),
        claim: (limit, leaseMs) => db.claimWorkTasks("rt_account", db.instanceId, limit, leaseMs),
        heartbeat: (task, leaseMs) => db.heartbeatWorkTask(task.id, db.instanceId, task.lease_token, leaseMs),
        complete: (task, result) => db.completeWorkTask(
            task.id,
            db.instanceId,
            task.lease_token,
            result && typeof result === "object"
                ? {...result, worker_instance: db.instanceId}
                : {value: result, worker_instance: db.instanceId},
        ),
        fail: (task, error) => db.failWorkTask(task.id, db.instanceId, task.lease_token, error),
        release: (task, reason) => db.releaseWorkTask(task.id, db.instanceId, task.lease_token, reason),
        cancel: (task) => db.cancelWorkTask("rt_account", task.entity_id),
        execute: (task, context) => tokenBatch.processDistributedRtTask(task, context),
        onChange: (state) => {
            if (state.error) console.warn(`[批量RT] 分布式 worker 拉取失败: ${state.error?.message || state.error}`);
        },
    });
    tokenBatch.bindDistributedRtWorker(distributedRtWorker);
    const gptMfa = createGptMfaService({
        store: {
            get: (id) => db.getAccount(id),
            update: (id, fields) => db.updateAccount(id, fields),
            list: () => db.listAccounts(),
        },
        enrollTotp,
        relogin: runRelogin,
        readAuth: getAuthData,
        extractTokens,
        decodeJwt,
        getProxy: () => scheduler.regProxy || scheduler.rtProxy || config.defaultProxyUrl || process.env.PROXY_URL || process.env.ALL_PROXY || "",
        effects: {log: logAccount, broadcast, warn: (...args) => console.warn(...args)},
    });
    registerTokenRoutes(app, {
        store: {get: (id) => db.getAccount(id)},
        tokens: {testAt: accountTokens.testAt, testRt, pickAccounts},
        batch: tokenBatch,
        mfa: gptMfa,
        chat: {
            run: runChat,
            runBatch: (accounts, message) => runPool(accounts, (account) => runChat(account, message), 2),
        },
    });

    const xrayControl = createXrayControlService({
        scheduler,
        xray: {start: startXray, stop: stopXray, status: xrayStatus, listJumpXrays, stopJumpFleet, isVlessUrl},
    });
    registerControlRoutes(app, {
        scheduler,
        instanceId: db.instanceId,
        bitHealth,
        setMailProxy,
        stats: () => db.stats(),
        mailJobs,
        xray: xrayControl,
    });

    const smsService = createSmsService({
        store: {
            import: (rows) => db.importSms(rows),
            list: () => db.listSms(),
            remove: (id) => db.deleteSms(id),
            stats: () => db.smsStats(),
        },
        sms: {peek: peekSms, buildLink: buildSmsLink, classify: classifySms},
        runPool,
        getLinkTemplate: () => scheduler.smsLinkTemplate,
        broadcast,
    });
    registerSmsRoutes(app, {smsService});

    const dailyMaintenance = createDailyMaintenanceService({
        scheduler: {
            get daily() { return scheduler.daily; },
            get maintLock() { return scheduler.maintLock; },
            get concurrency() { return scheduler.concurrency; },
            acquireLock: (owner) => scheduler.acquireLock(owner),
            releaseLock: (owner) => scheduler.releaseLock(owner),
            waitRegistrationIdle,
            tick: () => scheduler.tick(),
            configureDaily: (value) => scheduler.setDaily(value),
            recordDailyRun: (result) => scheduler.recordDailyRun(result),
            setDailyRunning: (running) => {
                scheduler.daily.running = running;
                scheduler.emit("daily", scheduler.daily);
            },
        },
        store: {
            listSuccess: () => db.listAccounts("success"),
            get: (id) => db.getAccount(id),
            setDeadAt: (id, deadAt) => db.setDeadAt(id, deadAt),
        },
        tokens: {testAt: accountTokens.testAt, testRt},
        chat: {run: runChat},
        runPool,
        effects: {broadcast, logAccount},
    });
    registerDailyMaintenanceRoutes(app, {daily: dailyMaintenance});

    const accountExports = createAccountExportService({
        store: {
            listFull: () => db.listAccounts(undefined, true),
            list: () => db.listAccounts(),
            get: (id) => db.getAccount(id),
            markSold: (ids) => db.markSold(ids),
        },
        credentials: {readAuth: getAuthData, readRt: getRtData, extractTokens},
        defaultPassword: () => String(config.defaultPassword || ""),
        effects: {
            syncAccounts: async () => {
                broadcast("snapshot", await db.listAccounts());
                broadcast("stats", await db.stats());
            },
        },
    });
    registerAccountExportRoutes(app, {exports: accountExports});

    const tokenTools = createTokenToolFactory({
        db,
        scheduler,
        config,
        credentialFiles,
        rechargeProxy,
        readAuthTokens,
        withLeasedGptProxy,
        broadcast,
        getAuthData,
        accountTokens: {...accountTokens, testRt, refreshRtViaPool},
        extractTokens,
        runPool,
        spawnWorker,
    });
    registerTokenToolRoutes(app, {tools: tokenTools});

    return {
        extractTokens,
        runRelogin,
        testRt,
        refreshRtViaPool,
        rechargeProxy,
        dailyMaintenance,
        tsxBin,
        rootDir,
        getAuthData,
        getRtData,
        isGoogleMailbox,
        isMailcomMailbox,
        rtWorker: distributedRtWorker,
    };
}
