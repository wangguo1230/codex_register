// @ts-nocheck
// 邮箱任务 HTTP 适配：统一改密、Gmail 整备、2FA、续跑和停止入口。

export function registerMailJobRoutes(app, {
    store,
    jobs,
    randomPassword,
    setConcurrency,
    refreshLegacyPasswordProgress,
    logMailbox,
} = {}) {
    app.post("/api/mailboxes/:id/change-passwd", async (req, res) => {
        const id = Number(req.params.id);
        const mailbox = await store.getMailbox(id);
        if (!mailbox) return res.status(404).json({error: "邮箱不存在"});
        const newPassword = String(req.body.newPassword || "").trim() || randomPassword(20);
        await jobs.begin();
        const enqueued = await store.enqueue([{
            id: mailbox.id,
            email: mailbox.email,
            payload: {oldPw: mailbox.password, newPassword},
        }], "pw");
        logMailbox(id, `[改密] 已入队 预定新密码=${newPassword}`);
        jobs.afterEnqueue();
        res.json({ok: true, queued: true, newPassword, count: enqueued.inserted});
    });

    app.post("/api/mailboxes/:id/google-harden", async (req, res) => {
        const id = Number(req.params.id);
        if (!Number.isInteger(id)) return res.status(400).json({error: "bad id"});
        const started = await jobs.startHarden([id]);
        if (started.error) {
            const status = /已有/.test(started.error)
                ? 409
                : (/不存在|仅 Gmail|未选择/.test(started.error) ? 400 : 500);
            return res.status(status).json({error: started.error});
        }
        res.json({ok: true, queued: true, ...started});
    });

    app.post("/api/mailboxes/batch-google-harden", async (req, res) => {
        const ids = (req.body?.ids || []).map(Number).filter(Number.isInteger);
        const started = await jobs.startHarden(ids);
        if (started.error) return res.status(400).json({error: started.error});
        res.json(started);
    });

    app.post("/api/mailboxes/batch-google-harden/stop", async (_req, res) => {
        res.json(await jobs.stopAll());
    });

    app.post("/api/mailboxes/batch-google-harden/resume", async (req, res) => {
        const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(Number) : null;
        res.json(await jobs.resume({onlyError: false, ids}));
    });

    app.post("/api/mailboxes/jobs/retry-failed", async (req, res) => {
        const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(Number) : null;
        res.json(await jobs.resume({onlyError: true, ids}));
    });

    app.get("/api/mailboxes/jobs/latest-errors", async (_req, res) => {
        const items = await store.listNewestErrors("harden").catch(() => []);
        res.json({ok: true, emails: items.map((item) => item.email).filter(Boolean), count: items.length});
    });

    app.get("/api/mailboxes/job", async (_req, res) => {
        await jobs.refreshWindows({listBit: false});
        const job = jobs.snapshot();
        res.json({ok: true, batchHarden: job, batchPw: job, job, instances: jobs.getInstances()});
    });

    app.post("/api/mailboxes/:id/google-2fa", async (req, res) => {
        const id = Number(req.params.id);
        const mailbox = await store.getMailbox(id);
        if (!mailbox) return res.status(404).json({error: "邮箱不存在"});
        if (mailbox.provider !== "google") return res.status(400).json({error: "仅 Gmail 老号可换 Google 2FA"});
        await jobs.begin();
        const enqueued = await store.enqueue([{id: mailbox.id, email: mailbox.email}], "2fa");
        logMailbox(id, "[2FA] 已入队，空闲代理会认领");
        jobs.afterEnqueue();
        res.json({ok: true, queued: true, count: enqueued.inserted, skipped: enqueued.inserted ? 0 : 1});
    });

    app.post("/api/mailboxes/batch-change-passwd", async (req, res) => {
        const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(Number) : [];
        const mailboxes = (await Promise.all(ids.map((id) => store.getMailbox(id)))).filter(Boolean);
        if (!mailboxes.length) return res.json({ok: true, count: 0, msg: "未选择有效邮箱"});
        await jobs.begin();
        const enqueued = await store.enqueue(mailboxes.map((mailbox) => ({
            id: mailbox.id,
            email: mailbox.email,
            payload: {oldPw: mailbox.password},
        })), "pw");
        jobs.afterEnqueue();
        res.json({ok: true, count: enqueued.inserted, skipped: mailboxes.length - enqueued.inserted, queued: true});
    });

    app.post("/api/control/batch-passwd/stop", async (_req, res) => {
        const result = await jobs.stopAll();
        res.json({ok: true, cancelled: result.canceled, closed: result.closed});
    });

    app.post("/api/control/pw-queue/clear", async (_req, res) => {
        await store.clearLegacyPasswordQueue();
        await refreshLegacyPasswordProgress();
        res.json({ok: true});
    });

    app.post("/api/control/pw-concurrency", (req, res) => {
        res.json({ok: true, pwConcurrency: setConcurrency(req.body?.pwConcurrency)});
    });
}
