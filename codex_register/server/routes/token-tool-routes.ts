// @ts-nocheck
// 批量 Token 工具 HTTP 适配。

export function registerTokenToolRoutes(app, {tools} = {}) {
    app.post("/api/tools/batch-refresh-at", async (req, res) => {
        const result = await tools.startAt(req.body || {});
        if (result.error) return res.status(result.status || 400).json({error: result.error});
        res.json(result);
    });

    app.post("/api/tools/batch-refresh-at/stop", (_req, res) => res.json(tools.stopAt()));

    app.post("/api/tools/refresh-tokens", async (req, res) => {
        const result = await tools.refreshTokens(req.body?.items);
        if (result.error) return res.status(result.status || 400).json({error: result.error});
        res.json(result);
    });

    app.post("/api/tools/batch-acquire-rt", async (req, res) => {
        const result = await tools.startRt(req.body?.lines);
        if (result.error) return res.status(result.status || 400).json({error: result.error});
        res.json(result);
    });

    app.post("/api/tools/batch-acquire-rt/stop", (_req, res) => res.json(tools.stopRt()));
}
