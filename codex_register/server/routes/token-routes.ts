// @ts-nocheck
// Token/MFA/聊天 HTTP 适配：业务执行与批次状态由应用服务持有。
export function registerTokenRoutes(app, {store, tokens, batch, mfa, chat} = {}) {
    app.post("/api/accounts/:id/test-at", async (req, res) => {
        const account = await store.get(Number(req.params.id));
        if (!account) return res.status(404).json({error: "账号不存在"});
        res.json(await tokens.testAt(account, {relogin: true}));
    });

    app.post("/api/accounts/:id/test-rt", async (req, res) => {
        const account = await store.get(Number(req.params.id));
        if (!account) return res.status(404).json({error: "账号不存在"});
        res.json(await tokens.testRt(account, {
            updateRt: req.body?.updateRt !== false,
            acquire: req.body?.acquire !== false,
            forceAcquire: req.body?.forceAcquire === true,
        }));
    });

    app.post("/api/control/enroll-mfa", async (req, res) => {
        const ids = (req.body?.ids || []).map(Number).filter(Number.isInteger);
        const result = await mfa.start(ids);
        if (result.error) return res.status(result.status || 400).json({error: result.error});
        res.json(result);
    });

    app.post("/api/control/test-at", async (req, res) => {
        const result = await batch.startAt(req.body?.ids, {relogin: !!req.body?.relogin});
        if (result.error) return res.status(result.status || 400).json({error: result.error});
        res.json(result);
    });

    app.get("/api/control/test-at/status", (_req, res) => res.json(batch.atStatus()));

    app.post("/api/control/test-at/stop", (req, res) => {
        res.json(batch.stopAt({force: req.body?.force === true || req.query?.force === "1"}));
    });

    app.post("/api/control/test-rt", async (req, res) => {
        const result = await batch.startRt(req.body?.ids, {
            updateRt: req.body?.updateRt !== false,
            acquire: req.body?.acquire === true,
            forceAcquire: req.body?.forceAcquire === true,
            retryFailed: req.body?.retryFailed === true,
        });
        if (result.error) return res.status(result.status || 400).json({error: result.error});
        res.json(result);
    });

    app.post("/api/accounts/:id/test-chat", async (req, res) => {
        const account = await store.get(Number(req.params.id));
        if (!account) return res.status(404).json({error: "账号不存在"});
        void chat.run(account, req.body?.message).catch(() => {});
        res.json({ok: true, started: true});
    });

    app.post("/api/control/test-chat", async (req, res) => {
        const accounts = await tokens.pickAccounts(req.body?.ids);
        void chat.runBatch(accounts, req.body?.message || "").catch(() => {});
        res.json({ok: true, count: accounts.length});
    });
}
