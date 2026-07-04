// @ts-nocheck
// SQLite 持久化(架构 v2:职责归一化)
//   mailboxes     — 邮箱资源池(共享,含 usage 归属:free/gpt/claude ★隔离核心)
//   gpt_accounts  — GPT 业务账号(1:1 引用 mailbox)
//   claude_accounts — Claude 业务账号(占位,字段待注册机制确定)
//   logs / sms_pool — 日志 / 接码池(不变)
//   accounts      — 旧单表,迁移源 + 只读兜底(迁移后不再写)
// 兼容策略:listAccounts()/getAccount() 等导出函数用 JOIN(gpt_accounts+mailboxes)拼回原
//   accounts 形状,gpt_accounts.id 沿用原 accounts.id,故 server/scheduler/前端零改动。
import Database from "better-sqlite3";
import {mkdirSync} from "node:fs";
import path from "node:path";
import {fileURLToPath} from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = process.env.REG_DB_PATH || path.resolve(__dirname, "..", "data", "register.db");
mkdirSync(path.dirname(DB_PATH), {recursive: true});

const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");
db.pragma("busy_timeout = 15000"); // 写锁竞争时等待而非立即报错(与 worker 子进程的 pool-db 对称,防 "database is locked")
db.exec(`
CREATE TABLE IF NOT EXISTS accounts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT UNIQUE NOT NULL,
  password TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',   -- pending/running/success/failed
  plan TEXT DEFAULT '',
  token TEXT DEFAULT '',
  auth_file TEXT DEFAULT '',
  error TEXT DEFAULT '',
  started_at INTEGER,
  finished_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id INTEGER NOT NULL,
  ts INTEGER NOT NULL,
  line TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_logs_account ON logs(account_id, id);
CREATE INDEX IF NOT EXISTS idx_accounts_status ON accounts(status);
CREATE TABLE IF NOT EXISTS sms_pool (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  phone TEXT UNIQUE NOT NULL,          -- 卡密(手机号)
  link TEXT NOT NULL,                  -- 接码链接(仅内部用，不导出)
  status TEXT NOT NULL DEFAULT 'free', -- free/used
  bound_email TEXT DEFAULT '',         -- 绑定的账号邮箱
  created_at INTEGER NOT NULL
);
`);
// ---- 旧 accounts 增量列(迁移源需完整读取,保留所有历史 ALTER;幂等) ----
try { db.exec(`ALTER TABLE accounts ADD COLUMN phone TEXT DEFAULT ''`); } catch { /* 列已存在 */ }
try { db.exec(`ALTER TABLE sms_pool ADD COLUMN card TEXT DEFAULT ''`); } catch { /* 列已存在 */ }
try { db.exec(`ALTER TABLE accounts ADD COLUMN card TEXT DEFAULT ''`); } catch { /* 列已存在 */ }
try { db.exec(`ALTER TABLE sms_pool ADD COLUMN bind_count INTEGER DEFAULT 0`); } catch { /* 列已存在 */ }
try { db.exec(`ALTER TABLE sms_pool ADD COLUMN bind_emails TEXT DEFAULT ''`); } catch { /* 列已存在 */ }
try { db.exec(`ALTER TABLE accounts ADD COLUMN at_status TEXT DEFAULT ''`); } catch { /* 列已存在 */ }
try { db.exec(`ALTER TABLE accounts ADD COLUMN rt_status TEXT DEFAULT ''`); } catch { /* 列已存在 */ }
try { db.exec(`ALTER TABLE accounts ADD COLUMN chat_status TEXT DEFAULT ''`); } catch { /* 列已存在 */ }
try { db.exec(`ALTER TABLE accounts ADD COLUMN rt_file TEXT DEFAULT ''`); } catch { /* 列已存在 */ }
try { db.exec(`ALTER TABLE accounts ADD COLUMN dead_at INTEGER DEFAULT 0`); } catch { /* 列已存在 */ }
try { db.exec(`ALTER TABLE accounts ADD COLUMN sold_at INTEGER DEFAULT 0`); } catch { /* 列已存在 */ }
try { db.exec(`ALTER TABLE accounts ADD COLUMN pw_status TEXT DEFAULT ''`); } catch { /* 列已存在 */ }
try { db.exec(`ALTER TABLE accounts ADD COLUMN batch TEXT DEFAULT ''`); } catch { /* 列已存在 */ }

// ---- 架构 v2 新表:邮箱资源池 + 业务账号 ----
db.exec(`
CREATE TABLE IF NOT EXISTS mailboxes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT UNIQUE NOT NULL,
  password TEXT NOT NULL,                     -- 邮箱登录密码(改密后更新)
  provider TEXT NOT NULL DEFAULT 'mailcom',
  usage TEXT NOT NULL DEFAULT 'free',         -- 'free' | 'gpt' | 'claude' ★隔离核心
  grp TEXT DEFAULT '',                        -- 分组/批次(邮箱层面)
  pw_status TEXT DEFAULT '',                  -- 邮箱改密状态
  note TEXT DEFAULT '',
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_mailboxes_usage ON mailboxes(usage);
CREATE TABLE IF NOT EXISTS gpt_accounts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  mailbox_id INTEGER NOT NULL UNIQUE REFERENCES mailboxes(id),
  status TEXT NOT NULL DEFAULT 'pending',     -- pending/running/success/failed
  token TEXT DEFAULT '',                      -- access_token(网页 at)
  auth_file TEXT DEFAULT '',                  -- 网页 session auth 文件路径
  rt_file TEXT DEFAULT '',                    -- codex rt 文件路径
  plan TEXT DEFAULT '',
  phone TEXT DEFAULT '',
  card TEXT DEFAULT '',
  engine TEXT DEFAULT '',                     -- http/browser/bit
  batch TEXT DEFAULT '',
  at_status TEXT DEFAULT '',
  rt_status TEXT DEFAULT '',
  chat_status TEXT DEFAULT '',
  error TEXT DEFAULT '',
  dead_at INTEGER DEFAULT 0,
  sold_at INTEGER DEFAULT 0,
  started_at INTEGER,
  finished_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_gpt_status ON gpt_accounts(status);
CREATE INDEX IF NOT EXISTS idx_gpt_mailbox ON gpt_accounts(mailbox_id);
CREATE TABLE IF NOT EXISTS claude_accounts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  mailbox_id INTEGER NOT NULL UNIQUE REFERENCES mailboxes(id),
  status TEXT NOT NULL DEFAULT 'pending',
  -- Claude/Anthropic 特有凭证(session key / oauth / org id ...)待注册机制确定后补全
  session_key TEXT DEFAULT '',
  org_id TEXT DEFAULT '',
  plan TEXT DEFAULT '',
  engine TEXT DEFAULT '',
  batch TEXT DEFAULT '',
  error TEXT DEFAULT '',
  dead_at INTEGER DEFAULT 0,
  sold_at INTEGER DEFAULT 0,
  started_at INTEGER,
  finished_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_claude_status ON claude_accounts(status);
`);

// ---- 一次性迁移:accounts → mailboxes + gpt_accounts(仅当 gpt_accounts 为空且旧表有数据) ----
// id 对齐:mailboxes.id = gpt_accounts.id = 原 accounts.id(mailbox_id=id),前端/日志/API 引用不破。
{
    const migrated = db.prepare(`SELECT COUNT(*) n FROM gpt_accounts`).get().n;
    const legacy = db.prepare(`SELECT COUNT(*) n FROM accounts`).get().n;
    if (migrated === 0 && legacy > 0) {
        const tx = db.transaction(() => {
            db.exec(`
              INSERT INTO mailboxes(id, email, password, provider, usage, grp, pw_status, created_at)
              SELECT id, email, password, 'mailcom', 'gpt', COALESCE(batch,''), COALESCE(pw_status,''), created_at
              FROM accounts;
              INSERT INTO gpt_accounts(id, mailbox_id, status, token, auth_file, rt_file, plan, phone, card,
                                       batch, at_status, rt_status, chat_status, error, dead_at, sold_at,
                                       started_at, finished_at, created_at)
              SELECT id, id, status, COALESCE(token,''), COALESCE(auth_file,''), COALESCE(rt_file,''),
                     COALESCE(plan,''), COALESCE(phone,''), COALESCE(card,''), COALESCE(batch,''),
                     COALESCE(at_status,''), COALESCE(rt_status,''), COALESCE(chat_status,''),
                     COALESCE(error,''), COALESCE(dead_at,0), COALESCE(sold_at,0),
                     started_at, finished_at, created_at
              FROM accounts;
            `);
        });
        tx.immediate();
        console.log(`[db] 迁移完成 accounts → mailboxes + gpt_accounts: ${legacy} 行`);
    }
}

// 启动时把上次异常中断、卡在 running 的任务重置为 pending(可重跑)
db.prepare(`UPDATE gpt_accounts SET status='pending' WHERE status='running'`).run();
// 卡在 claimed(借出未完成，worker 崩溃遗留)的接码号回收为 free
db.prepare(`UPDATE sms_pool SET status='free', bound_email='' WHERE status='claimed'`).run();

// 兼容 JOIN:把 gpt_accounts + mailboxes 拼回原 accounts 形状(字段名/顺序一致,上层无感)。
const ACC_COLS = `
  g.id AS id, m.email AS email, m.password AS password, g.status AS status,
  g.plan AS plan, g.token AS token, g.auth_file AS auth_file, g.error AS error,
  g.started_at AS started_at, g.finished_at AS finished_at, g.created_at AS created_at,
  g.phone AS phone, g.card AS card, g.at_status AS at_status, g.rt_status AS rt_status,
  g.chat_status AS chat_status, g.rt_file AS rt_file, g.dead_at AS dead_at, g.sold_at AS sold_at,
  m.pw_status AS pw_status, g.batch AS batch, g.mailbox_id AS mailbox_id`;
const ACC_FROM = `FROM gpt_accounts g JOIN mailboxes m ON g.mailbox_id = m.id`;

const stmt = {
    // -- 导入:新建 mailbox(usage=gpt) + gpt_account --
    insMailbox: db.prepare(`INSERT OR IGNORE INTO mailboxes(email,password,provider,usage,grp,created_at) VALUES(?,?,'mailcom','gpt',?,?)`),
    insGpt: db.prepare(`INSERT INTO gpt_accounts(mailbox_id,status,batch,created_at) VALUES(?, 'pending', ?, ?)`),
    // -- 兼容读取(拼回 accounts 形状) --
    list: db.prepare(`SELECT ${ACC_COLS} ${ACC_FROM} ORDER BY g.id`),
    listByStatus: db.prepare(`SELECT ${ACC_COLS} ${ACC_FROM} WHERE g.status=? ORDER BY g.id`),
    get: db.prepare(`SELECT ${ACC_COLS} ${ACC_FROM} WHERE g.id=?`),
    claim: db.prepare(`SELECT ${ACC_COLS} ${ACC_FROM} WHERE g.status='pending' ORDER BY g.id LIMIT 1`),
    // -- 业务字段写 gpt_accounts --
    setRunning: db.prepare(`UPDATE gpt_accounts SET status='running', started_at=?, error='' WHERE id=?`),
    setSuccess: db.prepare(`UPDATE gpt_accounts SET status='success', token=?, auth_file=?, plan=?, finished_at=?, error='' WHERE id=?`),
    setFailed: db.prepare(`UPDATE gpt_accounts SET status='failed', error=?, finished_at=? WHERE id=?`),
    resetOne: db.prepare(`UPDATE gpt_accounts SET status='pending', error='', started_at=NULL, finished_at=NULL WHERE id=?`),
    resetFailed: db.prepare(`UPDATE gpt_accounts SET status='pending', error='', started_at=NULL, finished_at=NULL WHERE status='failed' AND error NOT LIKE '%account_deactivated%'`),
    deleteGpt: db.prepare(`DELETE FROM gpt_accounts WHERE id=?`),
    setPhone: db.prepare(`UPDATE gpt_accounts SET phone=? WHERE id=?`),
    setCard: db.prepare(`UPDATE gpt_accounts SET card=? WHERE id=?`),
    setRtFile: db.prepare(`UPDATE gpt_accounts SET rt_file=? WHERE id=?`),
    setDeadAt: db.prepare(`UPDATE gpt_accounts SET dead_at=? WHERE id=?`),
    setSoldAt: db.prepare(`UPDATE gpt_accounts SET sold_at=? WHERE id=?`),
    setAtStatus: db.prepare(`UPDATE gpt_accounts SET at_status=? WHERE id=?`),
    setRtStatus: db.prepare(`UPDATE gpt_accounts SET rt_status=? WHERE id=?`),
    setChatStatus: db.prepare(`UPDATE gpt_accounts SET chat_status=? WHERE id=?`),
    // -- 邮箱字段写 mailboxes(经 gpt_accounts.mailbox_id 定位) --
    setPassword: db.prepare(`UPDATE mailboxes SET password=? WHERE id=(SELECT mailbox_id FROM gpt_accounts WHERE id=?)`),
    setPwStatus: db.prepare(`UPDATE mailboxes SET pw_status=? WHERE id=(SELECT mailbox_id FROM gpt_accounts WHERE id=?)`),
    // -- 日志 --
    addLog: db.prepare(`INSERT INTO logs(account_id,ts,line) VALUES(?,?,?)`),
    listLogs: db.prepare(`SELECT id,ts,line FROM logs WHERE account_id=? ORDER BY id`),
    clearLogs: db.prepare(`DELETE FROM logs WHERE account_id=?`),
    stats: db.prepare(`SELECT status, COUNT(*) n FROM gpt_accounts GROUP BY status`),
    // -- 接码池(不变) --
    smsInsert: db.prepare(`INSERT OR IGNORE INTO sms_pool(card,phone,link,status,created_at) VALUES(?,?,?,'free',?)`),
    smsList: db.prepare(`SELECT * FROM sms_pool ORDER BY id`),
    smsClaim: db.prepare(`SELECT * FROM sms_pool WHERE status='free' OR (status='used' AND bind_count < ?) ORDER BY (status='used') DESC, id LIMIT 1`),
    smsMarkClaimed: db.prepare(`UPDATE sms_pool SET status='claimed', bound_email=? WHERE id=?`),
    smsMarkUsed: db.prepare(`UPDATE sms_pool SET status='used', bound_email=?, bind_count=bind_count+1, bind_emails=(CASE WHEN COALESCE(bind_emails,'')='' THEN ? ELSE bind_emails||','||? END) WHERE id=?`),
    smsMarkBad: db.prepare(`UPDATE sms_pool SET status='bad', bound_email=? WHERE id=?`),
    smsRelease: db.prepare(`UPDATE sms_pool SET status='free', bound_email='' WHERE id=?`),
    smsDelete: db.prepare(`DELETE FROM sms_pool WHERE id=?`),
    smsStats: db.prepare(`SELECT status, COUNT(*) n FROM sms_pool GROUP BY status`),
};

// 导入:每行建一个 gpt 归属的 mailbox + 一个 gpt_account。email 已存在则跳过(不新建业务号)。
export function importAccounts(rows, batch = "") {
    const now = Date.now();
    let inserted = 0;
    const grp = String(batch || "");
    const tx = db.transaction((items) => {
        for (const r of items) {
            const email = r.email.toLowerCase();
            const res = stmt.insMailbox.run(email, r.password, grp, now);
            if (!res.changes) continue; // 邮箱已存在(已被某业务占用),跳过
            stmt.insGpt.run(res.lastInsertRowid, grp, now);
            inserted++;
        }
    });
    tx.immediate(rows);
    return {inserted, skipped: rows.length - inserted, total: rows.length};
}

export const listAccounts = (status) => (status ? stmt.listByStatus.all(status) : stmt.list.all());
export const getAccount = (id) => stmt.get.get(id);

/** 原子认领下一个 pending → running，返回该行(无则 null)。IMMEDIATE 避免 SELECT→UPDATE 锁升级并发时 SQLITE_BUSY */
const _claimNext = db.transaction(() => {
    const row = stmt.claim.get();
    if (!row) return null;
    stmt.setRunning.run(Date.now(), row.id);
    return {...row, status: "running"};
});
export const claimNext = () => _claimNext.immediate();

export const markSuccess = (id, {token, authFile, plan}) =>
    stmt.setSuccess.run(token || "", authFile || "", plan || "", Date.now(), id);
export const markFailed = (id, error) => stmt.setFailed.run(String(error || "").slice(0, 2000), Date.now(), id);
export const resetToPending = (id) => { stmt.clearLogs.run(id); return stmt.resetOne.run(id); };
export const resetAllFailed = () => stmt.resetFailed.run();
// 删除:业务号 + 其占用的邮箱 + 日志(P1 策略:删号连带删邮箱;邮箱回收策略见 D3,后续域化再议)
const _deleteAccount = db.transaction((id) => {
    const row = db.prepare(`SELECT mailbox_id FROM gpt_accounts WHERE id=?`).get(id);
    stmt.clearLogs.run(id);
    const res = stmt.deleteGpt.run(id);
    if (row) db.prepare(`DELETE FROM mailboxes WHERE id=?`).run(row.mailbox_id);
    return res;
});
export const deleteAccount = (id) => _deleteAccount.immediate(id);
export const updatePassword = (id, password) => stmt.setPassword.run(password, id);

// 编辑账号记录:白名单字段动态更新(改本地库,不触发真邮箱改密)。
// 字段分流:email/password/pw_status → mailboxes;其余 → gpt_accounts。
const MAILBOX_FIELDS = ["email", "password", "pw_status"];
const GPT_FIELDS = ["status", "plan", "phone", "card", "at_status", "rt_status", "chat_status", "error", "dead_at", "sold_at", "finished_at", "batch", "auth_file", "token", "rt_file", "engine"];
export const updateAccount = (id, fields) => {
    const f = fields || {};
    const mKeys = Object.keys(f).filter((k) => MAILBOX_FIELDS.includes(k));
    const gKeys = Object.keys(f).filter((k) => GPT_FIELDS.includes(k));
    if (!mKeys.length && !gKeys.length) return {changes: 0};
    let changes = 0;
    const tx = db.transaction(() => {
        if (gKeys.length) {
            const set = gKeys.map((k) => `${k}=?`).join(", ");
            changes += db.prepare(`UPDATE gpt_accounts SET ${set} WHERE id=?`).run(...gKeys.map((k) => f[k]), id).changes;
        }
        if (mKeys.length) {
            const set = mKeys.map((k) => `${k}=?`).join(", ");
            changes += db.prepare(`UPDATE mailboxes SET ${set} WHERE id=(SELECT mailbox_id FROM gpt_accounts WHERE id=?)`).run(...mKeys.map((k) => f[k]), id).changes;
        }
    });
    tx.immediate();
    return {changes};
};

export const appendLog = (id, line) => stmt.addLog.run(id, Date.now(), line);
export const listLogs = (id) => stmt.listLogs.all(id);

export function stats() {
    const out = {pending: 0, running: 0, success: 0, failed: 0, total: 0};
    for (const row of stmt.stats.all()) {
        out[row.status] = row.n;
        out.total += row.n;
    }
    return out;
}

export const setAccountPhone = (id, phone) => stmt.setPhone.run(phone || "", id);
export const setAccountCard = (id, card) => stmt.setCard.run(card || "", id);
// 回写含 rt 的 codex auth 文件路径(注册后取 rt / 按需获取 rt 均调用)
export const setAccountRtFile = (id, rtFile) => stmt.setRtFile.run(rtFile || "", id);
// 保活综合判定死活:at+rt 都失效→setDeadAt(now)定格;有一个活→setDeadAt(0)清除(复活)
export const setDeadAt = (id, ts) => stmt.setDeadAt.run(ts || 0, id);
// 批量标记已售出(导出时用)，返回标记数
export const markSold = (ids) => {
    const now = Date.now();
    const tx = db.transaction((arr) => { for (const id of arr) stmt.setSoldAt.run(now, id); });
    tx.immediate(ids || []);
    return (ids || []).length;
};
// token 测试状态写入(kind: 'at'|'rt'|'chat')
export const setTestStatus = (id, kind, status) => {
    const s = String(status || "");
    if (kind === "at") stmt.setAtStatus.run(s, id);
    else if (kind === "rt") stmt.setRtStatus.run(s, id);
    else if (kind === "chat") stmt.setChatStatus.run(s, id);
};
export const setPwStatus = (id, status) => stmt.setPwStatus.run(String(status || ""), id);

// ---- 接码池(phone=卡密手机号 + link=接码链接) ----
export function importSms(rows) {
    const now = Date.now();
    let inserted = 0;
    const tx = db.transaction((items) => {
        for (const r of items) inserted += stmt.smsInsert.run(r.card || "", r.phone, r.link, now).changes;
    });
    tx(rows);
    return {inserted, skipped: rows.length - inserted, total: rows.length};
}
export const listSms = () => stmt.smsList.all();
export const deleteSms = (id) => stmt.smsDelete.run(id);
export const releaseSms = (id) => stmt.smsRelease.run(id);
/** 收码失败的坏号：标 bad(不回 free，claimSms 不会再取到) */
export const markSmsBad = (id, email) => stmt.smsMarkBad.run(email || "", id);
export const markSmsUsed = (id, email) => stmt.smsMarkUsed.run(email || "", email || "", email || "", id);
/** 原子取一个可用接码号(free 或 used未满) → 标 claimed，返回该行(无则 null)。maxBind=每号绑定上限(0=不限) */
export const claimSms = db.transaction((email, maxBind = 0) => {
    const lim = maxBind && maxBind > 0 ? maxBind : 999999;
    const row = stmt.smsClaim.get(lim);
    if (!row) return null;
    stmt.smsMarkClaimed.run(email || "", row.id); // 借出(claimed)，非消耗;提交成功后才由 markSmsUsed 标 used
    return row;
});
export function smsStats() {
    const out = {free: 0, used: 0, bad: 0, claimed: 0, total: 0};
    for (const row of stmt.smsStats.all()) { out[row.status] = row.n; out.total += row.n; }
    return out;
}

// ---- 领域 API(P2+ 使用,当前兼容层之外的新入口) ----
// 邮箱资源池:按 usage 过滤(不传=全部)。前端"邮箱管理"模块用。
const _mbList = db.prepare(`SELECT * FROM mailboxes ORDER BY id`);
const _mbListByUsage = db.prepare(`SELECT * FROM mailboxes WHERE usage=? ORDER BY id`);
export const listMailboxes = (usage) => (usage ? _mbListByUsage.all(usage) : _mbList.all());
export const mailboxStats = () => {
    const out = {free: 0, gpt: 0, claude: 0, total: 0};
    for (const row of db.prepare(`SELECT usage, COUNT(*) n FROM mailboxes GROUP BY usage`).all()) {
        out[row.usage] = row.n; out.total += row.n;
    }
    return out;
};

// ---- Claude 域(占位):JOIN mailboxes 拼回 email/password,与 GPT 兼容层同构。凭证字段随注册机制定稿再扩。 ----
const _claudeList = db.prepare(`
    SELECT c.id, c.mailbox_id, c.status, c.session_key, c.org_id, c.plan, c.engine,
           c.batch, c.error, c.dead_at, c.sold_at, c.started_at, c.finished_at, c.created_at,
           m.email, m.password, m.provider, m.pw_status, m.grp
    FROM claude_accounts c JOIN mailboxes m ON c.mailbox_id = m.id ORDER BY c.id`);
export const listClaudeAccounts = () => _claudeList.all();
export const claudeStats = () => {
    const out = {pending: 0, running: 0, success: 0, failed: 0, total: 0};
    for (const row of db.prepare(`SELECT status, COUNT(*) n FROM claude_accounts GROUP BY status`).all()) {
        out[row.status] = row.n; out.total += row.n;
    }
    return out;
};
/** CAS 原子分配:把一个 free 邮箱锁给某业务(usage)。返回被锁定的 mailbox(无则 null)。★隔离核心 */
const _allocOne = db.prepare(`UPDATE mailboxes SET usage=? WHERE id=? AND usage='free'`);
const _freePick = db.prepare(`SELECT * FROM mailboxes WHERE usage='free' ORDER BY id LIMIT 1`);
export const allocateMailbox = db.transaction((usage) => {
    for (let i = 0; i < 50; i++) {
        const mb = _freePick.get();
        if (!mb) return null;
        if (_allocOne.run(usage, mb.id).changes) return {...mb, usage};
        // 被并发抢走,取下一个
    }
    return null;
});

// 单个邮箱查询(邮箱管理域用)
export const getMailbox = (id) => db.prepare(`SELECT * FROM mailboxes WHERE id=?`).get(id);

/** 导入 free 邮箱到资源池(纯管理,不进任何业务队列)。email 已存在则跳过。 */
export function importFreeMailboxes(rows, grp = "") {
    const now = Date.now();
    let inserted = 0;
    const g = String(grp || "");
    const ins = db.prepare(`INSERT OR IGNORE INTO mailboxes(email,password,provider,usage,grp,created_at) VALUES(?,?,'mailcom','free',?,?)`);
    const tx = db.transaction((items) => {
        for (const r of items) inserted += ins.run(r.email.toLowerCase(), r.password, g, now).changes;
    });
    tx.immediate(rows);
    return {inserted, skipped: rows.length - inserted, total: rows.length};
}

/**
 * 从 free 池分配 count 个邮箱给业务域(gpt/claude):CAS 锁定 usage + 建对应 pending 业务号。★隔离核心
 * 返回 {allocated}。gpt→建 gpt_accounts;claude→建 claude_accounts。
 */
const _mbPickFree = db.prepare(`SELECT id, grp FROM mailboxes WHERE usage='free' ORDER BY id LIMIT 1`);
// 限定来源分组:只从某个 grp 的 free 邮箱里取(避免把不想分配的独立邮箱误分走)。grp='' 即"无分组"桶。
const _mbPickFreeInGrp = db.prepare(`SELECT id, grp FROM mailboxes WHERE usage='free' AND grp=? ORDER BY id LIMIT 1`);
const _mbLockTo = db.prepare(`UPDATE mailboxes SET usage=? WHERE id=? AND usage='free'`);
const _insGptAlloc = db.prepare(`INSERT INTO gpt_accounts(mailbox_id,status,batch,created_at) VALUES(?, 'pending', ?, ?)`);
const _insClaudeAlloc = db.prepare(`INSERT INTO claude_accounts(mailbox_id,status,batch,created_at) VALUES(?, 'pending', ?, ?)`);
// sourceGrp:undefined/null=全 free 池(向后兼容);字符串(含 '')=只从该分组取。batch=业务号批次标签(与来源分组解耦)。
const _allocMany = db.transaction((usage, count, batch, sourceGrp) => {
    const now = Date.now();
    let allocated = 0;
    const pick = () => (sourceGrp == null ? _mbPickFree.get() : _mbPickFreeInGrp.get(sourceGrp));
    for (let i = 0; i < count; i++) {
        const mb = pick();
        if (!mb) break;
        if (!_mbLockTo.run(usage, mb.id).changes) break; // 单事务内不会并发抢
        const b = String(batch || mb.grp || "");
        if (usage === "gpt") _insGptAlloc.run(mb.id, b, now);
        else _insClaudeAlloc.run(mb.id, b, now);
        allocated++;
    }
    return allocated;
});
export const allocateMailboxesTo = (usage, count, batch = "", sourceGrp = undefined) => {
    if (usage !== "gpt" && usage !== "claude") return {allocated: 0, error: "usage 必须是 gpt 或 claude"};
    const n = Math.max(0, Number(count) || 0);
    if (!n) return {allocated: 0};
    return {allocated: _allocMany.immediate(usage, n, batch, sourceGrp)};
};

/** 独立(free)邮箱的分组分布:[{grp, n}],供前端"按分组分配"下拉。grp='' 即无分组。 */
export const freeMailboxGroups = () =>
    db.prepare(`SELECT grp, COUNT(*) n FROM mailboxes WHERE usage='free' GROUP BY grp ORDER BY grp`).all();

/** 删除邮箱:仅当未被任何业务占用(无 gpt/claude 业务号)时允许;否则拒绝(应从对应业务域删除)。 */
const _delMailbox = db.transaction((id) => {
    const g = db.prepare(`SELECT id FROM gpt_accounts WHERE mailbox_id=?`).get(id);
    const c = db.prepare(`SELECT id FROM claude_accounts WHERE mailbox_id=?`).get(id);
    if (g || c) return {ok: false, reason: "该邮箱已被业务占用,请从对应业务域删除"};
    const res = db.prepare(`DELETE FROM mailboxes WHERE id=?`).run(id);
    return {ok: res.changes > 0};
});
export const deleteMailbox = (id) => _delMailbox.immediate(id);

/** 改密后同步邮箱库:更新密码 + 改密状态。 */
export const setMailboxPassword = (id, password, pwStatus) =>
    db.prepare(`UPDATE mailboxes SET password=?, pw_status=? WHERE id=?`).run(password, pwStatus ?? "", id);

export const dbPath = DB_PATH; // 供 worker 子进程连同一个 SQLite 文件
export default db;
