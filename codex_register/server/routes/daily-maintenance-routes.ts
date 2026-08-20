// @ts-nocheck
// 每日维护 HTTP 适配。

export function registerDailyMaintenanceRoutes(app, {daily} = {}) {
    app.post("/api/control/daily", (req, res) => {
        const {enabled, hour, items} = req.body || {};
        res.json({
            ok: true,
            daily: daily.configure({enabled, hour: hour == null ? undefined : Number(hour), items}),
        });
    });

    app.post("/api/control/daily/run", async (_req, res) => {
        if (daily.isRunning()) return res.status(409).json({error: "维护正在进行中"});
        res.json({ok: true, started: true, accounts: await daily.countSuccess()});
        void daily.run("manual");
    });
}
