// @ts-nocheck
// worker 子进程用的【无副作用】接码池 DAO。
// 关键：只打开同一个 SQLite、只 prepare 接码相关语句；
//   - 不建表(表由 server/db.ts 负责创建)
//   - 不执行 "UPDATE ... WHERE status='running/claimed'" 等启动副作用(避免影响并发中其它任务)
// better-sqlite3 WAL 模式允许多进程读写同一文件，busy_timeout 兜底写锁竞争。
//
// 号状态机(一号一次)：free →(claim借出)→ claimed →(提交成功)→ used
//                                              ↘(提交被拒)→ bad
//                                              ↘(提交临时失败)→ free(释放回池)
import Database from "better-sqlite3";
import path from "node:path";
import {fileURLToPath} from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// src/sms/pool-db.ts → ../../data/register.db == codex_register/data/register.db(与 server/db.ts 同一文件)
const DB_PATH = process.env.REG_DB_PATH || path.resolve(__dirname, "..", "..", "data", "register.db");

let db = null;
function conn() {
    if (!db) {
        db = new Database(DB_PATH);
        db.pragma("journal_mode = WAL");
        db.pragma("busy_timeout = 15000"); // 等主进程写锁释放，避免 SQLITE_BUSY
    }
    return db;
}

/**
 * 原子借出一个可用号 → 标 claimed(防并发重复取，非消耗)，绑定邮箱，返回该行(无则 null)。
 * maxBind=每号绑定上限(0=不限)。取 free 或 (used 且 bind_count<max)，优先复用在用号(把一个号绑满再换)。
 */
export function claimSms(email, maxBind = 0) {
    const d = conn();
    const lim = maxBind && maxBind > 0 ? maxBind : 999999;
    const tx = d.transaction((e, l) => {
        const row = d.prepare(`SELECT * FROM sms_pool WHERE status='free' OR (status='used' AND bind_count < ?) ORDER BY (status='used') DESC, id LIMIT 1`).get(l);
        if (!row) return null;
        d.prepare(`UPDATE sms_pool SET status='claimed', bound_email=? WHERE id=?`).run(e || "", row.id);
        return row;
    });
    // IMMEDIATE:开头即拿写锁,避免 SELECT→UPDATE 锁升级在并发写时立即 SQLITE_BUSY(busy_timeout 对锁升级不生效)
    return tx.immediate(email, lim);
}

/**
 * 复用绑定号：按手机号定向取号(不论当前状态)，标 claimed。
 * 用于 rt 过期后在【同一个已绑定的号】上重新收码(该号 OpenAI 侧已验证过)。无此号返回 null。
 */
export function claimSmsByPhone(phone, email) {
    const d = conn();
    const tx = d.transaction((p, e) => {
        const row = d.prepare(`SELECT * FROM sms_pool WHERE phone=? LIMIT 1`).get(p);
        if (!row) return null;
        d.prepare(`UPDATE sms_pool SET status='claimed', bound_email=? WHERE id=?`).run(e || "", row.id);
        return row;
    });
    return tx.immediate(String(phone || "").replace(/[^\d]/g, ""), email);
}

/** 提交手机号成功 = 一次绑定：claimed → used，bind_count+1、追加 bind_emails(未达上限仍可再被 claim 复用) */
export function markSmsUsed(id, email) {
    conn().prepare(`UPDATE sms_pool SET status='used', bound_email=?, bind_count=bind_count+1, bind_emails=(CASE WHEN COALESCE(bind_emails,'')='' THEN ? ELSE bind_emails||','||? END) WHERE id=?`).run(email || "", email || "", email || "", id);
}

/** 号被 OpenAI 拒/坏号：claimed → bad(不回 free，claimSms 不会再取到) */
export function markSmsBad(id, email) {
    conn().prepare(`UPDATE sms_pool SET status='bad', bound_email=? WHERE id=?`).run(email || "", id);
}

/** 提交临时失败(号未消耗)：claimed → free，释放回池可重用 */
export function releaseSms(id) {
    conn().prepare(`UPDATE sms_pool SET status='free', bound_email='' WHERE id=?`).run(id);
}

/**
 * 临时失败时【恢复号的原始状态】(而非无脑置 free)，不降级也不复活、不动 bind_count/bind_emails：
 *   - bad→bad(坏号复用失败后仍是坏号，绝不复活混回可用池)
 *   - used→used(复用的在用号保留绑定计数与状态)
 *   - free→free(并清 bound_email，同 releaseSms 语义)
 * 用于 claimSmsByPhone 复用绑定号 / 一号多绑复用 used 号 的失败回滚。
 */
export function restoreSms(id, status) {
    const st = ["free", "used", "bad"].includes(status) ? status : "free";
    if (st === "free") conn().prepare(`UPDATE sms_pool SET status='free', bound_email='' WHERE id=?`).run(id);
    else conn().prepare(`UPDATE sms_pool SET status=? WHERE id=?`).run(st, id);
}
