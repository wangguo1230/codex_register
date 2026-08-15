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
  m.pw_status AS pw_status, m.provider AS provider, g.batch AS batch, g.mailbox_id AS mailbox_id,
  m.recovery_email AS recovery_email, m.totp_secret AS mailbox_totp, m.imap_password AS mailbox_imap,
  g.gpt_password AS gpt_password, g.totp_secret AS totp_secret, g.mfa_status AS mfa_status,
  GREATEST(g.deleted_at, m.deleted_at) AS deleted_at`;
const ACC_COLS_FULL = `${ACC_COLS_LIST}, g.auth_data, g.rt_data`;
const ACC_FROM = `FROM gpt_accounts g JOIN mailboxes m ON g.mailbox_id = m.id`;
// 账号删除口径:GPT 记录软删(g) 或 邮箱软删联动(m),任一 >0 即视为已删除
const ACC_ALIVE = `g.deleted_at=0 AND m.deleted_at=0`;
const ACC_DELETED = `(g.deleted_at>0 OR m.deleted_at>0)`;

const CLAUDE_COLS_LIST = `c.id, c.mailbox_id, c.status, c.session_key, c.org_id, c.auth_file, c.plan, c.claude_code, c.engine,
           c.batch, c.error, c.dead_at, c.sold_at, c.started_at, c.finished_at, c.created_at,
           m.email, m.password, m.provider, m.pw_status, m.grp`;
const CLAUDE_COLS_FULL = `${CLAUDE_COLS_LIST}, c.auth_data`;

const MAILBOX_FIELDS = ["email", "password", "pw_status", "recovery_email", "totp_secret", "imap_password"];
const GPT_FIELDS = ["status", "plan", "phone", "card", "at_status", "rt_status", "chat_status", "error", "dead_at", "sold_at", "finished_at", "batch", "auth_file", "token", "rt_file", "engine", "auth_data", "rt_data", "gpt_password", "totp_secret", "mfa_status"];

// 启动初始化：重置中断状态（原 SQLite 版在模块加载时同步执行）
export async function init() {
    // 只重置本实例的孤儿任务 + 旧版无标记的遗留数据（instance_id=''）
    await query(`UPDATE gpt_accounts SET status='pending', instance_id='' WHERE status='running' AND (instance_id=$1 OR instance_id='')`, [instanceId]);
    await query(`UPDATE claude_accounts SET status='pending', instance_id='' WHERE status='running' AND (instance_id=$1 OR instance_id='')`, [instanceId]);
    await query(`UPDATE sms_pool SET status='free', bound_email='', claimed_by='' WHERE status='claimed' AND (claimed_by=$1 OR claimed_by='')`, [instanceId]);
    await query(`UPDATE pw_queue SET status='pending', instance_id='' WHERE status='running' AND (instance_id=$1 OR instance_id='')`, [instanceId]);
    await query(`UPDATE mail_jobs SET status='pending', instance_id='', last_line='实例重启，退回排队' WHERE status='running' AND (instance_id=$1 OR instance_id='')`, [instanceId]);
    await releaseRechargeQueueByInstance(instanceId);
    console.log(`[db] 启动初始化完成 (instance=${instanceId})：本实例 running→pending, claimed→free`);
}

// 全局清理：重置所有实例的 running/claimed（某台机器断电后手动调用）
export async function cleanupAllStale() {
    const r1 = await query(`UPDATE gpt_accounts SET status='pending', instance_id='' WHERE status='running' RETURNING id`);
    const r2 = await query(`UPDATE claude_accounts SET status='pending', instance_id='' WHERE status='running' RETURNING id`);
    const r3 = await query(`UPDATE sms_pool SET status='free', bound_email='', claimed_by='' WHERE status='claimed' RETURNING id`);
    const r4 = await query(`UPDATE pw_queue SET status='pending', instance_id='' WHERE status='running' RETURNING id`);
    await query(`UPDATE mail_jobs SET status='pending', instance_id='', last_line='清理残留' WHERE status='running'`);
    const r5 = await query(
        `UPDATE recharge_queue SET
            status = CASE
                WHEN status = 'submitting' AND card_id > 0 THEN 'paired'
                WHEN status = 'submitting' THEN 'pending'
                ELSE status
            END,
            instance_id = ''
         WHERE instance_id != '' RETURNING id`
    );
    return {gpt: r1.rowCount, claude: r2.rowCount, sms: r3.rowCount, pw: r4.rowCount, recharge: r5.rowCount};
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
            const {straightenImportRow} = await import("../src/mfa.js");
            const row = straightenImportRow(r);
            const { rows: ins } = await client.query(
                `INSERT INTO mailboxes(email,password,provider,usage,grp,created_at,recovery_email,totp_secret)
                 VALUES($1,$2,$3,'gpt',$4,$5,$6,$7) ON CONFLICT(email) DO NOTHING RETURNING id`,
                [email, r.password, prov, grp, now, row.recovery_email || "", row.totp_secret || ""]
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

// ---- 软删除辅助 ----

async function softDeleteMailbox(client, mailboxId) {
    if (!mailboxId) return;
    await client.query(`UPDATE mailboxes SET deleted_at=$1, usage='deleted' WHERE id=$2 AND deleted_at=0`, [Date.now(), mailboxId]);
}

// 删 GPT 号:只打软删标记(记录+日志保留,可按邮箱回查),邮箱同步软删
async function softDeleteGpt(client, gptId) {
    const { rows: [row] } = await client.query(`SELECT mailbox_id FROM gpt_accounts WHERE id=$1`, [gptId]);
    if (!row) return false;
    await client.query(`UPDATE gpt_accounts SET deleted_at=$1, instance_id='' WHERE id=$2 AND deleted_at=0`, [Date.now(), gptId]);
    await softDeleteMailbox(client, row.mailbox_id);
    return true;
}

// 邮箱分配给 GPT:mailbox_id 唯一,该邮箱若有软删旧记录则复用并重置(否则唯一约束冲突)
async function insertOrReviveGpt(client, mailboxId, batch, now) {
    await client.query(
        `INSERT INTO gpt_accounts(mailbox_id,status,batch,created_at) VALUES($1,'pending',$2,$3)
         ON CONFLICT(mailbox_id) DO UPDATE SET
            deleted_at=0, status='pending', batch=EXCLUDED.batch, created_at=EXCLUDED.created_at,
            token='', auth_file='', rt_file='', plan='', phone='', card='', engine='',
            at_status='', rt_status='', chat_status='', mfa_status='', error='',
            dead_at=0, sold_at=0, started_at=NULL, finished_at=NULL, instance_id='',
            auth_data=NULL, rt_data=NULL, gpt_password='', totp_secret=''
         WHERE gpt_accounts.deleted_at>0`,
        [mailboxId, batch, now]
    );
}

// ---- 邮箱资源池 ----

export async function listMailboxes(usage?) {
    if (usage === 'deleted') {
        const { rows } = await query(`SELECT * FROM mailboxes WHERE deleted_at>0 ORDER BY id`);
        return rows;
    }
    if (usage) {
        const { rows } = await query(`SELECT * FROM mailboxes WHERE usage=$1 AND deleted_at=0 ORDER BY id`, [usage]);
        return rows;
    }
    const { rows } = await query(`SELECT * FROM mailboxes WHERE deleted_at=0 ORDER BY id`);
    return rows;
}

export async function mailboxStats() {
    const out = { free: 0, hold: 0, gpt: 0, claude: 0, total: 0, deleted: 0 };
    const { rows } = await query(`SELECT usage, COUNT(*)::int AS n FROM mailboxes WHERE deleted_at=0 GROUP BY usage`);
    for (const row of rows) {
        if (out[row.usage] !== undefined) out[row.usage] = row.n;
        out.total += row.n;
    }
    const { rows: [del] } = await query(`SELECT COUNT(*)::int AS n FROM mailboxes WHERE deleted_at>0`);
    out.deleted = del?.n || 0;
    return out;
}

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
    let n = 0;
    await withTransaction(async (client) => {
        for (const id of (ids || [])) {
            const soldGuard = usage === "free" ? " AND COALESCE(sold_at,0)=0" : "";
            const res = await client.query(`UPDATE mailboxes SET usage=$1 WHERE id=$2 AND usage IN ('free','hold') AND deleted_at=0${soldGuard}`, [usage, id]);
            n += res.rowCount;
        }
    });
    return { count: n };
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

export async function getMailbox(id) {
    // 含已删除:详情/查账密仍要能读
    const { rows } = await query(`SELECT * FROM mailboxes WHERE id=$1`, [id]);
    return rows[0] || undefined;
}

export async function lookupMailboxesByEmails(emails) {
    const list = [...new Set((emails || []).map((e) => String(e || "").trim().toLowerCase()).filter(Boolean))];
    if (!list.length) return [];
    const { rows } = await query(`SELECT * FROM mailboxes WHERE LOWER(email) = ANY($1) ORDER BY deleted_at ASC, id`, [list]);
    return rows;
}

export async function getMailboxByEmail(email) {
    const { rows } = await query(`SELECT * FROM mailboxes WHERE email=$1 AND deleted_at=0`, [String(email).toLowerCase()]);
    return rows[0] || undefined;
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
            const {straightenImportRow} = await import("../src/mfa.js");
            const row = straightenImportRow(r);
            const { rows: ins } = await client.query(
                `INSERT INTO mailboxes(email,password,provider,usage,grp,created_at,recovery_email,totp_secret)
                 VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(email) DO NOTHING RETURNING id`,
                [email, r.password, prov, u, g, now, row.recovery_email || "", row.totp_secret || ""]
            );
            if (ins[0]?.id) {
                ids.push(ins[0].id);
            } else {
                const { rows: upd } = await client.query(
                    `UPDATE mailboxes SET deleted_at=0, usage=$1, password=$2, provider=$3, grp=$4, recovery_email=$5, totp_secret=$6 WHERE email=$7 AND deleted_at>0 RETURNING id`,
                    [u, r.password, prov, g, row.recovery_email || "", row.totp_secret || "", email]
                );
                if (upd[0]?.id) ids.push(upd[0].id);
            }
        }
        return { inserted: ids.length, skipped: rows.length - ids.length, total: rows.length, ids };
    });
}

const FREE_GOOGLE_IMAP_SQL = `
    m.usage='hold' AND m.deleted_at=0
    AND COALESCE(m.sold_at,0)=0
    AND m.provider='google'
    AND COALESCE(m.imap_password,'') <> ''
    AND COALESCE(m.google_stage,'') NOT IN ('gpt_ok')
    AND NOT EXISTS (SELECT 1 FROM gpt_accounts g WHERE g.mailbox_id=m.id AND COALESCE(g.deleted_at,0)=0)
    AND NOT EXISTS (SELECT 1 FROM claude_accounts c WHERE c.mailbox_id=m.id)
`;

const FREE_MAILCOM_SQL = `
    m.usage='hold' AND m.deleted_at=0
    AND COALESCE(m.sold_at,0)=0
    AND COALESCE(m.provider,'mailcom') IN ('mailcom','')
    AND COALESCE(m.password,'') <> ''
    AND NOT EXISTS (SELECT 1 FROM gpt_accounts g WHERE g.mailbox_id=m.id AND COALESCE(g.deleted_at,0)=0)
    AND NOT EXISTS (SELECT 1 FROM claude_accounts c WHERE c.mailbox_id=m.id)
`;

export async function countFreeGoogleImapMailboxes() {
    const { rows } = await query(`SELECT COUNT(*)::int AS n FROM mailboxes m WHERE ${FREE_GOOGLE_IMAP_SQL}`);
    return rows[0]?.n || 0;
}

/** 可换绑 Gmail 池：独立未售、已开 IMAP、未挂 GPT/Claude。 */
export async function listRebindGmailPool() {
    const { rows } = await query(`
        SELECT m.id, m.email, COALESCE(m.grp,'') AS grp
        FROM mailboxes m
        WHERE ${FREE_GOOGLE_IMAP_SQL}
        ORDER BY m.grp, m.id DESC
    `);
    const groups = [];
    const map = new Map();
    for (const r of rows) {
        const g = r.grp || "";
        if (!map.has(g)) {
            const rec = {grp: g, n: 0};
            map.set(g, rec);
            groups.push(rec);
        }
        map.get(g).n += 1;
    }
    return {list: rows, groups, count: rows.length};
}

function googleImapClaimWhere({grp, emails, excludeIds} = {}) {
    const conds = [FREE_GOOGLE_IMAP_SQL];
    const params = [];
    if (grp !== undefined && grp !== null && grp !== "__ALL__") {
        params.push(String(grp));
        conds.push(`COALESCE(m.grp,'') = $${params.length}`);
    }
    if (Array.isArray(emails) && emails.length) {
        params.push(emails.map((e) => String(e || "").trim().toLowerCase()).filter(Boolean));
        conds.push(`lower(m.email) = ANY($${params.length})`);
    }
    if (Array.isArray(excludeIds) && excludeIds.length) {
        params.push(excludeIds.map(Number).filter(Number.isInteger));
        conds.push(`NOT (m.id = ANY($${params.length}))`);
    }
    return {sql: conds.join(" AND "), params};
}

/** 指定邮箱领不到时，说明每个号为什么不在可换绑池里。 */
export async function explainRebindGmailMiss(emails = []) {
    const list = [...new Set((emails || []).map((e) => String(e || "").trim().toLowerCase()).filter((e) => e.includes("@")))];
    if (!list.length) return "";
    const {rows} = await query(
        `SELECT m.email, m.usage, m.deleted_at, COALESCE(m.sold_at,0) AS sold_at, m.provider,
                COALESCE(m.imap_password,'') AS imap_password, COALESCE(m.google_stage,'') AS google_stage,
                EXISTS (SELECT 1 FROM gpt_accounts g WHERE g.mailbox_id=m.id AND COALESCE(g.deleted_at,0)=0) AS gpt,
                EXISTS (SELECT 1 FROM claude_accounts c WHERE c.mailbox_id=m.id) AS claude
         FROM mailboxes m WHERE lower(m.email) = ANY($1)`,
        [list],
    );
    const by = new Map(rows.map((r) => [String(r.email || "").toLowerCase(), r]));
    const bits = [];
    for (const email of list) {
        const r = by.get(email);
        if (!r) { bits.push(`${email} 库里没有`); continue; }
        if (Number(r.deleted_at) > 0) { bits.push(`${email} 已删除`); continue; }
        if (Number(r.sold_at) > 0) { bits.push(`${email} 已售`); continue; }
        if (r.provider !== "google") { bits.push(`${email} 不是 Gmail`); continue; }
        if (r.usage !== "hold") { bits.push(`${email} 不是独立(${r.usage})`); continue; }
        if (!String(r.imap_password || "").trim()) { bits.push(`${email} 无 IMAP 密码`); continue; }
        if (r.google_stage === "gpt_ok") { bits.push(`${email} 已挂过 GPT`); continue; }
        if (r.gpt) { bits.push(`${email} 已被 GPT 占用`); continue; }
        if (r.claude) { bits.push(`${email} 已被 Claude 占用`); continue; }
        bits.push(`${email} 在池里但这次没领到`);
    }
    return bits.slice(0, 6).join("；");
}

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

/** 可换绑候选：仍是独立未售，只读，不预占。 */
export async function listRebindGmailCandidates(opts = {}) {
    const {sql, params} = googleImapClaimWhere(opts);
    const { rows } = await query(
        `SELECT m.id, m.email, m.password, m.totp_secret, m.recovery_email, m.imap_password, COALESCE(m.grp,'') AS grp
         FROM mailboxes m WHERE ${sql} ORDER BY m.id DESC`,
        params,
    );
    return rows;
}

/** 领一个空闲、已开 IMAP、且未被任何 GPT/Claude 占用的 Gmail。不新建 gpt_accounts。 */
export async function claimFreeGoogleImapMailbox(opts = {}) {
    return withTransaction(async (client) => {
        const {sql, params} = googleImapClaimWhere(opts);
        const { rows: [mb] } = await client.query(
            `SELECT m.* FROM mailboxes m WHERE ${sql} ORDER BY m.id DESC LIMIT 1 FOR UPDATE SKIP LOCKED`,
            params,
        );
        if (!mb) return null;
        await client.query(`UPDATE mailboxes SET usage='gpt' WHERE id=$1`, [mb.id]);
        return { ...mb, usage: "gpt" };
    });
}

/** 探活通过后再预占这一号。仍必须是独立未售，失败则别人可能已领走。 */
export async function claimMailboxForRebind(id) {
    const mailboxId = Number(id);
    if (!Number.isInteger(mailboxId)) return null;
    return withTransaction(async (client) => {
        const { rows: [mb] } = await client.query(
            `SELECT m.* FROM mailboxes m WHERE m.id=$1 AND ${FREE_GOOGLE_IMAP_SQL} FOR UPDATE`,
            [mailboxId],
        );
        if (!mb) return null;
        await client.query(`UPDATE mailboxes SET usage='gpt' WHERE id=$1`, [mailboxId]);
        return { ...mb, usage: "gpt" };
    });
}

export async function markMailboxSold(id, note = "") {
    const mailboxId = Number(id);
    if (!Number.isInteger(mailboxId)) return 0;
    const now = Date.now();
    const tip = String(note || "").slice(0, 80);
    const { rowCount } = await query(
        `UPDATE mailboxes
         SET sold_at=CASE WHEN sold_at>0 THEN sold_at ELSE $1 END,
             note=CASE WHEN $3='' THEN note ELSE $3 END
         WHERE id=$2 AND deleted_at=0`,
        [now, mailboxId, tip],
    );
    return rowCount || 0;
}

/** 官方已占用/不可再用：标已售+独立，不再进空闲池。 */
export async function quarantineMailbox(id, reason = "") {
    const mailboxId = Number(id);
    if (!Number.isInteger(mailboxId)) return 0;
    const now = Date.now();
    const note = String(reason || "官方已占用").slice(0, 80);
    const { rowCount } = await query(
        `UPDATE mailboxes SET usage='hold', sold_at=CASE WHEN sold_at>0 THEN sold_at ELSE $1 END, note=$2
         WHERE id=$3 AND deleted_at=0`,
        [now, note, mailboxId]
    );
    return rowCount || 0;
}

export async function releaseMailboxToFree(id) {
    const mailboxId = Number(id);
    if (!Number.isInteger(mailboxId)) return 0;
    const { rowCount } = await query(
        `UPDATE mailboxes SET usage='hold' WHERE id=$1 AND deleted_at=0 AND usage='gpt'`,
        [mailboxId]
    );
    return rowCount || 0;
}

/** 官方换绑已成功后改指针：新邮箱 usage=gpt 且已售，旧邮箱已售不回池。 */
export async function rebindGptMailbox(gptId, newMailboxId) {
    return withTransaction(async (client) => {
        const { rows: [gpt] } = await client.query(
            `SELECT id, mailbox_id FROM gpt_accounts WHERE id=$1 FOR UPDATE`, [gptId]
        );
        if (!gpt) throw new Error("GPT 账号不存在");
        const { rows: [mb] } = await client.query(
            `SELECT id, email FROM mailboxes WHERE id=$1 AND deleted_at=0 FOR UPDATE`, [newMailboxId]
        );
        if (!mb) throw new Error("目标邮箱不存在");
        if (gpt.mailbox_id === newMailboxId) return {oldMailboxId: gpt.mailbox_id, newMailboxId, email: mb.email};
        const { rows: [taken] } = await client.query(
            `SELECT id FROM gpt_accounts WHERE mailbox_id=$1 AND id<>$2`, [newMailboxId, gptId]
        );
        if (taken) throw new Error("目标邮箱已被其他 GPT 占用");
        const oldId = gpt.mailbox_id;
        const now = Date.now();
        await client.query(
            `UPDATE gpt_accounts SET mailbox_id=$1, sold_at=CASE WHEN sold_at>0 THEN sold_at ELSE $2 END WHERE id=$3`,
            [newMailboxId, now, gptId]
        );
        await client.query(`UPDATE mailboxes SET usage='gpt', sold_at=CASE WHEN sold_at>0 THEN sold_at ELSE $2 END WHERE id=$1`, [newMailboxId, now]);
        if (oldId && oldId !== newMailboxId) {
            await client.query(
                `UPDATE mailboxes SET usage='hold', sold_at=CASE WHEN sold_at>0 THEN sold_at ELSE $1 END WHERE id=$2 AND deleted_at=0`,
                [now, oldId]
            );
        }
        return {oldMailboxId: oldId, newMailboxId, email: mb.email};
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

export async function freeMailboxGroups() {
    const { rows } = await query(`SELECT grp, COUNT(*)::int AS n FROM mailboxes WHERE usage='free' AND deleted_at=0 GROUP BY grp ORDER BY grp`);
    return rows;
}

export async function deleteMailbox(id) {
    return withTransaction(async (client) => {
        await softDeleteMailbox(client, id);
        return { ok: true };
    });
}

export async function batchDeleteMailbox(ids) {
    return withTransaction(async (client) => {
        let count = 0;
        for (const id of (ids || [])) {
            const res = await client.query(`UPDATE mailboxes SET deleted_at=$1, usage='deleted' WHERE id=$2 AND deleted_at=0`, [Date.now(), id]);
            count += res.rowCount;
        }
        return { count, skipped: 0 };
    });
}

export async function setMailboxPassword(id, password, pwStatus?) {
    const next = String(password || "");
    if (!next) return;
    await query(
        `UPDATE mailboxes
         SET password_prev=CASE WHEN password<>$1 AND COALESCE(password,'')<>'' THEN password ELSE password_prev END,
             password=$1, pw_status=$2
         WHERE id=$3`,
        [next, pwStatus ?? "", id],
    );
    await refreshMailboxGoogleState(id).catch(() => {});
}

export async function setMailboxTotp(id, totpSecret) {
    await query(`UPDATE mailboxes SET totp_secret=$1 WHERE id=$2`, [totpSecret || "", id]);
    await refreshMailboxGoogleState(id).catch(() => {});
}

export async function setMailboxImapPassword(id, imapPassword) {
    await query(`UPDATE mailboxes SET imap_password=$1 WHERE id=$2`, [imapPassword || "", id]);
    await refreshMailboxGoogleState(id).catch(() => {});
}

export async function applyMailboxUpdate(email, patch = {}) {
    const em = String(email || "").trim().toLowerCase();
    if (!em) return {ok: false};
    const sets = [];
    const vals = [];
    if (patch.password != null) { sets.push(`password=$${sets.length + 1}`); vals.push(patch.password); }
    if (patch.totp_secret != null) { sets.push(`totp_secret=$${sets.length + 1}`); vals.push(patch.totp_secret); }
    if (patch.imap_password != null) { sets.push(`imap_password=$${sets.length + 1}`); vals.push(patch.imap_password); }
    if (patch.recovery_email != null) { sets.push(`recovery_email=$${sets.length + 1}`); vals.push(patch.recovery_email); }
    if (sets.length) {
        vals.push(em);
        await query(`UPDATE mailboxes SET ${sets.join(", ")} WHERE email=$${vals.length} AND deleted_at=0`, vals);
    }
    if (patch.google_overlay || sets.length) {
        await refreshMailboxGoogleState(em, patch.google_overlay || {});
    }
    return {ok: true};
}

export async function refreshMailboxGoogleState(emailOrId, overlay = {}) {
    const {deriveGoogleState} = await import("../src/mail/google-state.ts");
    const key = emailOrId;
    const {rows} = typeof key === "number"
        ? await query(
            `SELECT m.*, g.status AS gpt_status, g.error AS gpt_error
             FROM mailboxes m LEFT JOIN gpt_accounts g ON g.mailbox_id=m.id AND g.deleted_at=0
             WHERE m.id=$1`,
            [key],
        )
        : await query(
            `SELECT m.*, g.status AS gpt_status, g.error AS gpt_error
             FROM mailboxes m LEFT JOIN gpt_accounts g ON g.mailbox_id=m.id AND g.deleted_at=0
             WHERE m.email=$1 AND m.deleted_at=0`,
            [String(key).trim().toLowerCase()],
        );
    const mb = rows[0];
    if (!mb || mb.provider !== "google") return {ok: false};
    const state = deriveGoogleState(mb, overlay);
    await query(
        `UPDATE mailboxes SET google_state=$1::jsonb, google_stage=$2 WHERE id=$3`,
        [JSON.stringify(state), state.stage, mb.id],
    );
    return {ok: true, state, id: mb.id};
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
    return claimUnusedCards(n);
}

// 原子取卡:FOR UPDATE SKIP LOCKED,立刻标 paired,避免多实例抢同一张卡。数量不足则一张不取。
export async function claimUnusedCards(n) {
    const need = Math.max(0, Number(n) || 0);
    if (!need) return [];
    return withTransaction(async (client) => {
        const { rows } = await client.query(
            `SELECT * FROM recharge_cards WHERE status='unused' ORDER BY id LIMIT $1 FOR UPDATE SKIP LOCKED`,
            [need]
        );
        if (rows.length < need) return [];
        const ids = rows.map((r) => r.id);
        const now = Date.now();
        await client.query(`UPDATE recharge_cards SET status='paired', updated_at=$1 WHERE id = ANY($2)`, [now, ids]);
        return rows.map((r) => ({ ...r, status: "paired", updated_at: now }));
    });
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
                await softDeleteGpt(client, item.account_id);
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

// 谁点的谁跑:认领未被其他实例占用、且未提交/完成的队列项。
export async function claimRechargeQueueItems(ids, instId = instanceId) {
    const idList = (ids || []).map(Number).filter(Number.isInteger);
    if (!idList.length) return { claimed: [], skipped: [] };
    return withTransaction(async (client) => {
        const { rows: all } = await client.query(
            `SELECT id, email, status, instance_id FROM recharge_queue WHERE id = ANY($1)`,
            [idList]
        );
        const { rows } = await client.query(
            `SELECT * FROM recharge_queue
             WHERE id = ANY($1)
               AND status NOT IN ('submitted', 'done')
               AND instance_id = ''
             FOR UPDATE SKIP LOCKED`,
            [idList]
        );
        if (rows.length) {
            const claimedIds = rows.map((r) => r.id);
            await client.query(`UPDATE recharge_queue SET instance_id=$1 WHERE id = ANY($2)`, [instId, claimedIds]);
        }
        const claimedSet = new Set(rows.map((r) => r.id));
        const skipped = all.filter((r) => !claimedSet.has(r.id)).map((r) => ({
            id: r.id,
            email: r.email,
            status: r.status,
            instance_id: r.instance_id,
            reason: r.status === "submitted" || r.status === "done"
                ? `状态 ${r.status}`
                : (r.instance_id ? `实例 ${r.instance_id} 处理中` : "无法认领"),
        }));
        return { claimed: rows.map((r) => ({ ...r, instance_id: instId })), skipped };
    });
}

export async function releaseRechargeQueueItems(ids, instId = instanceId) {
    const idList = (ids || []).map(Number).filter(Number.isInteger);
    if (!idList.length) return 0;
    const { rowCount } = await query(
        `UPDATE recharge_queue SET instance_id='' WHERE instance_id=$1 AND id = ANY($2)`,
        [instId, idList]
    );
    return rowCount || 0;
}

export async function releaseRechargeQueueByInstance(instId = instanceId) {
    const { rowCount } = await query(
        `UPDATE recharge_queue SET
            status = CASE
                WHEN status = 'submitting' AND card_id > 0 THEN 'paired'
                WHEN status = 'submitting' THEN 'pending'
                ELSE status
            END,
            instance_id = ''
         WHERE instance_id = $1`,
        [instId]
    );
    return rowCount || 0;
}

export async function releaseInstanceWork(instId = instanceId) {
    const r1 = await query(`UPDATE gpt_accounts SET status='pending', error='', started_at=NULL, finished_at=NULL, instance_id='' WHERE status='running' AND instance_id=$1 RETURNING id`, [instId]);
    const r2 = await query(`UPDATE claude_accounts SET status='pending', error='', started_at=NULL, finished_at=NULL, instance_id='' WHERE status='running' AND instance_id=$1 RETURNING id`, [instId]);
    const r3 = await query(`UPDATE sms_pool SET status='free', bound_email='', claimed_by='' WHERE status='claimed' AND claimed_by=$1 RETURNING id`, [instId]);
    const r4 = await query(`UPDATE pw_queue SET status='pending', instance_id='' WHERE status='running' AND instance_id=$1 RETURNING id`, [instId]);
    const r5 = await query(`UPDATE mail_jobs SET status='pending', instance_id='', last_line='实例退出，退回排队' WHERE status='running' AND instance_id=$1 RETURNING id`, [instId]);
    const recharge = await releaseRechargeQueueByInstance(instId);
    return { gpt: r1.rowCount || 0, claude: r2.rowCount || 0, sms: r3.rowCount || 0, pw: r4.rowCount || 0, mail: r5.rowCount || 0, recharge };
}

export async function updateQueueItem(id, fields) {
    const allowed = ["status", "card_id", "card_code", "task_no", "task_status", "task_message", "error", "batch", "plan_type", "submitted_at", "finished_at", "instance_id", "email", "rebind_status", "rebind_email", "rebind_error", "rebind_target", "rebind_pool"];
    const sets = [], vals = [];
    for (const k of allowed) {
        if (fields[k] !== undefined) {
            let v = fields[k];
            if (k === "rebind_pool" && v && typeof v === "object") v = JSON.stringify(v);
            sets.push(`${k}=$${vals.length + 1}`);
            vals.push(v);
        }
    }
    if (!sets.length) return;
    vals.push(id);
    await query(`UPDATE recharge_queue SET ${sets.join(",")} WHERE id=$${vals.length}`, vals);
}

export async function resetRechargeQueue(ids) {
    const reclaimInfo: {reclaimed: number; kept: number} = {reclaimed: 0, kept: 0};
    await withTransaction(async (client) => {
        for (const id of (ids || [])) {
            const { rows: [item] } = await client.query(`SELECT * FROM recharge_queue WHERE id=$1`, [id]);
            if (!item || item.status === "submitted" || item.status === "done") continue;
            if (item.card_id) {
                const { rows: [card] } = await client.query(`SELECT * FROM recharge_cards WHERE id=$1`, [item.card_id]);
                if (card && !item.task_no && card.status === "paired") {
                    await client.query(`UPDATE recharge_cards SET status='unused', account_id=0, account_email='', updated_at=$1 WHERE id=$2`, [Date.now(), item.card_id]);
                    reclaimInfo.reclaimed++;
                } else if (card) {
                    reclaimInfo.kept++;
                }
            }
            const { rows: [acc] } = await client.query(`SELECT ${ACC_COLS_FULL} ${ACC_FROM} WHERE g.id=$1`, [item.account_id]);
            const freshAuthFile = acc?.auth_file || item.auth_file;
            const freshAuthData = acc?.auth_data || item.auth_data;
            await client.query(
                `UPDATE recharge_queue SET status='pending', card_id=0, card_code='', task_no='', task_status='', task_message='', error='', submitted_at=0, finished_at=0, auth_file=$1, auth_data=$2 WHERE id=$3`,
                [freshAuthFile, freshAuthData ? JSON.stringify(freshAuthData) : null, id]
            );
        }
    });
    return reclaimInfo;
}

export async function updateRechargeQueuePlanByAccount(accountId, planType) {
    if (!accountId || !planType) return 0;
    const { rowCount } = await query(`UPDATE recharge_queue SET plan_type=$1 WHERE account_id=$2`, [planType, accountId]);
    return rowCount || 0;
}

export async function updateQueueAuth(id, authFile, authData) {
    await query(`UPDATE recharge_queue SET auth_file=$1, auth_data=$2 WHERE id=$3`, [authFile || "", authData ? JSON.stringify(authData) : null, id]);
}

export async function updateQueueAuthByAccount(accountId, authFile, authData) {
    if (!accountId) return 0;
    const { rowCount } = await query(
        `UPDATE recharge_queue SET auth_file=$1, auth_data=$2 WHERE account_id=$3`,
        [authFile || "", authData ? JSON.stringify(authData) : null, accountId]
    );
    return rowCount || 0;
}

export async function listPendingGmailRebinds() {
    const { rows } = await query(
        `SELECT * FROM recharge_queue
         WHERE rebind_status='pending'
           AND (status='done' OR task_status='paid')
         ORDER BY id`
    );
    return rows;
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
    let sql = `SELECT rq.*, m.password, m.provider, m.totp_secret AS mailbox_totp,
                      g.gpt_password, g.totp_secret, g.rt_file,
                      g.auth_file AS gpt_auth_file, g.auth_data AS gpt_auth_data, g.rt_data AS gpt_rt_data
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

// ========== 邮箱任务共享队列（整备等，各机本机代理认领）==========

export async function drainPendingPwQueueToMailJobs() {
    const {rows} = await query(`SELECT mailbox_id, email, old_pw FROM pw_queue WHERE status='pending'`);
    if (!rows.length) return 0;
    const enq = await enqueueMailJobs(rows.map((r) => ({
        id: r.mailbox_id, email: r.email, payload: {oldPw: r.old_pw},
    })), "pw");
    await query(`DELETE FROM pw_queue WHERE status='pending'`);
    return enq.inserted;
}

export async function enqueueMailJobs(items, kind = "harden", batchId = "") {
    const now = Date.now();
    const bid = String(batchId || now.toString(36));
    let inserted = 0;
    await withTransaction(async (client) => {
        for (const it of items) {
            const mailboxId = Number(it.mailbox_id ?? it.id);
            if (!Number.isInteger(mailboxId)) continue;
            const email = String(it.email || "");
            const payload = it.payload != null ? JSON.stringify(it.payload) : null;
            const r = await client.query(
                `INSERT INTO mail_jobs(kind, mailbox_id, email, batch_id, status, created_at, payload)
                 SELECT $1,$2,$3,$4,'pending',$5,$6::jsonb
                 WHERE NOT EXISTS (
                    SELECT 1 FROM mail_jobs
                    WHERE kind=$1 AND mailbox_id=$2 AND status IN ('pending','running')
                 )`,
                [kind, mailboxId, email, bid, now, payload],
            );
            if (r.rowCount) inserted += 1;
        }
    });
    return {inserted, batchId: bid};
}

export async function claimMailJobs(instId = instanceId, limit = 1, kind = "") {
    const n = Math.max(1, Math.min(8, Number(limit) || 1));
    return withTransaction(async (client) => {
        const {rows} = await client.query(
            kind
                ? `SELECT id, kind, mailbox_id, email, batch_id, payload
                   FROM mail_jobs
                   WHERE status='pending' AND kind=$1
                   ORDER BY id LIMIT $2 FOR UPDATE SKIP LOCKED`
                : `SELECT id, kind, mailbox_id, email, batch_id, payload
                   FROM mail_jobs
                   WHERE status='pending'
                   ORDER BY id LIMIT $1 FOR UPDATE SKIP LOCKED`,
            kind ? [kind, n] : [n],
        );
        if (!rows.length) return [];
        const ids = rows.map((r) => r.id);
        const now = Date.now();
        await client.query(
            `UPDATE mail_jobs SET status='running', instance_id=$1, claimed_at=$2, heartbeat_at=$2, last_line='已认领'
             WHERE id = ANY($3)`,
            [instId, now, ids],
        );
        return rows.map((r) => ({...r, instance_id: instId}));
    });
}

export async function heartbeatMailJobs(instId = instanceId) {
    const {rowCount} = await query(
        `UPDATE mail_jobs SET heartbeat_at=$1 WHERE status='running' AND instance_id=$2`,
        [Date.now(), instId],
    );
    return rowCount || 0;
}

export async function setMailJobLine(jobId, line) {
    await query(`UPDATE mail_jobs SET last_line=$1, heartbeat_at=$2 WHERE id=$3 AND status='running'`,
        [String(line || "").slice(0, 180), Date.now(), jobId]);
}

export async function completeMailJob(jobId, ok, error = "", result = null) {
    await query(
        `UPDATE mail_jobs
         SET status=$1, ok=$2, error=$3, result=$4::jsonb, finished_at=$5, last_line=$6
         WHERE id=$7`,
        [ok ? "done" : "error", !!ok, String(error || "").slice(0, 240),
            JSON.stringify(result || {}), Date.now(), ok ? "完成" : String(error || "失败").slice(0, 180), jobId],
    );
}

export async function reclaimStaleMailJobs(maxAgeMs = 3 * 60 * 1000) {
    const cutoff = Date.now() - Math.max(30_000, maxAgeMs);
    const {rowCount} = await query(
        `UPDATE mail_jobs SET status='pending', instance_id='', last_line='心跳超时，退回排队'
         WHERE status='running' AND heartbeat_at>0 AND heartbeat_at<$1`,
        [cutoff],
    );
    return rowCount || 0;
}

export async function listResumableHardenMailboxIds() {
    return listResumableMailJobs({kinds: ["harden"], onlyError: false});
}

export async function listResumableMailJobs({kinds = ["harden"], onlyError = false} = {}) {
    const want = (kinds || ["harden"]).filter(Boolean);
    const {rows} = await query(
        `SELECT DISTINCT ON (kind, mailbox_id) mailbox_id, email, kind, status, error
         FROM mail_jobs
         WHERE kind = ANY($1)
         ORDER BY kind, mailbox_id, id DESC`,
        [want],
    );
    return rows
        .filter((r) => onlyError ? r.status === "error" : (r.status === "canceled" || r.status === "error"))
        .map((r) => ({
            id: Number(r.mailbox_id), email: r.email || "", kind: r.kind,
            status: r.status, error: r.error || "",
        }));
}

export async function cancelPendingMailJobs(kind = "") {
    const now = Date.now();
    const r = kind
        ? await query(`UPDATE mail_jobs SET status='canceled', finished_at=$1, last_line='已取消' WHERE status='pending' AND kind=$2`, [now, kind])
        : await query(`UPDATE mail_jobs SET status='canceled', finished_at=$1, last_line='已取消' WHERE status='pending'`, [now]);
    return r.rowCount || 0;
}

export async function failTimedOutMailJobs(maxMs = 12 * 60 * 1000) {
    const cutoff = Date.now() - Math.max(60_000, maxMs);
    const {rows} = await query(
        `UPDATE mail_jobs
         SET status='error', ok=FALSE, error='单任务超时', finished_at=$1, last_line='超时失败'
         WHERE status='running' AND claimed_at>0 AND claimed_at<$2
         RETURNING id, mailbox_id, instance_id, kind`,
        [Date.now(), cutoff],
    );
    return rows;
}

export async function setMailClaimPaused(paused) {
    await query(`UPDATE mail_control SET claim_paused=$1, updated_at=$2 WHERE id=1`, [!!paused, Date.now()]);
}

export async function isMailClaimPaused() {
    const {rows: [r]} = await query(`SELECT claim_paused FROM mail_control WHERE id=1`);
    return !!r?.claim_paused;
}

export async function upsertMailInstance(instId, snap = {}) {
    const now = Date.now();
    await query(
        `INSERT INTO mail_instances(instance_id, stop_claim, proxy_slots, proxy_leased, running_jobs, last_seen)
         VALUES($1,$2,$3,$4,$5,$6)
         ON CONFLICT (instance_id) DO UPDATE SET
           stop_claim=EXCLUDED.stop_claim,
           proxy_slots=EXCLUDED.proxy_slots,
           proxy_leased=EXCLUDED.proxy_leased,
           running_jobs=EXCLUDED.running_jobs,
           last_seen=EXCLUDED.last_seen`,
        [instId, !!snap.stopClaim, Number(snap.proxySlots || 0), Number(snap.proxyLeased || 0), Number(snap.runningJobs || 0), now],
    );
}

export async function listMailInstances(maxAgeMs = 45_000) {
    const cutoff = Date.now() - maxAgeMs;
    const {rows} = await query(
        `SELECT instance_id, stop_claim, proxy_slots, proxy_leased, running_jobs, last_seen
         FROM mail_instances WHERE last_seen>=$1 ORDER BY instance_id`,
        [cutoff],
    );
    return rows.map((r) => ({
        instanceId: r.instance_id,
        stopClaim: !!r.stop_claim,
        proxySlots: r.proxy_slots || 0,
        proxyLeased: r.proxy_leased || 0,
        runningJobs: r.running_jobs || 0,
        lastSeen: Number(r.last_seen || 0),
        free: Math.max(0, (r.proxy_slots || 0) - (r.proxy_leased || 0)),
    }));
}

export async function mailJobsProgress(kind = "") {
    const kindFilter = kind ? "AND kind=$1" : "";
    const params = kind ? [kind] : [];
    const {rows: open} = await query(
        `SELECT DISTINCT batch_id FROM mail_jobs WHERE status IN ('pending','running') AND COALESCE(batch_id,'')<>'' ${kindFilter}`,
        params,
    );
    let batchIds = open.map((r) => r.batch_id).filter(Boolean);
    if (!batchIds.length) {
        const {rows: [last]} = await query(
            `SELECT batch_id FROM mail_jobs WHERE COALESCE(batch_id,'')<>'' ${kindFilter} ORDER BY id DESC LIMIT 1`,
            params,
        );
        if (last?.batch_id) batchIds = [last.batch_id];
    }
    const paused = await isMailClaimPaused();
    const empty = {running: false, kind: kind || "mail", done: 0, total: 0, ok: 0, fail: 0, queued: 0, runningCount: 0, rate: 0, current: [], lastLine: "", batchId: "", byKind: {}, paused};
    if (!batchIds.length) return empty;
    const {rows} = await query(
        `SELECT kind, status, COUNT(*)::int AS n, COUNT(*) FILTER (WHERE ok)::int AS okc
         FROM mail_jobs WHERE batch_id = ANY($1) ${kind ? "AND kind=$2" : ""}
         GROUP BY kind, status`,
        kind ? [batchIds, kind] : [batchIds],
    );
    const by = {pending: 0, running: 0, done: 0, error: 0, canceled: 0};
    const byKind = {};
    let ok = 0;
    for (const r of rows) {
        if (by[r.status] !== undefined) by[r.status] += r.n;
        if (r.status === "done") ok += r.okc || 0;
        if (!byKind[r.kind]) byKind[r.kind] = {pending: 0, running: 0, done: 0, error: 0, ok: 0};
        if (byKind[r.kind][r.status] !== undefined) byKind[r.kind][r.status] += r.n;
        if (r.status === "done") byKind[r.kind].ok += r.okc || 0;
    }
    const fail = by.error;
    const done = by.done + by.error;
    const total = by.pending + by.running + by.done + by.error;
    const {rows: current} = await query(
        `SELECT id, kind, mailbox_id, email, last_line, instance_id
         FROM mail_jobs WHERE status='running' AND batch_id = ANY($1) ${kind ? "AND kind=$2" : ""}
         ORDER BY claimed_at`,
        kind ? [batchIds, kind] : [batchIds],
    );
    const lastLine = current[0]?.last_line || (by.pending || by.running ? `排队 ${by.pending} · 执行 ${by.running}` : `结束 成功 ${ok}/${done}`);
    return {
        running: by.running + by.pending > 0,
        kind: kind || "mail",
        done,
        total,
        ok,
        fail,
        queued: by.pending,
        runningCount: by.running,
        rate: done ? Math.round((ok / done) * 100) : 0,
        current: current.map((r) => ({
            id: r.mailbox_id, email: r.email, lastLine: r.last_line || "运行中",
            instanceId: r.instance_id, kind: r.kind,
        })),
        lastLine,
        batchId: batchIds.join(","),
        byKind,
        paused,
    };
}
