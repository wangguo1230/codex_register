// @ts-nocheck
// Claude HTTP 适配：账号资源、调度命令和后台操作入口。

export function registerClaudeRoutes(app, {store, scheduler, operations, broadcast} = {}) {
    const syncViews = async () => {
        broadcast("claude", {stats: await store.stats()});
        broadcast("mailboxes", {stats: await store.mailboxStats()});
    };

    app.get("/api/claude/accounts", async (_req, res) => {
        res.json({list: await store.list(), stats: await store.stats()});
    });

    app.post("/api/claude/register", (_req, res) => {
        scheduler.start();
        res.json({ok: true, ...scheduler.state()});
    });

    app.post("/api/claude/pause", (_req, res) => {
        scheduler.pause();
        res.json({ok: true, ...scheduler.state()});
    });

    app.post("/api/claude/stop", (_req, res) => {
        scheduler.stop();
        res.json({ok: true, ...scheduler.state()});
    });

    app.delete("/api/claude/accounts/:id", async (req, res) => {
        const id = Number(req.params.id);
        if (scheduler.isRunning(id)) return res.status(409).json({error: "运行中，无法删除"});
        await store.remove(id);
        await syncViews();
        res.json({ok: true});
    });

    app.post("/api/claude/accounts/:id/retry", async (req, res) => {
        const id = Number(req.params.id);
        const account = await store.get(id);
        if (!account) return res.status(404).json({error: "账号不存在"});
        if (scheduler.isRunning(id)) return res.status(409).json({error: "正在运行中"});
        await store.reset(id);
        scheduler.tick();
        broadcast("claude", {stats: await store.stats()});
        res.json({ok: true});
    });

    app.get("/api/claude/batches", async (_req, res) => {
        res.json(await store.listBatches());
    });

    app.post("/api/claude/batch-delete", async (req, res) => {
        const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(Number) : [];
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
        await syncViews();
        res.json({ok: true, count, skipped});
    });

    app.post("/api/claude/export/selected", async (req, res) => {
        const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(Number) : [];
        const accounts = (await Promise.all(ids.map((id) => store.get(id)))).filter(Boolean);
        const text = accounts
            .map((account) => `${account.email}----${account.password}----${account.session_key || ""}----${account.org_id || ""}`)
            .join("\n");
        if (req.body?.markSold && accounts.length) {
            await store.markSold(accounts.map((account) => account.id));
            broadcast("claude", {stats: await store.stats()});
        }
        res.type("text/plain").send(text);
    });

    app.get("/api/claude/accounts/:id/logs", async (req, res) => {
        res.json(await store.listLogs(Number(req.params.id)));
    });

    app.post("/api/claude/query", async (req, res) => {
        const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(Number) : [];
        res.json(await operations.startQuery(ids));
    });

    app.post("/api/claude/accounts/:id/scan-disabled", async (req, res) => {
        const account = await store.get(Number(req.params.id));
        if (!account) return res.status(404).json({error: "账号不存在"});
        res.json(await operations.startSingleScan(account));
    });

    app.post("/api/claude/scan-disabled", async (req, res) => {
        const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(Number) : [];
        const result = await operations.startBatchScan(ids);
        if (result.error) return res.status(result.status || 400).json({error: result.error});
        res.json(result);
    });

    app.post("/api/claude/scan-disabled/stop", (_req, res) => {
        res.json(operations.stopBatchScan());
    });

    app.post("/api/claude/chat", async (req, res) => {
        const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(Number) : [];
        const message = String(req.body?.message || "").trim();
        res.json(await operations.startChat(ids, message));
    });
}
