// @ts-nocheck
export function registerRechargeExportRoutes(app, {exports} = {}) {
    const idsOf = (values) => (values || []).map(Number).filter(Number.isInteger);
    const send = (res, result) => {
        if (result.error) return res.status(result.status || 400).json({error: result.error});
        if (result.contentType) return res.set("Content-Type", result.contentType).send(result.text);
        return res.json(result);
    };

    app.post("/api/recharge/queue/export", async (req, res) => send(res, await exports.exportQueue(req.body || {})));
    app.post("/api/recharge/queue/export-sub2json", async (req, res) => send(res, await exports.exportSub2json(idsOf(req.body?.ids), req.body?.concurrency)));
    app.post("/api/recharge/queue/export/stop", (_req, res) => res.json(exports.stop()));
    app.post("/api/recharge/queue/probe-plan", async (req, res) => send(res, await exports.probePlans(idsOf(req.body?.ids), req.body?.batch || "")));
}
