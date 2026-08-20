// @ts-nocheck
import {
    CLAUDE_COLS_FULL,
    CLAUDE_COLS_LIST,
    instanceId,
    query,
    softDeleteMailbox,
    withTransaction,
} from "./database-context.js";

export async function getClaudeAuthData(id) {
    const {rows} = await query(`SELECT auth_data FROM claude_accounts WHERE id=$1`, [id]);
    return rows[0]?.auth_data || null;
}

// ---- Claude 域 ----

export async function listClaudeAccounts() {
    const { rows } = await query(`SELECT ${CLAUDE_COLS_LIST} FROM claude_accounts c JOIN mailboxes m ON c.mailbox_id = m.id ORDER BY c.id`);
    return rows;
}

export async function getClaudeAccount(id) {
    const { rows } = await query(`SELECT ${CLAUDE_COLS_FULL} FROM claude_accounts c JOIN mailboxes m ON c.mailbox_id = m.id WHERE c.id=$1`, [id]);
    return rows[0] || undefined;
}

export async function claimNextClaude() {
    return withTransaction(async (client) => {
        const { rows: [row] } = await client.query(
            `SELECT id FROM claude_accounts WHERE status='pending' ORDER BY id LIMIT 1 FOR UPDATE SKIP LOCKED`
        );
        if (!row) return null;
        await client.query(`UPDATE claude_accounts SET status='running', started_at=$1, error='', instance_id=$2 WHERE id=$3`, [Date.now(), instanceId, row.id]);
        const { rows: [full] } = await client.query(
            `SELECT ${CLAUDE_COLS_LIST} FROM claude_accounts c JOIN mailboxes m ON c.mailbox_id = m.id WHERE c.id=$1`, [row.id]
        );
        return full ? { ...full, status: "running", domain: "claude" } : null;
    });
}

export async function markClaudeSuccess(id, { sessionKey, orgId, authFile, plan, authData }) {
    await query(
        `UPDATE claude_accounts SET status='success', session_key=$1, org_id=$2, auth_file=$3, plan=$4, finished_at=$5, error='', auth_data=$6, instance_id='' WHERE id=$7`,
        [sessionKey || "", orgId || "", authFile || "", plan || "", Date.now(), authData ? JSON.stringify(authData) : null, id]
    );
}

export async function markClaudeFailed(id, error) {
    await query(`UPDATE claude_accounts SET status='failed', error=$1, finished_at=$2, instance_id='' WHERE id=$3 AND status='running'`,
        [String(error || "").slice(0, 2000), Date.now(), id]);
}

export async function releaseClaudeIfRunning(id) {
    const { rowCount } = await query(
        `UPDATE claude_accounts SET status='pending', error='', started_at=NULL, finished_at=NULL, instance_id='' WHERE id=$1 AND status='running'`,
        [id]
    );
    return rowCount || 0;
}

export async function setClaudeInfo(id, { plan = "", claudeCode = "", alive = true }) {
    const cur = await getClaudeAccount(id);
    await query(`UPDATE claude_accounts SET plan=$1, claude_code=$2, dead_at=$3 WHERE id=$4`,
        [plan, claudeCode, alive ? 0 : (cur?.dead_at || Date.now()), id]);
}

export async function resetClaudeToPending(id) {
    await query(`UPDATE claude_accounts SET status='pending', error='', started_at=NULL, finished_at=NULL, instance_id='' WHERE id=$1`, [id]);
}

export async function setClaudeDeadAt(id, ts) {
    await query(`UPDATE claude_accounts SET dead_at=$1 WHERE id=$2`, [ts, id]);
}

export async function markClaudeSold(ids) {
    const now = Date.now();
    await withTransaction(async (client) => {
        for (const id of (ids || [])) {
            await client.query(`UPDATE claude_accounts SET sold_at=$1 WHERE id=$2`, [now, id]);
        }
    });
    return { count: (ids || []).length };
}

export async function claudeBatches() {
    const { rows } = await query(`SELECT batch AS name, COUNT(*)::int AS n FROM claude_accounts WHERE batch!='' GROUP BY batch ORDER BY MAX(id) DESC`);
    return rows;
}

export async function deleteClaudeAccount(id) {
    return withTransaction(async (client) => {
        const { rows: [row] } = await client.query(`SELECT mailbox_id FROM claude_accounts WHERE id=$1`, [id]);
        await client.query(`DELETE FROM claude_logs WHERE claude_id=$1`, [id]);
        await client.query(`DELETE FROM claude_accounts WHERE id=$1`, [id]);
        if (row) await softDeleteMailbox(client, row.mailbox_id);
    });
}

export async function claudeStats() {
    const out = { pending: 0, running: 0, success: 0, failed: 0, total: 0 };
    const { rows } = await query(`SELECT status, COUNT(*)::int AS n FROM claude_accounts GROUP BY status`);
    for (const row of rows) { out[row.status] = row.n; out.total += row.n; }
    return out;
}

