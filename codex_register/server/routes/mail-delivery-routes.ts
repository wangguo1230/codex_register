// @ts-nocheck
// 发信 HTTP 适配：mail.com 单发/批发，以及充值交付测试发信任务。

export function registerMailDeliveryRoutes(app, {delivery, rechargeLog, broadcast} = {}) {
    const payloadOf = (req) => ({
        email: req.body?.email,
        mailboxId: req.body?.mailboxId,
        password: req.body?.password,
        to: req.body?.to,
        subject: req.body?.subject,
        html: req.body?.html,
        text: req.body?.text,
        fromName: req.body?.fromName,
    });

    app.post("/api/mail/send", async (req, res) => {
        try {
            res.json(await delivery.sendMailbox(payloadOf(req)));
        } catch (error) {
            res.status(400).json({ok: false, error: String(error?.message || error).slice(0, 240)});
        }
    });

    app.post("/api/mailcom/send", async (req, res) => {
        try {
            const result = await delivery.sendOne(payloadOf(req));
            res.json(result);
        } catch (error) {
            res.status(400).json({ok: false, error: String(error?.message || error).slice(0, 240)});
        }
    });

    app.post("/api/mailcom/send-batch", async (req, res) => {
        const items = Array.isArray(req.body?.items) ? req.body.items : [];
        if (!items.length) return res.status(400).json({error: "items 为空"});
        try {
            res.json(await delivery.sendBatch(items, {concurrency: req.body?.concurrency}));
        } catch (error) {
            res.status(400).json({ok: false, error: String(error?.message || error).slice(0, 240)});
        }
    });

    app.get("/api/mailcom/send-logs", async (req, res) => {
        const items = await delivery.listLogs({
            email: String(req.query.email || ""),
            limit: Number(req.query.limit || 50),
        });
        res.json({ok: true, items});
    });

    app.get("/api/mail/send-logs", async (req, res) => {
        const items = await delivery.listLogs({
            email: String(req.query.email || ""),
            limit: Number(req.query.limit || 50),
        });
        res.json({ok: true, items});
    });

    app.post("/api/recharge/queue/send-preview", async (req, res) => {
        const ids = (req.body?.ids || []).map(Number).filter(Number.isInteger);
        if (!ids.length) return res.status(400).json({error: "未选择账号"});
        try {
            res.json(await delivery.preview(ids, String(req.body?.to || "")));
        } catch (error) {
            res.status(400).json({ok: false, error: String(error?.message || error).slice(0, 240)});
        }
    });

    app.post("/api/recharge/queue/test-send", async (req, res) => {
        const ids = (req.body?.ids || []).map(Number).filter(Number.isInteger);
        if (!ids.length) return res.status(400).json({error: "未选择账号"});
        try {
            const result = await delivery.startTest(ids, {
                to: req.body?.to,
                subject: req.body?.subject,
                html: req.body?.html,
                text: req.body?.text,
                concurrency: req.body?.concurrency,
                log: rechargeLog,
                onDone: (done) => {
                    const summary = `测试发信 ${done?.sent || 0} 成功 / ${done?.failed || 0} 失败 / ${done?.skipped || 0} 跳过 → ${done?.to || ""}`;
                    rechargeLog(done?.error ? `${summary} · 原因: ${done.error}` : summary);
                    broadcast("rechargeSendDone", {
                        ok: !!done?.ok,
                        sent: done?.sent || 0,
                        failed: done?.failed || 0,
                        skipped: done?.skipped || 0,
                        to: done?.to || "",
                        error: done?.error || "",
                        stopped: !!delivery.getTestJob().stop,
                    });
                },
            });
            rechargeLog(`测试发信已开始 ${result.queued} 封 → ${result.to}（后台跑，进度看日志）`);
            res.json(result);
        } catch (error) {
            const message = String(error?.message || error).slice(0, 240);
            res.status(/已有/.test(message) ? 409 : 400).json({ok: false, error: message});
        }
    });

    app.get("/api/recharge/queue/test-send", (_req, res) => {
        res.json({ok: true, ...delivery.getTestJob()});
    });

    app.post("/api/recharge/queue/test-send/stop", (_req, res) => {
        const result = delivery.stopTest();
        if (result.running) rechargeLog("已请求停止测试发信，当前这封跑完就停");
        res.json(result);
    });
}
