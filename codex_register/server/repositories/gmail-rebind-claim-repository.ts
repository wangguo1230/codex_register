// @ts-nocheck
import {query, withTransaction} from "./database-context.js";
import {googleImapClaimWhere} from "./gmail-rebind-mailbox-scope.js";

export async function explainRebindGmailMiss(emails = []) {
    const list = [...new Set((emails || []).map((email) => String(email || "").trim().toLowerCase()).filter((email) => email.includes("@")))];
    if (!list.length) return "";
    const {rows} = await query(
        `SELECT m.email, m.usage, m.deleted_at, COALESCE(m.sold_at,0) AS sold_at, m.provider,
                COALESCE(m.imap_password,'') AS imap_password, COALESCE(m.google_stage,'') AS google_stage,
                EXISTS (SELECT 1 FROM gpt_accounts g WHERE g.mailbox_id=m.id AND COALESCE(g.deleted_at,0)=0) AS gpt,
                EXISTS (SELECT 1 FROM claude_accounts c WHERE c.mailbox_id=m.id) AS claude
         FROM mailboxes m WHERE lower(m.email) = ANY($1)`,
        [list],
    );
    const byEmail = new Map(rows.map((row) => [String(row.email || "").toLowerCase(), row]));
    const reasons = [];
    for (const email of list) {
        const row = byEmail.get(email);
        if (!row) { reasons.push(`${email} 库里没有`); continue; }
        if (Number(row.deleted_at) > 0) { reasons.push(`${email} 已删除`); continue; }
        if (Number(row.sold_at) > 0) { reasons.push(`${email} 已售`); continue; }
        if (row.provider !== "google") { reasons.push(`${email} 不是 Gmail`); continue; }
        if (row.usage !== "hold") { reasons.push(`${email} 不是独立(${row.usage})`); continue; }
        if (!String(row.imap_password || "").trim()) { reasons.push(`${email} 无 IMAP 密码`); continue; }
        if (row.google_stage === "gpt_ok") { reasons.push(`${email} 已挂过 GPT`); continue; }
        if (row.gpt) { reasons.push(`${email} 已被 GPT 占用`); continue; }
        if (row.claude) { reasons.push(`${email} 已被 Claude 占用`); continue; }
        reasons.push(`${email} 在池里但这次没领到`);
    }
    return reasons.slice(0, 6).join("；");
}

export async function listRebindGmailCandidates(opts = {}) {
    const {sql, params} = googleImapClaimWhere(opts);
    const {rows} = await query(
        `SELECT m.id, m.email, m.password, m.totp_secret, m.recovery_email, m.imap_password, COALESCE(m.grp,'') AS grp
         FROM mailboxes m WHERE ${sql} ORDER BY COALESCE(m.rebind_tried_at,0) ASC, m.id DESC`,
        params,
    );
    return rows;
}

export async function claimFreeGoogleImapMailbox(opts = {}) {
    return withTransaction(async (client) => {
        const {sql, params} = googleImapClaimWhere(opts);
        const {rows: [mailbox]} = await client.query(
            `SELECT m.* FROM mailboxes m WHERE ${sql} ORDER BY m.id DESC LIMIT 1 FOR UPDATE SKIP LOCKED`,
            params,
        );
        if (!mailbox) return null;
        await client.query(`UPDATE mailboxes SET usage='gpt' WHERE id=$1`, [mailbox.id]);
        return {...mailbox, usage: "gpt"};
    });
}

export async function claimMailboxForRebind(id, opts = {}) {
    const mailboxId = Number(id);
    if (!Number.isInteger(mailboxId)) return null;
    return withTransaction(async (client) => {
        const {sql, params} = googleImapClaimWhere(opts);
        params.push(mailboxId);
        const {rows: [mailbox]} = await client.query(
            `SELECT m.* FROM mailboxes m
             WHERE ${sql} AND m.id=$${params.length}
             FOR UPDATE`,
            params,
        );
        if (!mailbox) return null;
        await client.query(
            `UPDATE mailboxes SET usage='gpt', claimed_at=$2, rebind_tried_at=$2 WHERE id=$1`,
            [mailboxId, Date.now()],
        );
        return {...mailbox, usage: "gpt"};
    });
}
