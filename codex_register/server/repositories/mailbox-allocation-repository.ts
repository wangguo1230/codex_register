// @ts-nocheck
import {insertOrReviveGpt, query, withTransaction} from "./database-context.js";

const FREE_MAILCOM_SQL = `
    m.usage='hold' AND m.deleted_at=0
    AND COALESCE(m.sold_at,0)=0
    AND COALESCE(m.provider,'mailcom') IN ('mailcom','')
    AND COALESCE(m.password,'') <> ''
    AND NOT EXISTS (SELECT 1 FROM gpt_accounts g WHERE g.mailbox_id=m.id AND COALESCE(g.deleted_at,0)=0)
    AND NOT EXISTS (SELECT 1 FROM claude_accounts c WHERE c.mailbox_id=m.id)
`;

export async function countFreeMailcomMailboxes() {
    const { rows } = await query(`SELECT COUNT(*)::int AS n FROM mailboxes m WHERE ${FREE_MAILCOM_SQL}`);
    return rows[0]?.n || 0;
}

export async function claimFreeMailcomMailbox() {
    return withTransaction(async (client) => {
        const { rows: [mb] } = await client.query(
            `SELECT m.* FROM mailboxes m WHERE ${FREE_MAILCOM_SQL} ORDER BY m.id DESC LIMIT 1 FOR UPDATE SKIP LOCKED`
        );
        if (!mb) return null;
        await client.query(`UPDATE mailboxes SET usage='gpt' WHERE id=$1`, [mb.id]);
        return { ...mb, usage: "gpt" };
    });
}

export async function allocateMailbox(usage) {
    return withTransaction(async (client) => {
        const { rows: [mb] } = await client.query(
            `SELECT * FROM mailboxes WHERE usage='free' AND deleted_at=0 ORDER BY id LIMIT 1 FOR UPDATE SKIP LOCKED`
        );
        if (!mb) return null;
        await client.query(`UPDATE mailboxes SET usage=$1 WHERE id=$2`, [usage, mb.id]);
        return { ...mb, usage };
    });
}

export async function allocateMailboxesTo(usage, count, batch = "", sourceGrp = undefined) {
    if (usage !== "gpt" && usage !== "claude") return { allocated: 0, error: "usage 必须是 gpt 或 claude" };
    const n = Math.max(0, Number(count) || 0);
    if (!n) return { allocated: 0 };
    const allocated = await withTransaction(async (client) => {
        const now = Date.now();
        let alloc = 0;
        for (let i = 0; i < n; i++) {
            const gptReady = usage === "gpt"
                ? ` AND (provider <> 'google' OR (COALESCE(google_stage,'')='ready' AND COALESCE(imap_password,'')<>''))`
                : "";
            const pickSql = sourceGrp == null
                ? `SELECT id, grp FROM mailboxes WHERE usage='free' AND deleted_at=0${gptReady} ORDER BY id LIMIT 1 FOR UPDATE SKIP LOCKED`
                : `SELECT id, grp FROM mailboxes WHERE usage='free' AND deleted_at=0 AND grp=$1${gptReady} ORDER BY id LIMIT 1 FOR UPDATE SKIP LOCKED`;
            const pickParams = sourceGrp == null ? [] : [sourceGrp];
            const { rows: [mb] } = await client.query(pickSql, pickParams);
            if (!mb) break;
            await client.query(`UPDATE mailboxes SET usage=$1 WHERE id=$2`, [usage, mb.id]);
            const b = String(batch || mb.grp || "");
            if (usage === "gpt") {
                await insertOrReviveGpt(client, mb.id, b, now);
            } else {
                await client.query(`INSERT INTO claude_accounts(mailbox_id,status,batch,created_at) VALUES($1,'pending',$2,$3)`, [mb.id, b, now]);
            }
            alloc++;
        }
        return alloc;
    });
    return { allocated };
}

export async function allocateMailboxIdsTo(usage, ids, batch = "") {
    if (usage !== "gpt" && usage !== "claude") return { allocated: 0, skipped: 0, error: "usage 必须是 gpt 或 claude" };
    const arr = (Array.isArray(ids) ? ids : []).map(Number).filter(Number.isInteger);
    if (!arr.length) return { allocated: 0, skipped: 0 };
    return withTransaction(async (client) => {
        const now = Date.now();
        let allocated = 0, skipped = 0, skippedImap = 0, skippedHarden = 0, skippedSold = 0, skippedBusy = 0;
        const newGrp = String(batch || "").trim();
        for (const id of arr) {
            const { rows: [mb] } = await client.query(
                `SELECT id, grp, provider, imap_password, sold_at, usage, google_stage FROM mailboxes
                 WHERE id=$1 AND deleted_at=0 AND usage IN ('free','hold') FOR UPDATE`, [id]
            );
            if (!mb) { skipped++; continue; }
            if (Number(mb.sold_at) > 0) { skippedSold++; continue; }
            if (mb.provider === "google" && usage === "gpt") {
                if (!String(mb.imap_password || "").trim()) { skippedImap++; continue; }
                if (String(mb.google_stage || "") !== "ready") { skippedHarden++; continue; }
            }
            if (usage === "gpt") {
                const { rows: [alive] } = await client.query(
                    `SELECT id FROM gpt_accounts WHERE mailbox_id=$1 AND deleted_at=0`, [mb.id]
                );
                if (alive) { skippedBusy++; continue; }
            }
            const b = newGrp || String(mb.grp || "");
            if (newGrp) {
                await client.query(`UPDATE mailboxes SET usage=$1, grp=$2 WHERE id=$3`, [usage, newGrp, mb.id]);
            } else {
                await client.query(`UPDATE mailboxes SET usage=$1 WHERE id=$2`, [usage, mb.id]);
            }
            if (usage === "gpt") {
                await insertOrReviveGpt(client, mb.id, b, now);
            } else {
                await client.query(`INSERT INTO claude_accounts(mailbox_id,status,batch,created_at) VALUES($1,'pending',$2,$3)`, [mb.id, b, now]);
            }
            allocated++;
        }
        return { allocated, skipped, skippedImap, skippedHarden, skippedSold, skippedBusy };
    });
}
