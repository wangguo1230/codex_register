// @ts-nocheck
import {query, softDeleteMailbox, withTransaction} from "./database-context.js";

export async function setMailboxUsage(id, usage) {
    if (usage !== "free" && usage !== "hold") return { ok: false, error: "只能在 free/hold 间切换" };
    const soldGuard = usage === "free" ? " AND COALESCE(sold_at,0)=0" : "";
    const res = await query(`UPDATE mailboxes SET usage=$1 WHERE id=$2 AND usage IN ('free','hold') AND deleted_at=0${soldGuard}`, [usage, id]);
    if (usage === "free" && !res.rowCount) {
        const { rows: [mb] } = await query(`SELECT sold_at FROM mailboxes WHERE id=$1`, [id]);
        if (mb && Number(mb.sold_at) > 0) return { ok: false, error: "已售邮箱不能放回待分配" };
    }
    return { ok: res.rowCount > 0 };
}

export async function setMailboxesUsage(ids, usage) {
    if (usage !== "free" && usage !== "hold") return { count: 0, error: "只能在 free/hold 间切换" };
    const list = [...new Set((ids || []).map(Number).filter(Number.isInteger))];
    if (!list.length) return {count: 0};
    const soldGuard = usage === "free" ? " AND COALESCE(sold_at,0)=0" : "";
    const {rowCount} = await query(
        `UPDATE mailboxes SET usage=$1
         WHERE id = ANY($2) AND usage IN ('free','hold') AND deleted_at=0${soldGuard}`,
        [usage, list],
    );
    return {count: rowCount || 0};
}

export async function setMailboxesGrp(ids, grp) {
    const g = String(grp ?? "");
    const arr = (Array.isArray(ids) ? ids : []).map(Number).filter(Number.isInteger);
    if (!arr.length) return {count: 0};
    const {rowCount} = await query(
        `UPDATE mailboxes SET grp=$1 WHERE id = ANY($2) AND deleted_at=0 AND usage IN ('free','hold')`,
        [g, arr],
    );
    return {count: rowCount || 0};
}

export async function importFreeMailboxes(rows, grp = "", usage = "free", provider = "mailcom") {
    const now = Date.now();
    const g = String(grp || "");
    const u = usage === "hold" ? "hold" : "free";
    const prov = provider || "mailcom";
    return withTransaction(async (client) => {
        const ids = [];
        for (const r of rows) {
            const email = r.email.toLowerCase();
            const {straightenImportRow} = await import("../../src/mfa.js");
            const row = straightenImportRow(r);
            const totp = row.totp_secret || "";
            const { rows: ins } = await client.query(
                `INSERT INTO mailboxes(email,password,provider,usage,grp,created_at,recovery_email,totp_secret,totp_secret_orig)
                 VALUES($1,$2,$3,$4,$5,$6,$7,$8,$8) ON CONFLICT(email) DO NOTHING RETURNING id`,
                [email, r.password, prov, u, g, now, row.recovery_email || "", totp]
            );
            if (ins[0]?.id) {
                ids.push(ins[0].id);
            } else {
                const { rows: upd } = await client.query(
                    `UPDATE mailboxes SET deleted_at=0, usage=$1, password=$2, provider=$3, grp=$4, recovery_email=$5,
                        totp_secret=CASE
                          WHEN COALESCE(google_state->>'totp_rotated','')='true' THEN totp_secret
                          WHEN COALESCE(totp_secret,'')<>'' THEN totp_secret
                          ELSE $6 END,
                        totp_secret_orig=CASE WHEN COALESCE(totp_secret_orig,'')<>'' THEN totp_secret_orig WHEN COALESCE(totp_secret,'')<>'' THEN totp_secret ELSE $6 END
                     WHERE email=$7 AND deleted_at>0 RETURNING id`,
                    [u, r.password, prov, g, row.recovery_email || "", totp, email]
                );
                if (upd[0]?.id) ids.push(upd[0].id);
            }
        }
        return { inserted: ids.length, skipped: rows.length - ids.length, total: rows.length, ids };
    });
}

export async function deleteMailbox(id) {
    return withTransaction(async (client) => {
        await softDeleteMailbox(client, id);
        return { ok: true };
    });
}

export async function batchDeleteMailbox(ids) {
    const list = [...new Set((ids || []).map(Number).filter(Number.isInteger))];
    if (!list.length) return {count: 0, skipped: 0};
    const {rowCount} = await query(
        `UPDATE mailboxes SET deleted_at=$1, usage='deleted' WHERE id = ANY($2) AND deleted_at=0`,
        [Date.now(), list],
    );
    return {count: rowCount || 0, skipped: 0};
}
