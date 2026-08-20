// @ts-nocheck
export function registerSmsRoutes(app, {smsService} = {}) {
    app.post("/api/sms/import", async (req, res) => {
        const result = await smsService.importRows(req.body?.text, {verify: req.body?.verify !== false});
        if (result.error) return res.status(result.status || 400).json({error: result.error});
        res.json(result);
    });

    app.get("/api/sms", async (_req, res) => res.json(await smsService.list()));

    app.delete("/api/sms/:id", async (req, res) => {
        res.json(await smsService.remove(Number(req.params.id)));
    });

    app.get("/api/sms/:id/peek", async (req, res) => {
        const result = await smsService.peek(Number(req.params.id));
        if (result.error) return res.status(result.status || 500).json({error: result.error});
        res.json(result);
    });
}
