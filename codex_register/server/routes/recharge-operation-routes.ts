// @ts-nocheck
export function registerRechargeOperationRoutes(app, {submit, relogin, poll, recovery, admin} = {}) {
    const idsOf = (values) => (values || []).map(Number).filter(Number.isInteger);
    const send = (res, result) => result.error
        ? res.status(result.status || 400).json(result.skipped ? {error: result.error, skipped: result.skipped} : {error: result.error})
        : res.json(result);

    app.post("/api/recharge/submit", async (req, res) => send(res, await submit.start(idsOf(req.body?.queueIds))));
    app.post("/api/recharge/stop", (req, res) => {
        admin.stopValidation();
        res.json(submit.stop({force: !!req.body?.force}));
    });
    app.post("/api/recharge/poll", async (req, res) => send(res, await poll.refresh(idsOf(req.body?.ids))));
    app.post("/api/recharge/queue/relogin", async (req, res) => send(res, await relogin.start(idsOf(req.body?.ids))));
    app.post("/api/recharge/queue/relogin/stop", (_req, res) => res.json(relogin.stop()));
    app.post("/api/recharge/queue/relogin-submit", async (req, res) => send(res, await relogin.startAndSubmit(idsOf(req.body?.ids))));
    app.post("/api/recharge/recover", async (req, res) => send(res, await recovery.recover(idsOf(req.body?.ids))));
}
