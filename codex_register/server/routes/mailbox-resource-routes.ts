// @ts-nocheck
// 邮箱资源 HTTP 适配：导入、分配、归档属性、查询与收件箱读取。

export function registerMailboxResourceRoutes(app, {
    store,
    jobs,
    scheduler,
    parseAccounts,
    extractEmails,
    fetchInbox,
    fetchBody,
    logMailbox,
    broadcast,
} = {}) {
    const syncMailboxStats = async () => {
        broadcast("mailboxes", {stats: await store.stats()});
    };

    app.post("/api/mailboxes/import", async (req, res) => {
        const rows = parseAccounts(req.body.text, req.body.defaultPassword);
        if (!rows.length) {
            return res.status(400).json({error: "未解析到有效的 邮箱+密码 行(支持 email----pwd / email:pwd / email pwd)"});
        }
        const usage = req.body.hold ? "hold" : "free";
        const provider = String(req.body.provider || "mailcom");
        const group = String(req.body.grp || "").trim();
        const result = await store.import(rows, group, usage, provider);
        const extra = {emails: rows.map((row) => row.email.toLowerCase())};
        if (provider === "google" && result.ids?.length) {
            for (const id of result.ids) {
                await store.refreshGoogleState(id, {stage: "imported"}).catch(() => {});
                logMailbox(id, `[导入] ${usage} grp=${group || "—"}`);
            }
        }
        await syncMailboxStats();

        if (req.body.autoChangePw && provider !== "google") {
            const importedEmails = new Set(rows.map((row) => row.email.toLowerCase()));
            const items = (await store.list())
                .filter((mailbox) => importedEmails.has(mailbox.email) && (mailbox.usage === "free" || mailbox.usage === "hold"))
                .map((mailbox) => ({id: mailbox.id, email: mailbox.email, payload: {oldPw: mailbox.password}}));
            if (items.length) {
                await jobs.begin();
                const enqueued = await store.enqueueJobs(items, "pw");
                jobs.afterEnqueue();
                return res.json({...result, ...extra, autoChangePw: enqueued.inserted});
            }
        }
        if (req.body.autoHarden && provider === "google") {
            const found = (await store.lookup(rows.map((row) => row.email)))
                .filter((mailbox) => mailbox.provider === "google" && !(mailbox.deleted_at > 0));
            if (found.length) {
                const started = await jobs.startHarden(found.map((mailbox) => mailbox.id));
                if (started.error) {
                    return res.json({...result, ...extra, autoHarden: 0, hardenError: started.error});
                }
                return res.json({
                    ...result,
                    ...extra,
                    autoHarden: started.count,
                    hardenConcurrency: started.concurrency,
                });
            }
        }
        res.json({...result, ...extra});
    });

    app.post("/api/mailboxes/allocate", async (req, res) => {
        const usage = String(req.body.usage || "");
        if (usage !== "gpt" && usage !== "claude") {
            return res.status(400).json({error: "usage 必须是 gpt 或 claude"});
        }
        const batch = String(req.body.batch || "").trim();
        const ids = Array.isArray(req.body.ids) ? req.body.ids.map(Number).filter(Number.isInteger) : null;
        const afterAllocate = async () => {
            if (usage === "gpt") {
                broadcast("snapshot", await store.listAccounts());
                broadcast("stats", await store.accountStats());
            } else {
                broadcast("claude", {stats: await store.claudeStats()});
            }
            await syncMailboxStats();
            scheduler.tick();
        };

        if (ids) {
            if (!ids.length) return res.status(400).json({error: "未选择邮箱"});
            if (req.body.changePwFirst === true) {
                const mailboxes = (await Promise.all(ids.map((id) => store.get(id))))
                    .filter((mailbox) => mailbox && (mailbox.usage === "free" || mailbox.usage === "hold"));
                if (!mailboxes.length) {
                    return res.status(400).json({error: "选中的邮箱都不是待分配/独立状态,无法先改密"});
                }
                await jobs.begin();
                const enqueued = await store.enqueueJobs(mailboxes.map((mailbox) => ({
                    id: mailbox.id,
                    email: mailbox.email,
                    payload: {oldPw: mailbox.password, afterAllocate: {usage, batch}},
                })), "pw");
                jobs.afterEnqueue();
                return res.json({ok: true, changePwFirst: true, willChange: enqueued.inserted, queued: true});
            }
            const result = await store.allocateIds(usage, ids, batch);
            await afterAllocate();
            return res.json(result);
        }

        const count = Number(req.body.count || 0);
        if (!(count > 0)) return res.status(400).json({error: "count 必须 > 0"});
        const fromGroup = typeof req.body.fromGrp === "string" ? req.body.fromGrp : undefined;
        const result = await store.allocate(usage, count, batch, fromGroup);
        await afterAllocate();
        res.json(result);
    });

    app.delete("/api/mailboxes/:id", async (req, res) => {
        const id = Number(req.params.id);
        if (!Number.isInteger(id)) return res.status(400).json({error: "bad id"});
        const result = await store.remove(id);
        if (!result.ok) return res.status(409).json(result);
        await syncMailboxStats();
        res.json(result);
    });

    app.post("/api/mailboxes/batch-delete", async (req, res) => {
        const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(Number) : [];
        if (!ids.length) return res.status(400).json({error: "未选择邮箱"});
        const result = await store.removeBatch(ids);
        await syncMailboxStats();
        res.json({ok: true, ...result});
    });

    app.post("/api/mailboxes/:id/usage", async (req, res) => {
        const usage = String(req.body?.usage || "");
        const result = await store.setUsage(Number(req.params.id), usage);
        if (!result.ok) {
            return res.status(400).json(result.error ? result : {error: "切换失败(邮箱不存在或已归属业务,不能改)"});
        }
        await syncMailboxStats();
        res.json({ok: true, usage});
    });

    app.post("/api/mailboxes/usage", async (req, res) => {
        const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(Number) : [];
        const usage = String(req.body?.usage || "");
        const result = await store.setBatchUsage(ids, usage);
        if (result.error) return res.status(400).json(result);
        await syncMailboxStats();
        res.json({ok: true, count: result.count, usage});
    });

    app.post("/api/mailboxes/grp", async (req, res) => {
        const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(Number) : [];
        const group = String(req.body?.grp ?? "");
        if (!ids.length) return res.status(400).json({error: "未选择邮箱"});
        const result = await store.setGroups(ids, group);
        await syncMailboxStats();
        res.json({ok: true, count: result.count, grp: group});
    });

    app.get("/api/mailboxes/:id/inbox", async (req, res) => {
        const id = Number(req.params.id);
        const mailbox = await store.get(id);
        if (!mailbox) return res.status(404).json({error: "邮箱不存在"});
        const isGoogle = mailbox.provider === "google" || /@(gmail|googlemail)\.com$/i.test(mailbox.email || "");
        logMailbox(id, isGoogle ? "[收信] 经 IMAP 拉取 Gmail 收件箱…" : "[收信] 登录 mail.com 拉取收件箱…");
        try {
            const mails = await fetchInbox(mailbox, 40);
            logMailbox(id, `[收信] 成功,收件箱 ${mails.length} 封${isGoogle ? " (IMAP)" : ""}`);
            res.json({email: mailbox.email, mails, via: isGoogle ? "imap" : "mailcom"});
        } catch (error) {
            logMailbox(id, `[收信] 失败: ${error?.message ?? error}`);
            res.status(500).json({error: String(error?.message ?? error)});
        }
    });

    app.get("/api/mailboxes/:id/mail/:mailId/body", async (req, res) => {
        const mailbox = await store.get(Number(req.params.id));
        if (!mailbox) return res.status(404).json({error: "邮箱不存在"});
        try {
            res.json({body: await fetchBody(mailbox, req.params.mailId)});
        } catch (error) {
            res.status(500).json({error: String(error?.message ?? error)});
        }
    });

    app.get("/api/mailboxes/:id/logs", async (req, res) => {
        res.json(await store.listLogs(Number(req.params.id)));
    });

    app.get("/api/mailboxes", async (req, res) => {
        const usage = req.query.usage ? String(req.query.usage) : undefined;
        res.json({list: await store.list(usage), stats: await store.stats(), groups: await store.freeGroups()});
    });

    app.post("/api/mailboxes/lookup", async (req, res) => {
        const raw = req.body?.emails ?? req.body?.text ?? "";
        const emails = [...new Set(
            (Array.isArray(raw) ? raw.flatMap((value) => extractEmails(String(value))) : extractEmails(String(raw)))
                .map((email) => String(email || "").trim().toLowerCase())
                .filter(Boolean),
        )];
        const list = await store.lookup(emails);
        const foundSet = new Set(list.map((mailbox) => String(mailbox.email || "").toLowerCase()));
        res.json({
            list,
            queried: emails,
            found: emails.filter((email) => foundSet.has(email)),
            missing: emails.filter((email) => !foundSet.has(email)),
        });
    });
}
