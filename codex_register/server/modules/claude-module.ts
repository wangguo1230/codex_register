// @ts-nocheck
// Claude 模块装配：账号资源、注册调度、订阅查询、禁用扫描与聊天。
import {queryClaudeInfo, claudeChat} from "../../src/claude-api.js";
import {scanClaudeDisabledMail} from "../domain/mailbox-service.js";
import {createClaudeOperations} from "../domain/claude-operations.js";
import {registerClaudeRoutes} from "../routes/claude-routes.js";

export function registerClaudeModule({app, db, scheduler, broadcast, runPool, readAuth} = {}) {
    const operations = createClaudeOperations({
        store: {
            get: (id) => db.getClaudeAccount(id),
            stats: () => db.claudeStats(),
            setInfo: (id, state) => db.setClaudeInfo(id, state),
            setDeadAt: (id, timestamp) => db.setClaudeDeadAt(id, timestamp),
            appendLog: (id, line) => db.appendClaudeLog(id, line),
        },
        api: {queryInfo: queryClaudeInfo, scanDisabledMail: scanClaudeDisabledMail, chat: claudeChat},
        runPool,
        readAuth,
        getProxyUrl: () => scheduler.claudeProxy || scheduler.regProxy,
        effects: {broadcast, warn: (...args) => console.warn(...args)},
    });
    registerClaudeRoutes(app, {
        store: {
            list: () => db.listClaudeAccounts(),
            get: (id) => db.getClaudeAccount(id),
            stats: () => db.claudeStats(),
            mailboxStats: () => db.mailboxStats(),
            remove: (id) => db.deleteClaudeAccount(id),
            reset: (id) => db.resetClaudeToPending(id),
            listBatches: () => db.claudeBatches(),
            markSold: (ids) => db.markClaudeSold(ids),
            listLogs: (id) => db.listClaudeLogs(id),
        },
        scheduler: {
            start: () => scheduler.startClaude(),
            pause: () => scheduler.pauseClaude(),
            stop: () => scheduler.stopClaude(),
            state: () => scheduler.state(),
            isRunning: (id) => scheduler.isRunning(id, "claude"),
            tick: () => scheduler.tick(),
        },
        operations,
        broadcast,
    });
    return operations;
}
