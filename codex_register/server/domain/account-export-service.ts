// @ts-nocheck
// 账号导出应用服务：范围筛选、格式编码、售出标记和批次聚合。
import {extractSession, formatAccountExportLine, isExportableAccount} from "./account-credential-format.js";

export function createAccountExportService({store, credentials, defaultPassword, effects} = {}) {
    const mailboxTotpOf = (account) => String(account.mailbox_totp || "").trim();
    const gptTotpOf = (account) => String(account.totp_secret || "").trim();
    const imapOf = (account) => String(account.mailbox_imap || account.imap_password || account.imap || "").trim();

    async function selectRows({batch = null, ids, scope = "all"} = {}) {
        const idSet = Array.isArray(ids) && ids.length ? new Set(ids.map(Number)) : null;
        let rows = await store.listFull();
        if (batch != null) rows = rows.filter((account) => (account.batch || "") === String(batch));
        if (idSet) rows = rows.filter((account) => idSet.has(account.id));
        rows = rows.filter(isExportableAccount);
        if (scope === "hasRt") rows = rows.filter((account) => account.rt_file);
        else if (scope === "atOnly") rows = rows.filter((account) => !account.rt_file);
        return rows;
    }

    function refreshTokenOf(account) {
        return credentials.extractTokens(credentials.readRt(account))?.refreshToken
            || credentials.extractTokens(credentials.readAuth(account))?.refreshToken
            || "";
    }

    async function exportAccounts(options = {}) {
        const format = String(options.format || "full");
        const rows = await selectRows(options);
        if (options.markSold === true && rows.length) {
            try {
                await store.markSold(rows.map((account) => account.id));
                await effects.syncAccounts();
            } catch { /* 导出本身不因售出标记失败而中断 */ }
        }
        if (format === "at") {
            return {
                contentType: "text/plain; charset=utf-8",
                text: rows.map((account) => {
                    const tokens = credentials.extractTokens(credentials.readAuth(account));
                    return `${account.email}----${account.password}----${tokens?.accessToken || ""}`;
                }).join("\n"),
            };
        }
        if (format === "session") {
            return {
                contentType: "text/plain; charset=utf-8",
                text: rows.map((account) => {
                    const session = extractSession(credentials.readAuth(account));
                    return `${account.email}----${account.password}----${session ? JSON.stringify(session) : ""}`;
                }).join("\n"),
            };
        }
        if (format === "jsonl") {
            const records = rows.map((account) => ({
                email: account.email,
                password: account.password || "",
                mailbox_totp: mailboxTotpOf(account),
                imap_password: imapOf(account),
                gpt_password: (account.gpt_password || defaultPassword() || "").trim(),
                totp_secret: gptTotpOf(account),
                card: account.card || "",
                phone: account.phone || "",
                plan: account.plan,
                access_token: credentials.extractTokens(credentials.readAuth(account))?.accessToken || "",
                refresh_token: refreshTokenOf(account),
                provider: account.provider || "",
            }));
            return {
                contentType: "application/x-ndjson; charset=utf-8",
                text: records.map((record) => JSON.stringify(record)).join("\n"),
            };
        }
        const records = rows.map((account) => ({
            email: account.email,
            password: account.password || "",
            mailbox_totp: mailboxTotpOf(account),
            mailbox_imap: imapOf(account),
            imap_password: imapOf(account),
            gpt_password: String(account.gpt_password || "").trim(),
            totp_secret: gptTotpOf(account),
            rt: refreshTokenOf(account),
            provider: account.provider || "",
        }));
        if (format === "csv") {
            const header = "邮箱,邮箱密码,邮箱2FA,IMAP,GPT密码,GPT2FA,rt\n";
            const body = records.map((record) => [
                record.email,
                record.password,
                record.mailbox_totp,
                record.imap_password,
                record.gpt_password,
                record.totp_secret,
                record.rt,
            ].map((value) => `"${String(value ?? "").replace(/"/g, '""')}"`).join(",")).join("\n");
            return {contentType: "text/csv; charset=utf-8", text: header + body};
        }
        return {
            contentType: "text/plain; charset=utf-8",
            text: records.map((record) => formatAccountExportLine(record, {rt: record.rt, withRt: true})).join("\n"),
        };
    }

    async function getSession(id) {
        const account = Number.isInteger(id) ? await store.get(id) : null;
        if (!account) return {error: "账号不存在", status: 404};
        if (!account.auth_data && !account.auth_file) return {error: "该号无 at 授权数据", status: 400};
        const session = extractSession(credentials.readAuth(account));
        if (!session) return {error: "session 文件读取失败", status: 400};
        return {session};
    }

    async function listBatches() {
        const batches = new Map();
        for (const account of await store.list()) {
            const name = account.batch || "";
            if (!name) continue;
            const current = batches.get(name) || {count: 0, lastId: 0};
            current.count++;
            current.lastId = Math.max(current.lastId, account.id);
            batches.set(name, current);
        }
        return [...batches.entries()]
            .map(([name, value]) => ({name, count: value.count, lastId: value.lastId}))
            .sort((left, right) => right.lastId - left.lastId)
            .map(({name, count}) => ({name, count}));
    }

    return {exportAccounts, getSession, listBatches, selectRows};
}
