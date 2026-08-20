// @ts-nocheck
// GPT 账号浏览器会话服务：持有人工浏览器实例并负责同账号重开时释放旧实例。

export function createAccountBrowserService({store, readAuth, openBrowser, getProxy, log} = {}) {
    const browsers = new Map();

    async function open(accountId) {
        const account = await store.get(accountId);
        if (!account) return {error: "账号不存在", status: 404};
        const record = readAuth(account);
        if (!record) return {error: "无 at 授权数据(该号可能未注册成功/未拿到 at)", status: 400};
        const session = record.session || record;
        const auth = {sessionToken: session.sessionToken || "", cookieString: record.cookie || ""};
        if (!auth.sessionToken && !auth.cookieString) {
            return {error: "授权文件缺 sessionToken/cookie", status: 400};
        }
        const previous = browsers.get(accountId);
        if (previous) {
            try { await previous.close(); } catch { /* 已关闭 */ }
            browsers.delete(accountId);
        }
        log(accountId, "[浏览器] 注入 at 打开 chatgpt …");
        try {
            const browser = await openBrowser(auth, getProxy(), (message) => log(accountId, `[浏览器] ${message}`));
            browsers.set(accountId, browser);
            browser.on("disconnected", () => browsers.delete(accountId));
            return {ok: true};
        } catch (error) {
            log(accountId, `[浏览器] 打开失败: ${error?.message || error}`);
            return {error: String(error?.message || error), status: 500};
        }
    }

    return {open, count: () => browsers.size};
}
