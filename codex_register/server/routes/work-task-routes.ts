// @ts-nocheck
// 分布式任务控制面只提供观测和人工恢复，不自动回收其他实例的活跃租约。
export function registerWorkTaskRoutes(app, {store} = {}) {
    app.get("/api/control/work-tasks", async (req, res) => {
        try {
            res.json({ok: true, kind: String(req.query?.kind || ""), stats: await store.stats(String(req.query?.kind || ""))});
        } catch (error) {
            res.status(500).json({error: String(error?.message || error).slice(0, 200)});
        }
    });

    app.post("/api/control/work-tasks/recover", async (req, res) => {
        try {
            const ids = Array.isArray(req.body?.ids) ? req.body.ids : null;
            const count = await store.recover({
                kind: String(req.body?.kind || ""),
                ids,
                staleMs: req.body?.staleMs,
            });
            res.json({ok: true, count});
        } catch (error) {
            res.status(500).json({error: String(error?.message || error).slice(0, 200)});
        }
    });
}
