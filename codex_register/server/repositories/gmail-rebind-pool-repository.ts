// @ts-nocheck
import {query} from "./database-context.js";
import {FREE_GOOGLE_IMAP_SQL, REBIND_GMAIL_POOL_GRP} from "./gmail-rebind-mailbox-scope.js";

export async function countFreeGoogleImapMailboxes() {
    const {rows} = await query(`SELECT COUNT(*)::int AS n FROM mailboxes m WHERE ${FREE_GOOGLE_IMAP_SQL}`);
    return rows[0]?.n || 0;
}

export async function listRebindGmailPool() {
    const {rows} = await query(`
        SELECT m.id, m.email, COALESCE(m.grp,'') AS grp,
               COALESCE(m.password,'') AS password,
               COALESCE(m.totp_secret,'') AS totp_secret,
               COALESCE(m.imap_password,'') AS imap_password,
               COALESCE(m.google_stage,'') AS google_stage
        FROM mailboxes m
        WHERE ${FREE_GOOGLE_IMAP_SQL}
        ORDER BY m.grp, m.id DESC
    `);
    const staging = [];
    const ready = [];
    for (const row of rows) {
        if ((row.grp || "") === REBIND_GMAIL_POOL_GRP) ready.push(row);
        else staging.push(row);
    }
    const groups = [];
    const map = new Map();
    for (const row of staging) {
        const grp = row.grp || "";
        if (!map.has(grp)) {
            const group = {grp, n: 0};
            map.set(grp, group);
            groups.push(group);
        }
        map.get(grp).n += 1;
    }
    return {
        poolGrp: REBIND_GMAIL_POOL_GRP,
        list: rows,
        groups,
        count: rows.length,
        staging,
        stagingCount: staging.length,
        ready,
        readyCount: ready.length,
    };
}

/** 验证通过后迁入换绑池；调用方负责先做 IMAP 探活。 */
export async function moveMailboxesToRebindPool(ids) {
    const list = [...new Set((ids || []).map(Number).filter(Number.isInteger))];
    if (!list.length) return {count: 0, skipped: []};
    const {rows: candidates} = await query(
        `SELECT m.id, m.email, COALESCE(m.password,'') AS password,
                COALESCE(m.totp_secret,'') AS totp_secret,
                COALESCE(m.imap_password,'') AS imap_password,
                COALESCE(m.grp,'') AS grp, COALESCE(m.google_stage,'') AS google_stage
         FROM mailboxes m
         WHERE m.id = ANY($1)`,
        [list],
    );
    const byId = new Map(candidates.map((row) => [row.id, row]));
    const skipped = [];
    const acceptedIds = [];
    for (const id of list) {
        const row = byId.get(id);
        if (!row) { skipped.push({id, email: "", reason: "不存在"}); continue; }
        if ((row.grp || "") === REBIND_GMAIL_POOL_GRP) { skipped.push({id, email: row.email, reason: "已在换绑池"}); continue; }
        if (!String(row.password || "").trim()) { skipped.push({id, email: row.email, reason: "无登录密码"}); continue; }
        if (!String(row.totp_secret || "").trim()) { skipped.push({id, email: row.email, reason: "无 Gmail 2FA（最低准则）"}); continue; }
        if (!String(row.imap_password || "").trim()) { skipped.push({id, email: row.email, reason: "无 IMAP 应用密码（最低准则）"}); continue; }
        acceptedIds.push(id);
    }
    if (!acceptedIds.length) return {count: 0, skipped};
    const {rowCount} = await query(
        `UPDATE mailboxes m SET grp=$1
         WHERE m.id = ANY($2)
           AND ${FREE_GOOGLE_IMAP_SQL}
           AND COALESCE(m.grp,'') <> $1`,
        [REBIND_GMAIL_POOL_GRP, acceptedIds],
    );
    if ((rowCount || 0) < acceptedIds.length) {
        const {rows: left} = await query(
            `SELECT id, email FROM mailboxes WHERE id = ANY($1) AND COALESCE(grp,'') <> $2`,
            [acceptedIds, REBIND_GMAIL_POOL_GRP],
        );
        for (const row of left) skipped.push({id: row.id, email: row.email, reason: "不满足独立未售/stage 条件"});
    }
    return {count: rowCount || 0, skipped};
}

export async function moveMailboxesFromRebindPool(ids, backGrp = "") {
    const list = [...new Set((ids || []).map(Number).filter(Number.isInteger))];
    if (!list.length) return 0;
    const {rowCount} = await query(
        `UPDATE mailboxes m SET grp=$1
         WHERE m.id = ANY($2)
           AND ${FREE_GOOGLE_IMAP_SQL}
           AND COALESCE(m.grp,'') = $3`,
        [String(backGrp || ""), list, REBIND_GMAIL_POOL_GRP],
    );
    return rowCount || 0;
}
