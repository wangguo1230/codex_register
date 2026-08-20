// @ts-nocheck
// GPT 账号资源模块装配：导入、查询、编辑、重试和授权浏览器入口。
import {openBrowserWithAuth} from "../../src/simulate-chat.js";
import {createAccountBrowserService} from "../domain/account-browser-service.js";
import {registerAccountRoutes} from "../routes/account-routes.js";

export function registerAccountModule({app, db, scheduler, parseAccounts, readAuth, logAccount, broadcast} = {}) {
    const browser = createAccountBrowserService({
        store: {get: (id) => db.getAccount(id)},
        readAuth,
        openBrowser: openBrowserWithAuth,
        getProxy: () => scheduler.regProxy,
        log: logAccount,
    });
    registerAccountRoutes(app, {
        store: {
            import: (rows, batch, provider) => db.importAccounts(rows, batch, provider),
            list: (status, includeDeleted) => db.listAccounts(status, false, includeDeleted),
            get: (id) => db.getAccount(id),
            listLogs: (id) => db.listLogs(id),
            update: (id, fields) => db.updateAccount(id, fields),
            remove: (id) => db.deleteAccount(id),
            markSold: (ids, sold) => db.markSold(ids, sold),
            stats: () => db.stats(),
            mailboxStats: () => db.mailboxStats(),
        },
        scheduler: {
            retry: (id) => scheduler.retry(id),
            isRunning: (id) => scheduler.isRunning(id),
            tick: () => scheduler.tick(),
        },
        parseAccounts,
        browser,
        broadcast,
    });
    return browser;
}
