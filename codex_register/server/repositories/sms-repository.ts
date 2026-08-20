// @ts-nocheck
import {instanceId, query, withTransaction} from "./database-context.js";

// ---- 接码池 ----

export async function importSms(rows) {
    const now = Date.now();
    return withTransaction(async (client) => {
        let inserted = 0;
        for (const r of rows) {
            const res = await client.query(
                `INSERT INTO sms_pool(card,phone,link,status,created_at) VALUES($1,$2,$3,'free',$4) ON CONFLICT(phone) DO NOTHING`,
                [r.card || "", r.phone, r.link, now]
            );
            inserted += res.rowCount;
        }
        return { inserted, skipped: rows.length - inserted, total: rows.length };
    });
}

export async function listSms() {
    const { rows } = await query(`SELECT * FROM sms_pool ORDER BY id`);
    return rows;
}

export async function deleteSms(id) {
    await query(`DELETE FROM sms_pool WHERE id=$1`, [id]);
}

export async function releaseSms(id) {
    await query(`UPDATE sms_pool SET status='free', bound_email='', claimed_by='' WHERE id=$1`, [id]);
}

export async function markSmsBad(id, email) {
    await query(`UPDATE sms_pool SET status='bad', bound_email=$1 WHERE id=$2`, [email || "", id]);
}

export async function markSmsUsed(id, email) {
    const e = email || "";
    await query(
        `UPDATE sms_pool SET status='used', bound_email=$1, claimed_by='', bind_count=bind_count+1, bind_emails=(CASE WHEN COALESCE(bind_emails,'')='' THEN $1 ELSE bind_emails||','||$1 END) WHERE id=$2`,
        [e, id]
    );
}

export async function claimSms(email, maxBind = 0) {
    const lim = maxBind && maxBind > 0 ? maxBind : 999999;
    return withTransaction(async (client) => {
        const { rows: [row] } = await client.query(
            `SELECT * FROM sms_pool WHERE status='free' OR (status='used' AND bind_count < $1) ORDER BY CASE WHEN status='used' THEN 1 ELSE 0 END DESC, id LIMIT 1 FOR UPDATE SKIP LOCKED`,
            [lim]
        );
        if (!row) return null;
        await client.query(`UPDATE sms_pool SET status='claimed', bound_email=$1, claimed_by=$2 WHERE id=$3`, [email || "", instanceId, row.id]);
        return row;
    });
}

export async function smsStats() {
    const out = { free: 0, used: 0, bad: 0, claimed: 0, total: 0 };
    const { rows } = await query(`SELECT status, COUNT(*)::int AS n FROM sms_pool GROUP BY status`);
    for (const row of rows) { out[row.status] = row.n; out.total += row.n; }
    return out;
}

