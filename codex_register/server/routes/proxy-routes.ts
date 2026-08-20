// @ts-nocheck
// 代理池 HTTP 适配：复用邮箱域与 GPT 域相同的池管理、跳板检查和出口探测协议。

function requestProxyText(body = {}) {
    if (body.text != null) return String(body.text);
    return Array.isArray(body.urls) ? body.urls.join("\n") : "";
}

function requestJumpUrls(body = {}) {
    return requestProxyText(body).split(/[\r\n]+/).map((value) => value.trim()).filter(Boolean);
}

function registerDomainProxyRoutes(app, config, {toImportLine, probeProxy, maskProxy}) {
    const base = config.basePath;
    app.get(`${base}/proxy-pool`, async (_req, res) => {
        const urls = config.getProxyUrls();
        const proxySnapshot = await Promise.resolve(config.proxySnapshot());
        res.json({
            ok: true,
            urls,
            lines: urls.map((url) => toImportLine(url)),
            jump: config.getJump(),
            ...proxySnapshot,
        });
    });

    app.post(`${base}/proxy-pool`, async (req, res) => {
        if (req.body?.jump != null) await Promise.resolve(config.setJump(String(req.body.jump || "")));
        const snapshot = await Promise.resolve(config.setProxyPool(requestProxyText(req.body), {
            append: req.body?.append === true,
            copies: req.body?.copies,
        }));
        res.json({ok: true, urls: config.getProxyUrls(), jump: config.getJump(), ...snapshot});
    });

    app.post(`${base}/proxy-jump`, async (req, res) => {
        const jump = await Promise.resolve(config.setJump(String(req.body?.jump ?? "")));
        try {
            await config.applyPrimaryJump(jump);
        } catch (error) {
            return res.status(400).json({error: String(error?.message ?? error)});
        }
        res.json({ok: true, jump: config.getJump() || jump, jumpPool: await Promise.resolve(config.jumpSnapshot())});
    });

    app.get(`${base}/jump-pool`, async (_req, res) => {
        res.json({ok: true, ...await Promise.resolve(config.jumpSnapshot())});
    });

    app.post(`${base}/jump-pool`, async (req, res) => {
        try {
            await config.setJumpPool(requestJumpUrls(req.body));
            if (req.body?.check) await config.checkJumpPool();
            res.json({ok: true, ...await Promise.resolve(config.jumpSnapshot())});
        } catch (error) {
            res.status(400).json({error: String(error?.message ?? error)});
        }
    });

    app.post(`${base}/jump-pool/check`, async (_req, res) => {
        await config.checkJumpPool();
        res.json({ok: true, ...await Promise.resolve(config.jumpSnapshot())});
    });

    app.post(`${base}/proxy-jump/test`, async (req, res) => {
        const jump = String(req.body?.jump ?? config.getJump() ?? "").trim();
        await Promise.resolve(config.updateJumpForProbe(jump, req.body?.jump != null));
        const sample = config.getProxyUrls()[0] || "";
        if (!sample) return res.status(400).json({ok: false, error: "代理池是空的"});
        const result = await probeProxy(sample, {timeoutSec: 14, jump: config.getJump()});
        res.json({
            ok: !!result.ok,
            jump: config.getJump(),
            sample: maskProxy(sample),
            ip: result.ip,
            google: result.google,
            ms: result.ms,
            reason: result.reason || "",
        });
    });
}

export function registerProxyRoutes(app, {domains, toImportLine, probeProxy, maskProxy} = {}) {
    for (const domain of domains) {
        registerDomainProxyRoutes(app, domain, {toImportLine, probeProxy, maskProxy});
    }
}

/** 统一代理池入口；旧的 /api/mailboxes 与 /api/gpt 路由继续由上面的兼容适配器提供。 */
export function registerSharedProxyRoutes(app, config = {}) {
    const snapshot = async () => ({
        ok: true,
        urls: config.getPoolUrls(),
        lines: config.getPoolUrls().map((url) => config.toImportLine(url)),
        ...await Promise.resolve(config.poolSnapshot()),
        useForMail: !!config.poolScopes().mail,
        useForGpt: !!config.poolScopes().gpt,
        jump: {
            lines: config.getJumpLines(),
            ...await Promise.resolve(config.jumpSnapshot()),
            useForMail: !!config.jumpScopes().mail,
            useForGpt: !!config.jumpScopes().gpt,
        },
    });

    app.get("/api/proxy-pool", async (_req, res) => res.json(await snapshot()));

    app.post("/api/proxy-pool", async (req, res) => {
        try {
            const result = await Promise.resolve(config.setPool(requestProxyText(req.body), {
                append: req.body?.append === true,
                copies: req.body?.copies,
            }));
            if (typeof req.body?.useForMail === "boolean" || typeof req.body?.useForGpt === "boolean") {
                await Promise.resolve(config.setPoolScopes({mail: req.body.useForMail, gpt: req.body.useForGpt}));
            }
            res.json({...await snapshot(), inserted: result.inserted, skipped: result.skipped});
        } catch (error) {
            res.status(400).json({ok: false, error: String(error?.message || error)});
        }
    });

    app.post("/api/proxy-pool/scopes", async (req, res) => {
        try {
            await Promise.resolve(config.setPoolScopes({mail: req.body?.mail, gpt: req.body?.gpt}));
            res.json(await snapshot());
        } catch (error) {
            res.status(400).json({ok: false, error: String(error?.message || error)});
        }
    });

    app.post("/api/proxy-jump-pool", async (req, res) => {
        try {
            await config.setJumpPool(requestJumpUrls(req.body));
            if (typeof req.body?.useForMail === "boolean" || typeof req.body?.useForGpt === "boolean") {
                await Promise.resolve(config.setJumpScopes({mail: req.body.useForMail, gpt: req.body.useForGpt}));
            }
            if (req.body?.check) await config.checkJumpPool();
            res.json(await snapshot());
        } catch (error) {
            res.status(400).json({ok: false, error: String(error?.message || error)});
        }
    });

    app.post("/api/proxy-jump-pool/scopes", async (req, res) => {
        try {
            await Promise.resolve(config.setJumpScopes({mail: req.body?.mail, gpt: req.body?.gpt}));
            res.json(await snapshot());
        } catch (error) {
            res.status(400).json({ok: false, error: String(error?.message || error)});
        }
    });

    app.post("/api/proxy-jump-pool/check", async (_req, res) => {
        try {
            await config.checkJumpPool();
            res.json(await snapshot());
        } catch (error) {
            res.status(400).json({ok: false, error: String(error?.message || error)});
        }
    });
}
