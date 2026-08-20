// @ts-nocheck
// 系统控制 HTTP 适配：调度设置、代理/Xray 控制和全局状态查询。

export function registerControlRoutes(app, {
    scheduler,
    instanceId,
    bitHealth,
    setMailProxy,
    stats,
    mailJobs,
    xray,
} = {}) {
    const statePayload = () => {
        try {
            return {ok: true, ...scheduler.state()};
        } catch (error) {
            console.warn("[control] state() 失败，回退精简包:", error?.message || error);
            return {
                ok: true,
                instanceId,
                paused: scheduler.paused,
                pausedClaude: scheduler.pausedClaude,
                concurrency: scheduler.concurrency,
                regEngine: scheduler.regEngine,
                bitBrowser: scheduler.bitBrowser,
                running: [...scheduler.running.values()].filter((item) => item.domain === "gpt").map((item) => item.id),
                runningClaude: [...scheduler.running.values()].filter((item) => item.domain === "claude").map((item) => item.id),
            };
        }
    };

    app.post("/api/control/start", (req, res) => {
        try {
            const concurrency = req.body?.concurrency;
            if (concurrency != null && concurrency !== "") {
                scheduler.concurrency = Math.max(1, Math.min(16, Number(concurrency) || 1));
                try { scheduler.saveSettings(); } catch (error) {
                    console.warn("[control/start] saveSettings:", error?.message || error);
                }
            }
            scheduler.paused = false;
            void Promise.resolve(scheduler.tick()).catch((error) => {
                console.error("[control/start] tick:", error?.message || error);
            });
            res.json(statePayload());
        } catch (error) {
            console.error("[control/start]", error);
            res.status(500).json({error: String(error?.message || error || "start failed")});
        }
    });

    app.post("/api/control/pause", (_req, res) => {
        try {
            scheduler.pause();
            res.json(statePayload());
        } catch (error) {
            res.status(500).json({error: String(error?.message || error)});
        }
    });

    app.post("/api/control/stop", (_req, res) => {
        try {
            scheduler.stopAll();
            res.json(statePayload());
        } catch (error) {
            res.status(500).json({error: String(error?.message || error)});
        }
    });

    app.post("/api/control/concurrency", (req, res) => {
        res.json({ok: true, concurrency: scheduler.setConcurrency(req.body?.concurrency)});
    });

    app.post("/api/control/otp", (req, res) => {
        scheduler.otpSingle = !!req.body?.single;
        scheduler.saveSettings();
        res.json({ok: true, otpSingle: scheduler.otpSingle});
    });

    app.post("/api/control/mail-separator", (req, res) => {
        const separator = String(req.body?.separator || "").trim();
        if (!separator) return res.status(400).json({error: "分隔符不能为空"});
        scheduler.mailSeparator = separator;
        scheduler.saveSettings();
        res.json({ok: true, mailSeparator: scheduler.mailSeparator});
    });

    app.post("/api/control/chat", (req, res) => {
        scheduler.simulateChat = !!req.body?.simulate;
        scheduler.saveSettings();
        res.json({ok: true, simulateChat: scheduler.simulateChat});
    });

    app.post("/api/control/sms", (req, res) => {
        if (typeof req.body?.enabled === "boolean") scheduler.smsEnabled = req.body.enabled;
        if (typeof req.body?.linkTemplate === "string") scheduler.smsLinkTemplate = req.body.linkTemplate.trim();
        if (typeof req.body?.maxBind === "number") scheduler.smsMaxBind = Math.max(0, Math.floor(req.body.maxBind));
        scheduler.saveSettings();
        res.json({
            ok: true,
            smsEnabled: scheduler.smsEnabled,
            smsLinkTemplate: scheduler.smsLinkTemplate,
            smsMaxBind: scheduler.smsMaxBind,
        });
    });

    app.post("/api/control/engine", (req, res) => {
        const engine = String(req.body?.engine || "").trim();
        if (engine === "http" || engine === "browser") {
            scheduler.regEngine = engine;
            scheduler.saveSettings();
        }
        res.json({ok: true, regEngine: scheduler.regEngine});
    });

    app.post("/api/control/delete-mailbox", (_req, res) => res.json({ok: true}));

    app.post("/api/control/rt", (req, res) => {
        if (typeof req.body?.enabled === "boolean") scheduler.rtEnabled = req.body.enabled;
        scheduler.saveSettings();
        res.json({ok: true, rtEnabled: scheduler.rtEnabled});
    });

    app.post("/api/control/mfa", (req, res) => {
        if (typeof req.body?.enabled === "boolean") scheduler.mfaEnabled = req.body.enabled;
        scheduler.saveSettings();
        res.json({ok: true, mfaEnabled: scheduler.mfaEnabled !== false});
    });

    app.post("/api/control/bit", async (req, res) => {
        if (req.body?.enabled === true && !await bitHealth()) {
            return res.status(400).json({error: "比特浏览器 Local API 未响应(127.0.0.1:54345)，请先打开比特客户端"});
        }
        if (typeof req.body?.enabled === "boolean") scheduler.bitBrowser = req.body.enabled;
        scheduler.saveSettings();
        res.json({ok: true, bitBrowser: scheduler.bitBrowser});
    });

    app.post("/api/control/claude-proxy", (req, res) => {
        res.json(xray.setClaudeProxy(req.body?.proxy));
    });

    app.post("/api/control/proxy-ports", (req, res) => {
        const result = xray.setProxyPorts(req.body || {});
        if (result.error) return res.status(400).json({error: result.error});
        res.json(result);
    });

    app.post("/api/control/claude-xray", (req, res) => {
        const result = xray.startClaude(req.body?.vlessUrl);
        if (result.error) return res.status(400).json({error: result.error});
        res.json(result);
    });

    app.post("/api/control/claude-xray/stop", (_req, res) => res.json(xray.stopClaude()));

    app.post("/api/control/jump-xray", async (req, res) => {
        const result = await xray.startJump(req.body?.vlessUrl);
        if (result.error) return res.status(400).json({error: result.error});
        res.json(result);
    });

    app.post("/api/control/jump-xray/stop", (_req, res) => res.json(xray.stopJump()));

    app.post("/api/control/proxy", (req, res) => {
        if (typeof req.body?.regProxy === "string") scheduler.regProxy = req.body.regProxy.trim();
        if (typeof req.body?.mailProxy === "string") scheduler.mailProxy = req.body.mailProxy.trim();
        if (typeof req.body?.mailProxyEnabled === "boolean") scheduler.mailProxyEnabled = req.body.mailProxyEnabled;
        setMailProxy(scheduler.mailProxyEnabled !== false ? (scheduler.mailProxy || "") : "");
        scheduler.saveSettings();
        res.json({
            ok: true,
            regProxy: scheduler.regProxy,
            mailProxy: scheduler.mailProxy,
            mailProxyEnabled: scheduler.mailProxyEnabled !== false,
        });
    });

    app.post("/api/control/xray-bin", (req, res) => res.json(xray.setBinaryPath(req.body?.binPath)));

    app.post("/api/control/xray", (_req, res) => {
        res.status(410).json({error: "GPT 独立 vless 已下线，注册走邮箱代理池：先设跳板，再导入出口代理"});
    });

    app.post("/api/control/xray/stop", (_req, res) => res.json(xray.stopLegacy()));

    app.get("/api/control/xray/probe", async (_req, res) => res.json(await xray.probeLegacy()));

    app.post("/api/control/retry-failed", (_req, res) => {
        scheduler.retryAllFailed();
        res.json({ok: true});
    });

    app.get("/api/state", async (_req, res) => {
        try { await mailJobs.refreshState(); } catch { /* 表未就绪 */ }
        res.json({
            state: {...scheduler.state(), ...xray.state(), ...mailJobs.stateExtras()},
            stats: await stats(),
        });
    });

    app.get("/api/stats", async (_req, res) => res.json(await stats()));
}
