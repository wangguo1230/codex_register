// @ts-nocheck
import {
    ACC_ALIVE,
    ACC_COLS_FULL,
    ACC_COLS_LIST,
    ACC_DELETED,
    ACC_FROM,
    GPT_FIELDS,
    MAILBOX_FIELDS,
    insertOrReviveGpt,
    instanceId,
    query,
    softDeleteGpt,
    withTransaction,
} from "./database-context.js";

// ---- GPT 账号（导入 / 读取 / 认领 / 标记） ----

export async function importAccounts(rows, batch = "", provider = "mailcom") {
    const now = Date.now();
    const grp = String(batch || "");
    const prov = provider || "mailcom";
    return withTransaction(async (client) => {
        let inserted = 0;
        for (const r of rows) {
            const email = r.email.toLowerCase();
            const {straightenImportRow} = await import("../../src/mfa.js");
            const row = straightenImportRow(r);
            const totp = row.totp_secret || "";
            const { rows: ins } = await client.query(
                `INSERT INTO mailboxes(email,password,provider,usage,grp,created_at,recovery_email,totp_secret,totp_secret_orig)
                 VALUES($1,$2,$3,'gpt',$4,$5,$6,$7,$7) ON CONFLICT(email) DO NOTHING RETURNING id`,
                [email, r.password, prov, grp, now, row.recovery_email || "", totp]
            );
            if (!ins.length) continue;
            await insertOrReviveGpt(client, ins[0].id, grp, now);
            inserted++;
        }
        return { inserted, skipped: rows.length - inserted, total: rows.length };
    });
}

export async function listAccounts(status?, full = false, deleted = false) {
    const cols = full ? ACC_COLS_FULL : ACC_COLS_LIST;
    const delCond = deleted ? ACC_DELETED : ACC_ALIVE;
    if (status) {
        const { rows } = await query(`SELECT ${cols} ${ACC_FROM} WHERE g.status=$1 AND ${delCond} ORDER BY g.id`, [status]);
        return rows;
    }
    const { rows } = await query(`SELECT ${cols} ${ACC_FROM} WHERE ${delCond} ORDER BY g.id`);
    return rows;
}

export async function getAccount(id) {
    const { rows } = await query(`SELECT ${ACC_COLS_FULL} ${ACC_FROM} WHERE g.id=$1`, [id]);
    return rows[0] || undefined;
}

export async function getAccounts(ids) {
    const list = [...new Set((ids || []).map(Number).filter(Number.isInteger))];
    if (!list.length) return [];
    const {rows} = await query(
        `SELECT ${ACC_COLS_FULL} ${ACC_FROM} WHERE g.id = ANY($1::int[]) AND ${ACC_ALIVE} ORDER BY g.id`,
        [list],
    );
    return rows;
}

export async function getAccountByEmail(email) {
    const { rows } = await query(`SELECT ${ACC_COLS_FULL} ${ACC_FROM} WHERE LOWER(m.email)=LOWER($1) AND ${ACC_ALIVE} ORDER BY g.id DESC LIMIT 1`, [String(email || "").trim()]);
    return rows[0] || undefined;
}

export async function claimNext() {
    return withTransaction(async (client) => {
        const { rows: [row] } = await client.query(
            // 只认领活跃号:GPT 记录软删、或邮箱已删的都不再跑(口径与列表/统计一致)
            `SELECT g.id ${ACC_FROM} WHERE g.status='pending' AND ${ACC_ALIVE} ORDER BY g.id LIMIT 1 FOR UPDATE OF g SKIP LOCKED`
        );
        if (!row) return null;
        await client.query(`UPDATE gpt_accounts SET status='running', started_at=$1, error='', instance_id=$2 WHERE id=$3`, [Date.now(), instanceId, row.id]);
        const { rows: [full] } = await client.query(`SELECT ${ACC_COLS_LIST} ${ACC_FROM} WHERE g.id=$1`, [row.id]);
        return full ? { ...full, status: "running" } : null;
    });
}

export async function markSuccess(id, { token, authFile, plan, authData }) {
    await query(`UPDATE gpt_accounts SET status='success', token=$1, auth_file=$2, plan=$3, finished_at=$4, error='', auth_data=$5, instance_id='' WHERE id=$6`,
        [token || "", authFile || "", plan || "", Date.now(), authData ? JSON.stringify(authData) : null, id]);
}

export async function markFailed(id, error) {
    // 仅当仍是 running 才标失败:本实例停止后已退回 pending 的号不被覆盖,供其他实例认领
    await query(`UPDATE gpt_accounts SET status='failed', error=$1, finished_at=$2, instance_id='' WHERE id=$3 AND status='running'`,
        [String(error || "").slice(0, 2000), Date.now(), id]);
}

export async function releaseGptIfRunning(id) {
    const { rowCount } = await query(
        `UPDATE gpt_accounts SET status='pending', error='', started_at=NULL, finished_at=NULL, instance_id='' WHERE id=$1 AND status='running'`,
        [id]
    );
    return rowCount || 0;
}

export async function resetToPending(id) {
    await query(`DELETE FROM logs WHERE account_id=$1`, [id]);
    await query(`UPDATE gpt_accounts SET status='pending', error='', started_at=NULL, finished_at=NULL, instance_id='' WHERE id=$1`, [id]);
}

export async function resetAllFailed() {
    await query(`UPDATE gpt_accounts SET status='pending', error='', started_at=NULL, finished_at=NULL WHERE status='failed' AND deleted_at=0 AND error NOT LIKE '%account_deactivated%'`);
}

export async function deleteAccount(id) {
    return withTransaction(async (client) => { await softDeleteGpt(client, id); });
}

export async function updatePassword(id, password) {
    await query(`UPDATE mailboxes SET password=$1 WHERE id=(SELECT mailbox_id FROM gpt_accounts WHERE id=$2)`, [password, id]);
}

export async function updateAccount(id, fields) {
    const f = fields || {};
    const mKeys = Object.keys(f).filter((k) => MAILBOX_FIELDS.includes(k));
    const gKeys = Object.keys(f).filter((k) => GPT_FIELDS.includes(k));
    if (!mKeys.length && !gKeys.length) return { changes: 0 };
    let changes = 0;
    await withTransaction(async (client) => {
        if (gKeys.length) {
            const set = gKeys.map((k, i) => `${k}=$${i + 1}`).join(", ");
            const vals = [...gKeys.map((k) => (k === "auth_data" || k === "rt_data") && f[k] && typeof f[k] === "object" ? JSON.stringify(f[k]) : f[k]), id];
            const res = await client.query(`UPDATE gpt_accounts SET ${set} WHERE id=$${gKeys.length + 1}`, vals);
            changes += res.rowCount;
        }
        if (mKeys.length) {
            const set = mKeys.map((k, i) => `${k}=$${i + 1}`).join(", ");
            const vals = [...mKeys.map((k) => f[k]), id];
            const res = await client.query(`UPDATE mailboxes SET ${set} WHERE id=(SELECT mailbox_id FROM gpt_accounts WHERE id=$${mKeys.length + 1})`, vals);
            changes += res.rowCount;
        }
    });
    return { changes };
}

// ---- GPT 统计 / 字段更新 ----

export async function stats() {
    const out = { pending: 0, running: 0, success: 0, failed: 0, total: 0 };
    const { rows } = await query(
        `SELECT g.status, COUNT(*)::int AS n FROM gpt_accounts g JOIN mailboxes m ON g.mailbox_id=m.id WHERE ${ACC_ALIVE} GROUP BY g.status`
    );
    for (const row of rows) { out[row.status] = row.n; out.total += row.n; }
    return out;
}

export async function setAccountPhone(id, phone) {
    await query(`UPDATE gpt_accounts SET phone=$1 WHERE id=$2`, [phone || "", id]);
}

export async function setAccountCard(id, card) {
    await query(`UPDATE gpt_accounts SET card=$1 WHERE id=$2`, [card || "", id]);
}

export async function setAccountRtFile(id, rtFile, rtData) {
    await query(`UPDATE gpt_accounts SET rt_file=$1, rt_data=$2 WHERE id=$3`, [rtFile || "", rtData ? JSON.stringify(rtData) : null, id]);
}

export async function updateAuthData(id, data) {
    await query(`UPDATE gpt_accounts SET auth_data=$1 WHERE id=$2`, [data ? JSON.stringify(data) : null, id]);
}
export async function updateRtData(id, data) {
    await query(`UPDATE gpt_accounts SET rt_data=$1 WHERE id=$2`, [data ? JSON.stringify(data) : null, id]);
}

export async function getAccountAuthData(id) {
    const { rows } = await query(`SELECT auth_data, rt_data FROM gpt_accounts WHERE id=$1`, [id]);
    return rows[0] || null;
}
export async function setDeadAt(id, ts) {
    await query(`UPDATE gpt_accounts SET dead_at=$1 WHERE id=$2`, [ts || 0, id]);
}

export async function markSold(ids, sold = true) {
    const ts = sold ? Date.now() : 0;
    const arr = ids || [];
    if (!arr.length) return 0;
    await withTransaction(async (client) => {
        for (const id of arr) await client.query(`UPDATE gpt_accounts SET sold_at=$1 WHERE id=$2`, [ts, id]);
    });
    return arr.length;
}

export async function setTestStatus(id, kind, status) {
    const s = String(status || "");
    if (kind === "at") await query(`UPDATE gpt_accounts SET at_status=$1 WHERE id=$2`, [s, id]);
    else if (kind === "rt") await query(`UPDATE gpt_accounts SET rt_status=$1 WHERE id=$2`, [s, id]);
    else if (kind === "chat") await query(`UPDATE gpt_accounts SET chat_status=$1 WHERE id=$2`, [s, id]);
}

export async function setPwStatus(id, status) {
    await query(`UPDATE mailboxes SET pw_status=$1 WHERE id=(SELECT mailbox_id FROM gpt_accounts WHERE id=$2)`, [String(status || ""), id]);
}
