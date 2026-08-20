// @ts-nocheck
import {query} from "./database-context.js";

export async function insertMailSendLog(row) {
    const { rows } = await query(
        `INSERT INTO mail_send_logs(
            mailbox_id, email, to_email, subject, status, http_status, location, error,
            proxy_url, proxy_session, proxy_ip, jump_url, reused, created_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
         RETURNING id`,
        [
            Number(row.mailbox_id || 0),
            String(row.email || "").toLowerCase(),
            String(row.to_email || ""),
            String(row.subject || ""),
            String(row.status || "pending"),
            Number(row.http_status || 0),
            String(row.location || ""),
            String(row.error || ""),
            String(row.proxy_url || ""),
            String(row.proxy_session || ""),
            String(row.proxy_ip || ""),
            String(row.jump_url || ""),
            row.reused ? 1 : 0,
            Number(row.created_at || Date.now()),
        ],
    );
    return rows[0]?.id || 0;
}

export async function listMailSendLogs({email = "", limit = 50} = {}) {
    const n = Math.max(1, Math.min(200, Number(limit) || 50));
    const key = String(email || "").trim().toLowerCase();
    if (key) {
        const { rows } = await query(
            `SELECT * FROM mail_send_logs WHERE email=$1 ORDER BY id DESC LIMIT $2`,
            [key, n],
        );
        return rows;
    }
    const { rows } = await query(
        `SELECT * FROM mail_send_logs ORDER BY id DESC LIMIT $1`,
        [n],
    );
    return rows;
}
