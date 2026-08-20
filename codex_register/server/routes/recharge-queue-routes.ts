// @ts-nocheck
export function registerRechargeQueueRoutes(app, {queue} = {}) {
    const idsOf = (body) => queue.idsOf(body?.ids);
    const send = (res, result) => result.error
        ? res.status(result.status || 400).json({error: result.error})
        : res.json(result);

    app.get("/api/recharge/accounts", async (_req, res) => res.json(await queue.listRechargeableAccounts()));
    app.get("/api/recharge/queue", async (req, res) => res.json(await queue.list(String(req.query?.delivery || "undelivered"))));
    app.get("/api/recharge/queue/batches", async (req, res) => res.json(await queue.listBatches(String(req.query?.delivery || "undelivered"))));
    app.post("/api/recharge/queue/add", async (req, res) => send(res, await queue.add(queue.idsOf(req.body?.accountIds), req.body?.batch)));
    app.post("/api/recharge/queue/remove", async (req, res) => send(res, await queue.deliver(idsOf(req.body), true)));
    app.post("/api/recharge/queue/deliver", async (req, res) => send(res, await queue.deliver(idsOf(req.body))));
    app.post("/api/recharge/queue/undeliver", async (req, res) => send(res, await queue.undeliver(idsOf(req.body))));
    app.post("/api/recharge/queue/set-batch", async (req, res) => send(res, await queue.setBatch(idsOf(req.body), req.body?.batch)));
    app.post("/api/recharge/queue/reset", async (req, res) => send(res, await queue.reset(idsOf(req.body))));
    app.post("/api/recharge/queue/mark-error", async (req, res) => send(res, await queue.markError(idsOf(req.body), req.body?.error || req.body?.reason)));
    app.post("/api/recharge/queue/reclaim-cards", async (req, res) => send(res, await queue.reclaimCards(idsOf(req.body))));
}
