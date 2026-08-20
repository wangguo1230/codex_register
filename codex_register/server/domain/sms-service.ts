// @ts-nocheck
// 接码池应用服务：解析、并发预检、导入和短信读取。

export function parseSmsRows(text) {
    const rows = [];
    for (const raw of String(text || "").split(/\r?\n/)) {
        const line = raw.trim();
        if (!line) continue;
        const parts = line.split(/----|\t|,|\s{2,}/).map((value) => value.trim()).filter(Boolean);
        const link = parts.find((value) => /^https?:\/\//i.test(value)) || "";
        const rest = parts.filter((value) => value !== link);
        const phoneRaw = rest.find((value) => /^\+?[\d\s-]{6,}$/.test(value)) || "";
        const phone = phoneRaw.replace(/[^\d+]/g, "");
        const card = rest.find((value) => value !== phoneRaw && !/^\+?[\d\s-]{6,}$/.test(value)) || "";
        if (phone) rows.push({card, phone, link});
    }
    return rows;
}

export function createSmsService({store, sms, runPool, getLinkTemplate, broadcast} = {}) {
    const sync = async () => broadcast("sms", {stats: await store.stats()});

    async function importRows(text, {verify = true} = {}) {
        const rows = parseSmsRows(text);
        if (!rows.length) return {error: "未解析到有效行(每行: 手机号----链接，或从 Excel 复制两列)", status: 400};
        let invalid = [];
        let accepted = rows;
        if (verify) {
            const checked = new Array(rows.length);
            await runPool(rows.map((row, index) => ({row, index})), async ({row, index}) => {
                const link = row.link || sms.buildLink(getLinkTemplate(), row.phone);
                if (!link) {
                    checked[index] = {row, ok: true};
                    return;
                }
                try {
                    const raw = await sms.peek(link);
                    const classified = sms.classify(raw);
                    checked[index] = classified.kind === "fatal"
                        ? {row, ok: false, reason: (classified.reason || raw).slice(0, 50)}
                        : {row, ok: true};
                } catch (error) {
                    checked[index] = {
                        row,
                        ok: false,
                        reason: `验证请求失败: ${String(error?.message ?? error).slice(0, 40)}`,
                    };
                }
            }, 6);
            accepted = checked.filter((item) => item.ok).map((item) => item.row);
            invalid = checked.filter((item) => !item.ok).map((item) => ({
                phone: item.row.phone,
                reason: item.reason || "无效",
            }));
        }
        const result = accepted.length
            ? await store.import(accepted)
            : {inserted: 0, skipped: 0, total: rows.length};
        await sync();
        return {...result, invalid, verified: verify};
    }

    async function list() {
        const rows = await store.list();
        return {
            list: rows.map((item) => {
                const link = String(item.link || "");
                return {
                    id: item.id,
                    card: item.card || "",
                    phone: item.phone,
                    status: item.status,
                    bound_email: item.bound_email,
                    bind_count: item.bind_count || 0,
                    bind_emails: item.bind_emails || "",
                    link_preview: link.slice(0, 34) + (link.length > 34 ? "…" : ""),
                };
            }),
            stats: await store.stats(),
        };
    }

    async function remove(id) {
        await store.remove(id);
        await sync();
        return {ok: true};
    }

    async function peek(id) {
        const item = (await store.list()).find((row) => row.id === id);
        if (!item) return {error: "接码号不存在", status: 404};
        const link = item.link || sms.buildLink(getLinkTemplate(), item.phone);
        if (!link) return {error: "该号无收码链接：请先配置接码链接模板", status: 400};
        try {
            return {text: await sms.peek(link)};
        } catch (error) {
            return {error: String(error?.message ?? error), status: 500};
        }
    }

    return {importRows, list, remove, peek};
}
