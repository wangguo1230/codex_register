// @ts-nocheck
// Token 批量工具工厂：独立 Worker、凭证适配和批处理服务。
import {cleanSpawnEnv} from "../strip-env-proxy.js";
import {pickBrowserCompatibleProxy as pickMailcomBrowserProxy} from "../domain/gpt-proxy-lease.js";
import {pipeWorkerOutput} from "../domain/worker-output.js";
import {createTokenWorkerRunner} from "../domain/token-worker-runner.js";
import {createTokenToolService} from "../domain/token-tool-service.js";
import {extractSession, readSessionFromFile} from "../domain/account-credential-format.js";
import {buildProxyDispatcher, refreshRt} from "../../src/token-check.js";
import {pickXrayBrowserProxy} from "../xray-proxy.js";

export function createTokenToolFactory({
    db,
    scheduler,
    config,
    credentialFiles,
    rechargeProxy,
    readAuthTokens,
    withLeasedGptProxy,
    broadcast,
    getAuthData,
    accountTokens,
    extractTokens,
    runPool,
    spawnWorker,
} = {}) {
    const tokenToolWorkers = createTokenWorkerRunner({
        store: {
            getMailbox: (email) => db.getMailboxByEmail?.(email),
            getAccount: (email) => db.getAccountByEmail(email),
        },
        runtime: {spawn: spawnWorker, cleanEnv: cleanSpawnEnv, pipeOutput: pipeWorkerOutput},
        settings: {
            providerOf: (email) => /@(gmail|googlemail)\.com$/i.test(email) ? "google" : email.endsWith("@icloud.com") ? "icloud" : "mailcom",
            regProxy: () => scheduler.regProxy || "",
            rechargeProxy,
            mailProxy: () => scheduler.mailProxyEnabled !== false ? (scheduler.mailProxy || "") : "",
            defaultPassword: () => String(config.defaultPassword || ""),
            smsLinkTemplate: () => scheduler.smsLinkTemplate || "",
        },
        files: {writeCredential: credentialFiles.writeMailbox, readTokens: readAuthTokens},
        withProxy: withLeasedGptProxy,
        pickMailProxy: async () => {
            const configured = scheduler.mailProxyEnabled !== false ? (scheduler.mailProxy || "") : "";
            return await pickXrayBrowserProxy(configured, rechargeProxy(), scheduler.rtProxy)
                || pickMailcomBrowserProxy(configured, rechargeProxy(), scheduler.rtProxy);
        },
        effects: {log: (kind, email, message) => broadcast("log", {id: 0, line: `[批量${kind}] ${email}: ${message}`, ts: Date.now()})},
    });
    const tokenTools = createTokenToolService({
        store: {
            listSuccess: () => db.listAccounts("success"),
            getAccount: (id) => db.getAccount(id),
            getAccountByEmail: (email) => db.getAccountByEmail(email),
            getMailbox: (email) => db.getMailboxByEmail?.(email),
            setRtFile: (id, file, data) => db.setAccountRtFile(
                id,
                credentialFiles.writeRtForAccount?.(id, data) || file || "",
                data,
            ),
            readAuth: getAuthData,
            readJson: credentialFiles.readJson,
            readSessionFile: (file) => readSessionFromFile(file, credentialFiles.readJson),
        },
        workers: tokenToolWorkers,
        tokens: {
            testAt: accountTokens.testAt,
            extract: extractTokens,
            extractSession,
            refreshRt,
            buildDispatcher: buildProxyDispatcher,
            syncPlan: accountTokens.syncPlan,
        },
        refreshRtViaPool: accountTokens.refreshRtViaPool,
        runPool,
        effects: {
            broadcast,
            log: (kind, email, message) => broadcast("log", {id: 0, line: `[批量${kind}] ${email}: ${message}`, ts: Date.now()}),
            rootLog: (line) => broadcast("log", {id: 0, line, ts: Date.now()}),
            warn: (...args) => console.warn(...args),
        },
        config: {
            rtProxy: () => scheduler.rtProxy || "",
            regProxy: () => scheduler.regProxy || "",
            rtConcurrency: () => scheduler.rtConcurrency,
            defaultPassword: () => String(config.defaultPassword || ""),
        },
    });

    return tokenTools;
}
