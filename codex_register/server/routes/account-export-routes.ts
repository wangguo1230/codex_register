// @ts-nocheck
// 账号凭证导出 HTTP 适配。

export function registerAccountExportRoutes(app, {exports} = {}) {
    app.get("/api/accounts/:id/session", async (req, res) => {
        const result = await exports.getSession(Number(req.params.id));
        if (result.error) return res.status(result.status || 400).json({error: result.error});
        res.json(result);
    });

    app.post("/api/export/full", async (req, res) => {
        const result = await exports.exportAccounts(req.body || {});
        res.set("Content-Type", result.contentType);
        res.send(result.text);
    });

    app.get("/api/batches", async (_req, res) => res.json(await exports.listBatches()));
}
