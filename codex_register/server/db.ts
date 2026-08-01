// @ts-nocheck
// PostgreSQL 持久化(从 SQLite 迁移)
// 所有函数均为 async，调用方需 await。
import { pool, query, withTransaction } from "./pg.js";
import os from "node:os";

// 多实例标识：区分不同服务实例，init() 只重置本实例的孤儿任务
export const instanceId = process.env.INSTANCE_ID || os.hostname();

// 兼容 JOIN：gpt_accounts + mailboxes 拼回原 accounts 形状
const ACC_COLS_LIST = `
  g.id AS id, m.email AS email, m.password AS password, g.status AS status,
  g.plan AS plan, g.token AS token, g.auth_file AS auth_file, g.error AS error,
  g.started_at AS started_at, g.finished_at AS finished_at, g.created_at AS created_at,
  g.phone AS phone, g.card AS card, g.at_status AS at_status, g.rt_status AS rt_status,
  g.chat_status AS chat_status, g.rt_file AS rt_file, g.dead_at AS dead_at, g.sold_at AS sold_at,
  m.pw_status AS pw_status, m.provider AS provider, g.batch AS batch, g.mailbox_id AS mailbox_id`;
const ACC_COLS_FULL = `${ACC_COLS_LIST}, g.auth_data, g.rt_data`;
const ACC_FROM = `FROM gpt_accounts g JOIN mailboxes m ON g.mailbox_id = m.id`;

const CLAUDE_COLS_LIST = `c.id, c.mailbox_id, c.status, c.session_key, c.org_id, c.auth_file, c.plan, c.claude_code, c.engine,
           c.batch, c.error, c.dead_at, c.sold_at, c.started_at, c.finished_at, c.created_at,
           m.email, m.password, m.provider, m.pw_status, m.grp`;
const CLAUDE_COLS_FULL = `${CLAUDE_COLS_LIST}, c.auth_data`;

const MAILBOX_FIELDS = ["email", "password", "pw_status"];
const GPT_FIELDS = ["status", "plan", "phone", "card", "at_status", "rt_status", "chat_status", "error", "dead_at", "sold_at", "finished_at", "batch", "auth_file", "token", "rt_file", "engine", "auth_data", "rt_data"];

// 启动初始化：重置中断状态（原 SQLite 版在模块加载时同步执行）
export async function init() {
    // 只重置本实例的孤儿任务 + 旧版无标记的遗留数据（instance_id=''）
    await query(`UPDATE gpt_accounts SET status='pending', instance_id='' WHERE status='running' AND (instance_id=$1 OR instance_id='')`, [instanceId]);
    await query(`UPDATE claude_accounts SET status='pending', instance_id='' WHERE status='running' AND (instance_id=$1 OR instance_id='')`, [instanceId]);
    await query(`UPDATE sms_pool SET status='free', bound_email='', claimed_by='' WHERE status='claimed' AND (claimed_by=$1 OR claimed_by='')`, [instanceId]);
    console.log(`[db] 启动初始化完成 (instance=${instanceId})：本实例 running→pending, claimed→free`);
}

// 全局清理：重置所有实例的 running/claimed（某台机器断电后手动调用）
export async function cleanupAllStale() {
    const r1 = await query(`UPDATE gpt_accounts SET status='pending', instance_id='' WHERE status='running' RETURNING id`);
    const r2 = await query(`UPDATE claude_accounts SET status='pending', instance_id='' WHERE status='running' RETURNING id`);
    const r3 = await query(`UPDATE sms_pool SET status='free', bound_email='', claimed_by='' WHERE status='claimed' RETURNING id`);
    return {gpt: r1.rowCount, claude: r2.rowCount, sms: r3.rowCount};
}

// ---- GPT 账号（导入 / 读取 / 认领 / 标记） ----

export async function importAccounts(rows, batch = "", provider = "mailcom") {
    const now = Date.now();
    const grp = String(batch || "");
    const prov = provider || "mailcom";
    return withTransaction(async (client) => {
        let inserted = 0;
        for (const r of rows) {
            const email = r.email.toLowerCase();
            const { rows: ins } = await client.query(
                `INSERT INTO mailboxes(email,password,provider,usage,grp,created_at) VALUES($1,$2,$3,'gpt',$4,$5) ON CONFLICT(email) DO NOTHING RETURNING id`,
                [email, r.password, prov, grp, now]
            );
            if (!ins.length) continue;
            await client.query(
                `INSERT INTO gpt_accounts(mailbox_id,status,batch,created_at) VALUES($1,'pending',$2,$3)`,
                [ins[0].id, grp, now]
            );
            inserted++;
        }
        return { inserted, skipped: rows.length - inserted, total: rows.length };
    });
}

export async function listAccounts(status?) {
    if (status) {
        const { rows } = await query(`SELECT ${ACC_COLS_LIST} ${ACC_FROM} WHERE g.status=$1 ORDER BY g.id`, [status]);
        return rows;
    }
    const { rows } = await query(`SELECT ${ACC_COLS_LIST} ${ACC_FROM} ORDER BY g.id`);
    return rows;
}

export async function getAccount(id) {
    const { rows } = await query(`SELECT ${ACC_COLS_FULL} ${ACC_FROM} WHERE g.id=$1`, [id]);
    return rows[0] || undefined;
}

export async function claimNext() {
    return withTransaction(async (client) => {
        const { rows: [row] } = await client.query(
            `SELECT id FROM gpt_accounts WHERE status='pending' ORDER BY id LIMIT 1 FOR UPDATE SKIP LOCKED`
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
    await query(`UPDATE gpt_accounts SET status='failed', error=$1, finished_at=$2, instance_id='' WHERE id=$3`,
        [String(error || "").slice(0, 2000), Date.now(), id]);
}

export async function resetToPending(id) {
    await query(`DELETE FROM logs WHERE account_id=$1`, [id]);
    await query(`UPDATE gpt_accounts SET status='pending', error='', started_at=NULL, finished_at=NULL, instance_id='' WHERE id=$1`, [id]);
}

export async function resetAllFailed() {
    await query(`UPDATE gpt_accounts SET status='pending', error='', started_at=NULL, finished_at=NULL WHERE status='failed' AND error NOT LIKE '%account_deactivated%'`);
}

export async function deleteAccount(id, { keepMailbox = false } = {}) {
    return withTransaction(async (client) => {
        const { rows: [row] } = await client.query(`SELECT mailbox_id FROM gpt_accounts WHERE id=$1`, [id]);
        await client.query(`DELETE FROM logs WHERE account_id=$1`, [id]);
        await client.query(`DELETE FROM gpt_accounts WHERE id=$1`, [id]);
        if (row) {
            if (keepMailbox) {
                await client.query(`UPDATE mailboxes SET usage='free' WHERE id=$1`, [row.mailbox_id]);
            } else {
                await client.query(`DELETE FROM mailboxes WHERE id=$1`, [row.mailbox_id]);
                await client.query(`DELETE FROM mailbox_logs WHERE mailbox_id=$1`, [row.mailbox_id]);
            }
        }
    });
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

// ---- 日志 ----

export async function appendLog(id, line) {
    await query(`INSERT INTO logs(account_id,ts,line) VALUES($1,$2,$3)`, [id, Date.now(), line]);
}

export async function listLogs(id) {
    const { rows } = await query(`SELECT id,ts,line FROM logs WHERE account_id=$1 ORDER BY id`, [id]);
    return rows;
}

export async function appendMailboxLog(mailboxId, line) {
    await query(`INSERT INTO mailbox_logs(mailbox_id,ts,line) VALUES($1,$2,$3)`, [mailboxId, Date.now(), line]);
}

export async function listMailboxLogs(mailboxId) {
    const { rows } = await query(`SELECT id,ts,line FROM mailbox_logs WHERE mailbox_id=$1 ORDER BY id`, [mailboxId]);
    return rows;
}

export async function appendClaudeLog(claudeId, line) {
    await query(`INSERT INTO claude_logs(claude_id,ts,line) VALUES($1,$2,$3)`, [claudeId, Date.now(), line]);
}

export async function listClaudeLogs(claudeId) {
    const { rows } = await query(`SELECT id,ts,line FROM claude_logs WHERE claude_id=$1 ORDER BY id`, [claudeId]);
    return rows;
}

// ---- GPT 统计 / 字段更新 ----

export async function stats() {
    const out = { pending: 0, running: 0, success: 0, failed: 0, total: 0 };
    const { rows } = await query(`SELECT status, COUNT(*)::int AS n FROM gpt_accounts GROUP BY status`);
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
export async function getClaudeAuthData(id) {
    const { rows } = await query(`SELECT auth_data FROM claude_accounts WHERE id=$1`, [id]);
    return rows[0]?.auth_data || null;
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

// ---- 邮箱资源池 ----

export async function listMailboxes(usage?) {
    if (usage) {
        const { rows } = await query(`SELECT * FROM mailboxes WHERE usage=$1 ORDER BY id`, [usage]);
        return rows;
    }
    const { rows } = await query(`SELECT * FROM mailboxes ORDER BY id`);
    return rows;
}

export async function mailboxStats() {
    const out = { free: 0, hold: 0, gpt: 0, claude: 0, total: 0 };
    const { rows } = await query(`SELECT usage, COUNT(*)::int AS n FROM mailboxes GROUP BY usage`);
    for (const row of rows) {
        if (out[row.usage] !== undefined) out[row.usage] = row.n;
        out.total += row.n;
    }
    return out;
}

export async function setMailboxUsage(id, usage) {
    if (usage !== "free" && usage !== "hold") return { ok: false, error: "只能在 free/hold 间切换" };
    const res = await query(`UPDATE mailboxes SET usage=$1 WHERE id=$2 AND usage IN ('free','hold')`, [usage, id]);
    return { ok: res.rowCount > 0 };
}

export async function setMailboxesUsage(ids, usage) {
    if (usage !== "free" && usage !== "hold") return { count: 0, error: "只能在 free/hold 间切换" };
    let n = 0;
    await withTransaction(async (client) => {
        for (const id of (ids || [])) {
            const res = await client.query(`UPDATE mailboxes SET usage=$1 WHERE id=$2 AND usage IN ('free','hold')`, [usage, id]);
            n += res.rowCount;
        }
    });
    return { count: n };
}

export async function getMailbox(id) {
    const { rows } = await query(`SELECT * FROM mailboxes WHERE id=$1`, [id]);
    return rows[0] || undefined;
}

export async function getMailboxByEmail(email) {
    const { rows } = await query(`SELECT * FROM mailboxes WHERE email=$1`, [String(email).toLowerCase()]);
    return rows[0] || undefined;
}

export async function importFreeMailboxes(rows, grp = "", usage = "free", provider = "mailcom") {
    const now = Date.now();
    const g = String(grp || "");
    const u = usage === "hold" ? "hold" : "free";
    const prov = provider || "mailcom";
    return withTransaction(async (client) => {
        let inserted = 0;
        for (const r of rows) {
            const res = await client.query(
                `INSERT INTO mailboxes(email,password,provider,usage,grp,created_at) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(email) DO NOTHING`,
                [r.email.toLowerCase(), r.password, prov, u, g, now]
            );
            inserted += res.rowCount;
        }
        return { inserted, skipped: rows.length - inserted, total: rows.length };
    });
}

export async function allocateMailbox(usage) {
    return withTransaction(async (client) => {
        const { rows: [mb] } = await client.query(
            `SELECT * FROM mailboxes WHERE usage='free' ORDER BY id LIMIT 1 FOR UPDATE SKIP LOCKED`
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
            const pickSql = sourceGrp == null
                ? `SELECT id, grp FROM mailboxes WHERE usage='free' ORDER BY id LIMIT 1 FOR UPDATE SKIP LOCKED`
                : `SELECT id, grp FROM mailboxes WHERE usage='free' AND grp=$1 ORDER BY id LIMIT 1 FOR UPDATE SKIP LOCKED`;
            const pickParams = sourceGrp == null ? [] : [sourceGrp];
            const { rows: [mb] } = await client.query(pickSql, pickParams);
            if (!mb) break;
            await client.query(`UPDATE mailboxes SET usage=$1 WHERE id=$2`, [usage, mb.id]);
            const b = String(batch || mb.grp || "");
            if (usage === "gpt") {
                await client.query(`INSERT INTO gpt_accounts(mailbox_id,status,batch,created_at) VALUES($1,'pending',$2,$3)`, [mb.id, b, now]);
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
        let allocated = 0, skipped = 0;
        for (const id of arr) {
            const { rows: [mb] } = await client.query(
                `SELECT id, grp FROM mailboxes WHERE id=$1 AND usage='free' FOR UPDATE SKIP LOCKED`, [id]
            );
            if (!mb) { skipped++; continue; }
            const res = await client.query(`UPDATE mailboxes SET usage=$1 WHERE id=$2 AND usage='free'`, [usage, mb.id]);
            if (!res.rowCount) { skipped++; continue; }
            const b = String(batch || mb.grp || "");
            if (usage === "gpt") {
                await client.query(`INSERT INTO gpt_accounts(mailbox_id,status,batch,created_at) VALUES($1,'pending',$2,$3)`, [mb.id, b, now]);
            } else {
                await client.query(`INSERT INTO claude_accounts(mailbox_id,status,batch,created_at) VALUES($1,'pending',$2,$3)`, [mb.id, b, now]);
            }
            allocated++;
        }
        return { allocated, skipped };
    });
}

export async function freeMailboxGroups() {
    const { rows } = await query(`SELECT grp, COUNT(*)::int AS n FROM mailboxes WHERE usage='free' GROUP BY grp ORDER BY grp`);
    return rows;
}

export async function deleteMailbox(id) {
    return withTransaction(async (client) => {
        const { rows: [g] } = await client.query(`SELECT id FROM gpt_accounts WHERE mailbox_id=$1`, [id]);
        const { rows: [c] } = await client.query(`SELECT id FROM claude_accounts WHERE mailbox_id=$1`, [id]);
        if (g || c) return { ok: false, reason: "该邮箱已被业务占用,请从对应业务域删除" };
        const res = await client.query(`DELETE FROM mailboxes WHERE id=$1`, [id]);
        return { ok: res.rowCount > 0 };
    });
}

export async function batchDeleteMailbox(ids) {
    return withTransaction(async (client) => {
        let count = 0, skipped = 0;
        for (const id of (ids || [])) {
            const { rows: [g] } = await client.query(`SELECT id FROM gpt_accounts WHERE mailbox_id=$1`, [id]);
            const { rows: [c] } = await client.query(`SELECT id FROM claude_accounts WHERE mailbox_id=$1`, [id]);
            if (g || c) { skipped++; continue; }
            const res = await client.query(`DELETE FROM mailboxes WHERE id=$1`, [id]);
            if (res.rowCount) count++;
        }
        return { count, skipped };
    });
}

export async function setMailboxPassword(id, password, pwStatus?) {
    await query(`UPDATE mailboxes SET password=$1, pw_status=$2 WHERE id=$3`, [password, pwStatus ?? "", id]);
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
    await query(`UPDATE claude_accounts SET status='failed', error=$1, finished_at=$2, instance_id='' WHERE id=$3`,
        [String(error || "").slice(0, 2000), Date.now(), id]);
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

export async function deleteClaudeAccount(id, { keepMailbox = false } = {}) {
    return withTransaction(async (client) => {
        const { rows: [row] } = await client.query(`SELECT mailbox_id FROM claude_accounts WHERE id=$1`, [id]);
        await client.query(`DELETE FROM claude_logs WHERE claude_id=$1`, [id]);
        await client.query(`DELETE FROM claude_accounts WHERE id=$1`, [id]);
        if (row) {
            if (keepMailbox) {
                await client.query(`UPDATE mailboxes SET usage='free' WHERE id=$1`, [row.mailbox_id]);
            } else {
                await client.query(`DELETE FROM mailboxes WHERE id=$1`, [row.mailbox_id]);
                await client.query(`DELETE FROM mailbox_logs WHERE mailbox_id=$1`, [row.mailbox_id]);
            }
        }
    });
}

export async function claudeStats() {
    const out = { pending: 0, running: 0, success: 0, failed: 0, total: 0 };
    const { rows } = await query(`SELECT status, COUNT(*)::int AS n FROM claude_accounts GROUP BY status`);
    for (const row of rows) { out[row.status] = row.n; out.total += row.n; }
    return out;
}

// ---- 充值卡密管理 ----

export async function importRechargeCards(codes, batch = "") {
    const now = Date.now();
    return withTransaction(async (client) => {
        let inserted = 0;
        for (const code of codes) {
            const res = await client.query(
                `INSERT INTO recharge_cards(code,batch,created_at,updated_at) VALUES($1,$2,$3,$4) ON CONFLICT(code) DO NOTHING`,
                [code.trim(), batch, now, now]
            );
            inserted += res.rowCount;
        }
        return { inserted, skipped: codes.length - inserted, total: codes.length };
    });
}

export async function listRechargeCards() {
    const { rows: list } = await query(`SELECT * FROM recharge_cards ORDER BY id`);
    const out = { unused: 0, paired: 0, submitting: 0, submitted: 0, done: 0, error: 0, total: 0 };
    const { rows: statsRows } = await query(`SELECT status, COUNT(*)::int AS n FROM recharge_cards GROUP BY status`);
    for (const r of statsRows) { out[r.status] = r.n; out.total += r.n; }
    return { list, stats: out };
}

export async function getRechargeCard(id) {
    const { rows } = await query(`SELECT * FROM recharge_cards WHERE id=$1`, [id]);
    return rows[0] || undefined;
}

export async function deleteRechargeCards(ids) {
    let count = 0;
    await withTransaction(async (client) => {
        for (const id of (ids || [])) {
            const res = await client.query(`DELETE FROM recharge_cards WHERE id=$1`, [id]);
            count += res.rowCount;
        }
    });
    return { count };
}

export async function updateRechargeCard(id, fields) {
    const allowed = ["status", "plan_type", "plan_name", "product", "category", "auth_mode", "account_id", "account_email", "task_no", "task_status", "task_message", "error", "batch"];
    const sets = [], vals = [];
    for (const k of allowed) {
        if (fields[k] !== undefined) { sets.push(`${k}=$${vals.length + 1}`); vals.push(fields[k]); }
    }
    if (!sets.length) return;
    sets.push(`updated_at=$${vals.length + 1}`); vals.push(Date.now());
    vals.push(id);
    await query(`UPDATE recharge_cards SET ${sets.join(",")} WHERE id=$${vals.length}`, vals);
}

export async function pairRechargeCards(pairs) {
    const now = Date.now();
    await withTransaction(async (client) => {
        for (const p of pairs) {
            await client.query(
                `UPDATE recharge_cards SET status='paired', account_id=$1, account_email=$2, updated_at=$3 WHERE id=$4 AND status='unused'`,
                [p.accountId, p.accountEmail, now, p.cardId]
            );
        }
    });
}

export async function unpairRechargeCards(ids) {
    const now = Date.now();
    await withTransaction(async (client) => {
        for (const id of (ids || [])) {
            await client.query(`UPDATE recharge_cards SET status='unused', account_id=0, account_email='', updated_at=$1 WHERE id=$2`, [now, id]);
        }
    });
}

export async function rechargeUnusedCount() {
    const { rows: [r] } = await query(`SELECT COUNT(*)::int AS n FROM recharge_cards WHERE status='unused'`);
    return r.n;
}

export async function pickUnusedCards(n) {
    const { rows } = await query(`SELECT * FROM recharge_cards WHERE status='unused' ORDER BY id LIMIT $1`, [n]);
    return rows;
}

export async function listSubmittedPending() {
    const { rows } = await query(`SELECT * FROM recharge_cards WHERE status='submitted' AND task_status NOT IN ('paid','failed','canceled','returned') ORDER BY id`);
    return rows;
}

// ---- 充值队列 ----

export async function addToRechargeQueue(accountIds, batch = "") {
    const now = Date.now();
    return withTransaction(async (client) => {
        let added = 0;
        for (const id of accountIds) {
            const { rows: [acc] } = await client.query(`SELECT ${ACC_COLS_FULL} ${ACC_FROM} WHERE g.id=$1`, [id]);
            if (!acc) continue;
            const res = await client.query(
                `INSERT INTO recharge_queue(account_id,email,auth_file,plan,batch,created_at,auth_data) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(account_id) DO NOTHING`,
                [acc.id, acc.email, acc.auth_file || "", acc.plan || "", batch, now, acc.auth_data ? JSON.stringify(acc.auth_data) : null]
            );
            if (res.rowCount) {
                await client.query(`UPDATE gpt_accounts SET sold_at=$1 WHERE id=$2`, [now, acc.id]);
                added++;
            }
        }
        return { added, total: accountIds.length };
    });
}

export async function listRechargeQueue() {
    const { rows: list } = await query(`SELECT * FROM recharge_queue ORDER BY id`);
    const out = { pending: 0, paired: 0, submitting: 0, submitted: 0, done: 0, error: 0, total: 0 };
    const { rows: statsRows } = await query(`SELECT status, COUNT(*)::int AS n FROM recharge_queue GROUP BY status`);
    for (const r of statsRows) { out[r.status] = r.n; out.total += r.n; }
    return { list, stats: out };
}

export async function getRechargeQueueItem(id) {
    const { rows } = await query(`SELECT * FROM recharge_queue WHERE id=$1`, [id]);
    return rows[0] || undefined;
}

export async function removeFromRechargeQueue(ids) {
    let count = 0;
    await withTransaction(async (client) => {
        for (const id of (ids || [])) {
            const { rows: [item] } = await client.query(`SELECT * FROM recharge_queue WHERE id=$1`, [id]);
            if (!item) continue;
            const res = await client.query(`DELETE FROM recharge_queue WHERE id=$1`, [id]);
            if (res.rowCount) {
                await client.query(`UPDATE gpt_accounts SET sold_at=0 WHERE id=$1`, [item.account_id]);
                count++;
            }
        }
    });
    return { count };
}

export async function setRechargeQueueBatch(ids, batch) {
    await withTransaction(async (client) => {
        for (const id of (ids || [])) {
            await client.query(`UPDATE recharge_queue SET batch=$1 WHERE id=$2`, [batch, id]);
        }
    });
}

export async function updateQueueItem(id, fields) {
    const allowed = ["status", "card_id", "card_code", "task_no", "task_status", "task_message", "error", "batch", "plan_type"];
    const sets = [], vals = [];
    for (const k of allowed) {
        if (fields[k] !== undefined) { sets.push(`${k}=$${vals.length + 1}`); vals.push(fields[k]); }
    }
    if (!sets.length) return;
    vals.push(id);
    await query(`UPDATE recharge_queue SET ${sets.join(",")} WHERE id=$${vals.length}`, vals);
}

export async function resetRechargeQueue(ids) {
    await withTransaction(async (client) => {
        for (const id of (ids || [])) {
            const { rows: [item] } = await client.query(`SELECT * FROM recharge_queue WHERE id=$1`, [id]);
            if (!item || item.status === "submitted" || item.status === "done") continue;
            if (item.card_id) {
                await client.query(`UPDATE recharge_cards SET status='unused', account_id=0, account_email='', updated_at=$1 WHERE id=$2`, [Date.now(), item.card_id]);
            }
            const { rows: [acc] } = await client.query(`SELECT ${ACC_COLS_FULL} ${ACC_FROM} WHERE g.id=$1`, [item.account_id]);
            const freshAuthFile = acc?.auth_file || item.auth_file;
            const freshAuthData = acc?.auth_data || item.auth_data;
            await client.query(
                `UPDATE recharge_queue SET status='pending', card_id=0, card_code='', task_no='', task_status='', task_message='', error='', auth_file=$1, auth_data=$2 WHERE id=$3`,
                [freshAuthFile, freshAuthData ? JSON.stringify(freshAuthData) : null, id]
            );
        }
    });
}

export async function listQueueSubmittedPending() {
    const { rows } = await query(`SELECT * FROM recharge_queue WHERE status='submitted' AND task_status NOT IN ('paid','failed','canceled','returned') ORDER BY id`);
    return rows;
}

export async function rechargeQueueBatches() {
    const { rows } = await query(`SELECT batch AS name, COUNT(*)::int AS n FROM recharge_queue WHERE batch!='' GROUP BY batch ORDER BY MAX(id) DESC`);
    return rows;
}

export async function listRechargeQueueFull(ids?: number[], batch?: string) {
    let sql = `SELECT rq.*, m.password, g.rt_file, g.auth_file AS gpt_auth_file, g.auth_data AS gpt_auth_data, g.rt_data AS gpt_rt_data
               FROM recharge_queue rq
               JOIN gpt_accounts g ON rq.account_id = g.id
               JOIN mailboxes m ON g.mailbox_id = m.id`;
    const conds: string[] = [], params: any[] = [];
    if (ids && ids.length) {
        const placeholders = ids.map((_, i) => `$${params.length + i + 1}`).join(",");
        conds.push(`rq.id IN (${placeholders})`);
        params.push(...ids);
    }
    if (batch) {
        conds.push(`rq.batch = $${params.length + 1}`);
        params.push(batch);
    }
    if (conds.length) sql += ` WHERE ${conds.join(" AND ")}`;
    sql += ` ORDER BY rq.id`;
    const { rows } = await query(sql, params);
    return rows;
}
