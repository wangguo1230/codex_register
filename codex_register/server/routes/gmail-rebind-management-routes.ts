// @ts-nocheck
export function registerGmailRebindManagementRoutes(app, {rebind} = {}) {
    const idsOf = (body) => (body?.ids || []).map(Number).filter(Number.isInteger);
    const send = (res, result) => result.error
        ? res.status(result.status || 400).json({error: result.error})
        : res.json(result);
    const handle = (work, res) => Promise.resolve(work)
        .then((result) => send(res, result))
        .catch((error) => res.status(500).json({error: String(error?.message || error)}));

    app.get("/api/recharge/rebind-gmail/pool", (_req, res) => handle(rebind.listPool(), res));
    app.post("/api/recharge/rebind-gmail/mark-unavailable", (req, res) => handle(rebind.markUnavailable(idsOf(req.body), req.body?.reason), res));
    app.post("/api/recharge/rebind-gmail/migrate", (req, res) => handle(rebind.migrate(idsOf(req.body), {
        probeImap: req.body?.probeImap !== false,
        probeLogin: req.body?.probeLogin === true,
        imapConcurrency: req.body?.imapConcurrency ?? req.body?.concurrency,
    }), res));
    app.post("/api/recharge/rebind-gmail/demote", (req, res) => handle(rebind.demote(idsOf(req.body), req.body?.grp), res));
    app.post("/api/recharge/rebind-gmail", (req, res) => handle(rebind.enqueue(idsOf(req.body), req.body || {}), res));
    app.post("/api/recharge/rebind-gmail/cancel", (req, res) => handle(rebind.cancel(idsOf(req.body)), res));
    app.post("/api/recharge/rebind-gmail/reconcile", (req, res) => handle(rebind.reconcileNow(idsOf(req.body)), res));
}
