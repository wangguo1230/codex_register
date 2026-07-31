// @ts-nocheck
// worker 子进程用的【无副作用】接码池 DAO（PostgreSQL 版）。
// 关键：只走共享 PG 连接池、只执行接码相关语句；
//   - 不建表(表由 server/pg-schema.ts 负责创建)
//   - 不执行 "UPDATE ... WHERE status='running/claimed'" 等启动副作用(避免影响并发中其它任务)
// 所有函数均为 async，调用方需 await。PG 用 FOR UPDATE SKIP LOCKED 做并发取号保护(替代原 SQLite IMMEDIATE 事务)。
//
// 号状态机(一号一次)：free →(claim借出)→ claimed →(提交成功)→ used
//                                              ↘(提交被拒)→ bad
//                                              ↘(提交临时失败)→ free(释放回池)
import {pool, withTransaction} from "../../server/pg.js";

/**
 * 原子借出一个可用号 → 标 claimed(防并发重复取，非消耗)，绑定邮箱，返回该行(无则 null)。
 * maxBind=每号绑定上限(0=不限)。取 free 或 (used 且 bind_count<max)，优先复用在用号(把一个号绑满再换)。
 */
export async function claimSms(email, maxBind = 0) {
    const lim = maxBind && maxBind > 0 ? maxBind : 999999;
    return withTransaction(async (client) => {
        const {rows: [row]} = await client.query(
            `SELECT * FROM sms_pool
             WHERE status='free' OR (status='used' AND bind_count < $1)
             ORDER BY CASE WHEN status='used' THEN 1 ELSE 0 END DESC, id
             LIMIT 1 FOR UPDATE SKIP LOCKED`,
            [lim]
        );
        if (!row) return null;
        await client.query(`UPDATE sms_pool SET status='claimed', bound_email=$1 WHERE id=$2`, [email || "", row.id]);
        return row;
    });
}

/**
 * 复用绑定号：按手机号定向取号(不论当前状态)，标 claimed。
 * 用于 rt 过期后在【同一个已绑定的号】上重新收码(该号 OpenAI 侧已验证过)。无此号返回 null。
 */
export async function claimSmsByPhone(phone, email) {
    const p = String(phone || "").replace(/[^\d]/g, "");
    return withTransaction(async (client) => {
        const {rows: [row]} = await client.query(`SELECT * FROM sms_pool WHERE phone=$1 LIMIT 1 FOR UPDATE SKIP LOCKED`, [p]);
        if (!row) return null;
        await client.query(`UPDATE sms_pool SET status='claimed', bound_email=$1 WHERE id=$2`, [email || "", row.id]);
        return row;
    });
}

/** 提交手机号成功 = 一次绑定：claimed → used，bind_count+1、追加 bind_emails(未达上限仍可再被 claim 复用) */
export async function markSmsUsed(id, email) {
    const e = email || "";
    await pool.query(
        `UPDATE sms_pool
         SET status='used', bound_email=$1, bind_count=bind_count+1,
             bind_emails=(CASE WHEN COALESCE(bind_emails,'')='' THEN $1 ELSE bind_emails||','||$1 END)
         WHERE id=$2`,
        [e, id]
    );
}

/** 号被 OpenAI 拒/坏号：claimed → bad(不回 free，claimSms 不会再取到) */
export async function markSmsBad(id, email) {
    await pool.query(`UPDATE sms_pool SET status='bad', bound_email=$1 WHERE id=$2`, [email || "", id]);
}

/** 提交临时失败(号未消耗)：claimed → free，释放回池可重用 */
export async function releaseSms(id) {
    await pool.query(`UPDATE sms_pool SET status='free', bound_email='' WHERE id=$1`, [id]);
}

/**
 * 临时失败时【恢复号的原始状态】(而非无脑置 free)，不降级也不复活、不动 bind_count/bind_emails：
 *   - bad→bad(坏号复用失败后仍是坏号，绝不复活混回可用池)
 *   - used→used(复用的在用号保留绑定计数与状态)
 *   - free→free(并清 bound_email，同 releaseSms 语义)
 * 用于 claimSmsByPhone 复用绑定号 / 一号多绑复用 used 号 的失败回滚。
 */
export async function restoreSms(id, status) {
    const st = ["free", "used", "bad"].includes(status) ? status : "free";
    if (st === "free") await pool.query(`UPDATE sms_pool SET status='free', bound_email='' WHERE id=$1`, [id]);
    else await pool.query(`UPDATE sms_pool SET status=$1 WHERE id=$2`, [st, id]);
}
