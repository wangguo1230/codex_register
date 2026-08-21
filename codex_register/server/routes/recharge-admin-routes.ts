// @ts-nocheck
export function registerRechargeAdminRoutes(app, {admin} = {}) {
    const idsOf = (body) => (body?.ids || []).map(Number).filter(Number.isInteger);
    const send = (res, result) => result.error
        ? res.status(result.status || 400).json({error: result.error})
        : res.json(result);

    app.get("/api/recharge/logs", async (_req, res) => res.json(await admin.listLogs()));
    app.post("/api/recharge/logs/clear", async (_req, res) => res.json(await admin.clearLogs()));
    app.get("/api/recharge/config", async (_req, res) => res.json(await admin.getConfig()));
    app.get("/api/recharge/jobs", (_req, res) => res.json(admin.getJobs()));
    app.post("/api/recharge/config", async (req, res) => res.json(await admin.updateConfig(req.body || {})));
    app.get("/api/recharge/cards", async (_req, res) => res.json(await admin.listCards()));
    app.post("/api/recharge/cards/import", async (req, res) => send(res, await admin.importCards(req.body?.text, req.body?.batch)));
    app.post("/api/recharge/cards/delete", async (req, res) => res.json(await admin.deleteCards(idsOf(req.body))));
    app.post("/api/recharge/cards/unpair", async (req, res) => res.json(await admin.unpairCards(idsOf(req.body))));
    app.post("/api/recharge/cards/validate", async (req, res) => send(res, await admin.startValidation(idsOf(req.body))));
    app.post("/api/recharge/cards/reset", async (req, res) => send(res, await admin.startReset(idsOf(req.body))));
}
