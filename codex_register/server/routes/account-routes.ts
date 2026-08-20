// @ts-nocheck
// GPT 账号基础 HTTP 适配：参数校验、响应码和视图同步，不承载注册与 Token 流程。

export function registerAccountRoutes(app, {store, scheduler, parseAccounts, browser, broadcast} = {}) {
    app.post("/api/accounts/import", async (req, res) => {
        const rows = parseAccounts(req.body.text, req.body.defaultPassword);
        if (!rows.length) {
            return res.status(400).json({error: "未解析到有效的 邮箱+密码 行(支持 email----pwd / email:pwd / email pwd)"});
        }
        const result = await store.import(
            rows,
            String(req.body.batch || "").trim(),
            String(req.body.provider || "mailcom"),
        );
        broadcast("snapshot", await store.list());
        broadcast("stats", await store.stats());
        scheduler.tick();
        res.json(result);
    });

    app.get("/api/accounts", async (req, res) => {
        res.json(await store.list(req.query.status, req.query.deleted === "1"));
    });

    app.get("/api/accounts/:id", async (req, res) => {
        const id = Number(req.params.id);
        const account = Number.isInteger(id) ? await store.get(id) : null;
        return account ? res.json(account) : res.status(404).json({error: "账号不存在"});
    });

    app.get("/api/accounts/:id/logs", async (req, res) => {
        res.json(await store.listLogs(Number(req.params.id)));
    });

    app.post("/api/accounts/:id/retry", (req, res) => {
        res.json({ok: scheduler.retry(Number(req.params.id))});
    });

    app.post("/api/accounts/:id/open-browser", async (req, res) => {
        const result = await browser.open(Number(req.params.id));
        if (result.error) return res.status(result.status || 500).json({error: result.error});
        res.json(result);
    });

    app.delete("/api/accounts/:id", async (req, res) => {
        const id = Number(req.params.id);
        if (scheduler.isRunning(id)) return res.status(409).json({error: "运行中，无法删除"});
        await store.remove(id);
        broadcast("snapshot", await store.list());
        broadcast("stats", await store.stats());
        broadcast("mailboxes", {stats: await store.mailboxStats()});
        res.json({ok: true});
    });

    app.patch("/api/accounts/:id", async (req, res) => {
        const id = Number(req.params.id);
        const account = await store.get(id);
        if (!account) return res.status(404).json({error: "账号不存在"});
        if (scheduler.isRunning(id)) return res.status(409).json({error: "运行中，无法编辑"});
        const body = req.body || {};
        const fields = {};
        for (const key of [
            "email", "password", "status", "plan", "phone", "card", "at_status", "rt_status",
            "chat_status", "error", "gpt_password", "totp_secret", "mfa_status",
        ]) {
            if (typeof body[key] === "string") fields[key] = body[key].trim();
        }
        if (typeof body.dead === "boolean") fields.dead_at = body.dead ? (account.dead_at || Date.now()) : 0;
        if (typeof body.sold === "boolean") fields.sold_at = body.sold ? (account.sold_at || Date.now()) : 0;
        try {
            if (Object.keys(fields).length) await store.update(id, fields);
        } catch (error) {
            return res.status(400).json({error: `更新失败(邮箱可能重复): ${error?.message || error}`});
        }
        broadcast("snapshot", await store.list());
        res.json({ok: true, account: await store.get(id)});
    });

    app.post("/api/accounts/batch-delete", async (req, res) => {
        const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(Number) : [];
        if (!ids.length) return res.status(400).json({error: "未选择账号"});
        let count = 0;
        let skipped = 0;
        for (const id of ids) {
            if (scheduler.isRunning(id)) {
                skipped++;
                continue;
            }
            try {
                await store.remove(id);
                count++;
            } catch { /* 单条删除失败不阻断批次 */ }
        }
        broadcast("snapshot", await store.list());
        broadcast("stats", await store.stats());
        broadcast("mailboxes", {stats: await store.mailboxStats()});
        res.json({ok: true, count, skipped});
    });

    app.post("/api/accounts/set-batch", async (req, res) => {
        const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(Number) : [];
        const batch = String(req.body?.batch || "").trim();
        if (!ids.length) return res.status(400).json({error: "未选择账号"});
        let count = 0;
        for (const id of ids) {
            try {
                await store.update(id, {batch});
                count++;
            } catch { /* 单条更新失败不阻断批次 */ }
        }
        broadcast("snapshot", await store.list());
        res.json({ok: true, count});
    });

    app.post("/api/accounts/set-sold", async (req, res) => {
        const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(Number).filter(Number.isInteger) : [];
        const sold = req.body?.sold !== false;
        if (!ids.length) return res.status(400).json({error: "未选择账号"});
        const count = await store.markSold(ids, sold);
        broadcast("snapshot", await store.list());
        broadcast("stats", await store.stats());
        res.json({ok: true, count, sold});
    });
}
