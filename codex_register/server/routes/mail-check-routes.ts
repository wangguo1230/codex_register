// @ts-nocheck
export function registerMailCheckRoutes(app, {mailCheck} = {}) {
    app.post("/api/tools/mail-check", async (req, res) => {
        const items = Array.isArray(req.body?.items) ? req.body.items : [];
        if (!items.length) return res.status(400).json({error: "无输入(每行 邮箱----密码)"});
        res.json(await mailCheck.check(items, {changePassword: !!req.body?.changePassword}));
    });
}
