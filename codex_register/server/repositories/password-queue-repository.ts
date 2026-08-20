// @ts-nocheck
import {query, withTransaction} from "./database-context.js";

// ========== 改密队列(多实例 FOR UPDATE SKIP LOCKED) ==========

export async function addToPwQueue(items) {
    const now = Date.now();
    await withTransaction(async (client) => {
        for (const it of items) {
            await client.query(
                `INSERT INTO pw_queue(mailbox_id, email, old_pw, created_at) VALUES($1,$2,$3,$4)`,
                [it.id, it.email, it.oldPw, now]
            );
        }
    });
    return items.length;
}

export async function claimPwTasks(instId, limit = 1) {
    return withTransaction(async (client) => {
        const { rows } = await client.query(
            `SELECT id, mailbox_id, email, old_pw FROM pw_queue WHERE status='pending' ORDER BY id LIMIT $1 FOR UPDATE SKIP LOCKED`,
            [limit]
        );
        if (!rows.length) return [];
        const ids = rows.map((r) => r.id);
        await client.query(`UPDATE pw_queue SET status='running', instance_id=$1 WHERE id = ANY($2)`, [instId, ids]);
        return rows;
    });
}

export async function completePwTask(id, ok, newPw, detail = "") {
    await query(`UPDATE pw_queue SET status=$1, new_pw=$2, detail=$3 WHERE id=$4`, [ok ? "done" : "error", newPw, detail.slice(0, 500), id]);
}

export async function pwQueueProgress() {
    const { rows } = await query(`SELECT status, COUNT(*)::int AS n FROM pw_queue GROUP BY status`);
    const out = { pending: 0, running: 0, done: 0, error: 0, total: 0 };
    for (const r of rows) { if (out[r.status] !== undefined) out[r.status] = r.n; out.total += r.n; }
    return out;
}

export async function cancelPendingPwTasks() {
    const { rowCount } = await query(`DELETE FROM pw_queue WHERE status='pending'`);
    return rowCount || 0;
}

export async function clearPwQueue() {
    await query(`DELETE FROM pw_queue`);
}

