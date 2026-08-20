// @ts-nocheck
// Claude 应用服务：订阅查询、禁用判定和养号任务；不处理 HTTP 响应。

export function createClaudeOperations({store, api, runPool, readAuth, getProxyUrl, effects} = {}) {
    let scanRunning = false;
    let scanStopRequested = false;

    const log = (id, line) => {
        store.appendLog(id, line).catch(() => {});
        effects.broadcast("claudeLog", {id, line, ts: Date.now()});
    };

    const broadcastAccountResult = async (result) => {
        effects.broadcast("claude", {stats: await store.stats(), result});
    };

    async function scanAccountDisabled(account) {
        log(account.id, "[禁用检测] 扫邮箱找 Anthropic 禁用/封号通知…");
        try {
            const mail = await api.scanDisabledMail(account.email, account.password, {
                log: (message) => log(account.id, `[禁用检测] ${message}`),
            });
            if (mail.hit) {
                await store.setDeadAt(account.id, Date.now());
                const reason = `禁用通知邮件(${mail.via}): ${(mail.subject || "").slice(0, 80)}`;
                log(account.id, `[禁用检测] ❌ 判定禁用 — ${reason}`);
                return {id: account.id, email: account.email, alive: false, reason, source: "mail"};
            }
        } catch (error) {
            log(account.id, `[禁用检测] 扫邮箱异常 ${String(error?.message || error).slice(0, 60)}(转 API 探测)`);
        }

        const auth = readAuth(account);
        if (!auth) {
            log(account.id, "[禁用检测] 无 auth 数据,邮箱未见禁用 → 存疑(无法 API 探测,不改状态)");
            return {
                id: account.id,
                email: account.email,
                alive: null,
                reason: "邮箱无禁用邮件;无 auth 无法 API 探测",
                source: "mail-only",
            };
        }
        log(account.id, "[禁用检测] 邮箱未见禁用 → API 探测存活(比特浏览器过 CF)…");
        try {
            const result = await api.queryInfo(auth, {
                proxyUrl: getProxyUrl(),
                log: (message) => log(account.id, `[禁用检测] ${message}`),
            });
            await store.setInfo(account.id, {
                plan: result.plan || "",
                claudeCode: result.claudeCode || "",
                alive: !!result.alive,
            });
            log(
                account.id,
                result.alive
                    ? `[禁用检测] ✅ 存活 · ${result.plan || "?"} · claude_code=${result.claudeCode || "?"}`
                    : `[禁用检测] ❌ 判定禁用 — API: ${result.reason || "不存活"}`,
            );
            return {
                id: account.id,
                email: account.email,
                alive: !!result.alive,
                reason: result.reason,
                plan: result.plan,
                claudeCode: result.claudeCode,
                source: "api",
            };
        } catch (error) {
            const reason = String(error?.message || error).slice(0, 60);
            log(account.id, `[禁用检测] ⚠ API 探测异常(不改状态,存疑):${reason}`);
            return {id: account.id, email: account.email, alive: null, reason, source: "api-error"};
        }
    }

    async function startQuery(ids) {
        const accounts = (await Promise.all(ids.map((id) => store.get(id))))
            .filter((account) => account && (account.auth_data || account.auth_file));
        if (!accounts.length) return {ok: true, count: 0, msg: "无可查账号(需注册成功且有 auth 数据)"};
        void (async () => {
            await runPool(accounts, async (account) => {
                const auth = readAuth(account);
                if (!auth) {
                    await store.setInfo(account.id, {alive: false});
                    await broadcastAccountResult({id: account.id, email: account.email, alive: false, reason: "无 auth 数据"});
                    return;
                }
                log(account.id, "[订阅] 查存活/套餐(比特浏览器过 CF)…");
                try {
                    const result = await api.queryInfo(auth, {
                        proxyUrl: getProxyUrl(),
                        log: (message) => log(account.id, `[订阅] ${message}`),
                    });
                    await store.setInfo(account.id, {
                        plan: result.plan || "",
                        claudeCode: result.claudeCode || "",
                        alive: !!result.alive,
                    });
                    log(
                        account.id,
                        result.alive
                            ? `[订阅] ✓ ${result.plan} · claude_code=${result.claudeCode} · tier=${result.tier}`
                            : `[订阅] ✗ ${result.reason}`,
                    );
                    await broadcastAccountResult({id: account.id, email: account.email, ...result});
                } catch (error) {
                    await store.setInfo(account.id, {alive: false});
                    await broadcastAccountResult({
                        id: account.id,
                        email: account.email,
                        alive: false,
                        reason: String(error?.message || error).slice(0, 60),
                    });
                }
            }, 2);
            effects.broadcast("claude", {stats: await store.stats()});
        })().catch((error) => effects.warn("[claude] 订阅查询任务异常:", error?.message || error));
        return {ok: true, count: accounts.length};
    }

    async function startSingleScan(account) {
        void scanAccountDisabled(account)
            .then((result) => broadcastAccountResult(result))
            .catch((error) => effects.warn("[claude] 单号禁用检测异常:", error?.message || error));
        return {ok: true};
    }

    async function startBatchScan(ids) {
        const accounts = (await Promise.all(ids.map((id) => store.get(id)))).filter(Boolean);
        if (!accounts.length) return {ok: true, count: 0, msg: "无可检测账号"};
        if (scanRunning) return {error: "已有禁用检测在跑", status: 409};
        scanRunning = true;
        scanStopRequested = false;
        void (async () => {
            let done = 0;
            effects.broadcast("claudeScan", {running: true, done, total: accounts.length});
            await runPool(accounts, async (account) => {
                if (scanStopRequested) return;
                try {
                    await broadcastAccountResult(await scanAccountDisabled(account));
                } catch (error) {
                    log(account.id, `[禁用检测] 异常 ${String(error?.message || error).slice(0, 60)}`);
                }
                done++;
                effects.broadcast("claudeScan", {running: true, done, total: accounts.length});
            }, 2);
            effects.broadcast("claudeScan", {running: false, done, total: accounts.length});
            effects.broadcast("claude", {stats: await store.stats()});
        })().catch((error) => effects.warn("[claude] 批量禁用检测异常:", error?.message || error))
            .finally(() => { scanRunning = false; });
        return {ok: true, count: accounts.length};
    }

    function stopBatchScan() {
        scanStopRequested = true;
        return {ok: true};
    }

    async function startChat(ids, message = "") {
        const accounts = (await Promise.all(ids.map((id) => store.get(id))))
            .filter((account) => account && (account.auth_data || account.auth_file));
        if (!accounts.length) return {ok: true, count: 0, msg: "无可养号账号"};
        void runPool(accounts, async (account) => {
            const auth = readAuth(account);
            if (!auth) return;
            log(account.id, "[养号] 发消息…");
            try {
                const result = await api.chat(auth, {
                    proxyUrl: getProxyUrl(),
                    log: (line) => log(account.id, `[养号] ${line}`),
                }, message || undefined);
                log(account.id, result.ok ? "[养号] ✓ 已回复" : `[养号] ✗ ${result.reason || `HTTP ${result.status}`}`);
            } catch (error) {
                log(account.id, `[养号] 异常 ${String(error?.message || error).slice(0, 60)}`);
            }
        }, 2).catch((error) => effects.warn("[claude] 养号任务异常:", error?.message || error));
        return {ok: true, count: accounts.length};
    }

    return {startQuery, startSingleScan, startBatchScan, stopBatchScan, startChat, scanAccountDisabled};
}
