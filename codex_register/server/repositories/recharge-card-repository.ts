// @ts-nocheck
import {query, withTransaction} from "./database-context.js";
import {RECHARGE_CARD_REUSE_BLOCKING_REFERENCE_SQL} from "./recharge-card-reference-policy.js";

// ---- 充值卡密管理 ----

export async function importRechargeCards(codes, batch = "") {
    const normalized = [...new Set((codes || []).map((code) => String(code || "").trim()).filter(Boolean))];
    const now = Date.now();
    if (!normalized.length) return {inserted: 0, skipped: codes.length, total: codes.length};
    const {rowCount} = await query(
        `INSERT INTO recharge_cards(code,batch,created_at,updated_at)
         SELECT code, $2, $3, $3 FROM unnest($1::text[]) AS code
         ON CONFLICT(code) DO NOTHING`,
        [normalized, batch, now],
    );
    const inserted = rowCount || 0;
    return {inserted, skipped: codes.length - inserted, total: codes.length};
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

export async function getRechargeCards(ids) {
    const list = [...new Set((ids || []).map(Number).filter(Number.isInteger))];
    if (!list.length) return [];
    const {rows} = await query(
        `SELECT * FROM recharge_cards WHERE id = ANY($1::int[]) ORDER BY id`,
        [list],
    );
    return rows;
}

export async function deleteRechargeCards(ids) {
    const list = [...new Set((ids || []).map(Number).filter(Number.isInteger))];
    if (!list.length) return {count: 0, skipped: 0};
    const {rowCount} = await query(
        `DELETE FROM recharge_cards c
         WHERE c.id = ANY($1)
           AND c.status IN ('unused','error')
           AND NOT EXISTS (
               SELECT 1 FROM recharge_queue rq
               WHERE rq.card_id=c.id AND ${RECHARGE_CARD_REUSE_BLOCKING_REFERENCE_SQL}
           )`,
        [list],
    );
    const count = rowCount || 0;
    return {count, skipped: list.length - count};
}

/** 平台验卡结果只允许写回未使用/错误卡，状态变化时按 CAS 跳过。 */
export async function applyRechargeCardValidation(id, expectedStatus, result = {}) {
    const currentStatus = String(expectedStatus || "");
    if (!["unused", "error"].includes(currentStatus)) return null;
    const platformStatus = String(result.status || "");
    const nextStatus = platformStatus === "unused" ? "unused" : "error";
    const error = platformStatus === "unused" ? "" : `平台状态: ${platformStatus || "未知"}(不可使用)`;
    return withTransaction(async (client) => {
        await client.query(
            `SELECT id FROM recharge_queue WHERE card_id=$1 ORDER BY id FOR UPDATE`,
            [Number(id)],
        );
        const {rows} = await client.query(
            `UPDATE recharge_cards SET
                status=$1, plan_type=$2, plan_name=$3, product=$4, category=$5, auth_mode=$6,
                error=$7,
                account_id=CASE WHEN $1='unused' THEN 0 ELSE account_id END,
                account_email=CASE WHEN $1='unused' THEN '' ELSE account_email END,
                task_no=CASE WHEN $1='unused' THEN '' ELSE task_no END,
                task_status=CASE WHEN $1='unused' THEN '' ELSE task_status END,
                task_message=CASE WHEN $1='unused' THEN '' ELSE task_message END,
                updated_at=$8
             WHERE id=$9 AND status=$10 AND status IN ('unused','error')
               AND ($1<>'unused' OR NOT EXISTS (
                   SELECT 1 FROM recharge_queue rq
                   WHERE rq.card_id=recharge_cards.id AND ${RECHARGE_CARD_REUSE_BLOCKING_REFERENCE_SQL}
               ))
             RETURNING *`,
            [
                nextStatus,
                String(result.plan_type || ""),
                String(result.plan_name || ""),
                String(result.product || ""),
                String(result.category || ""),
                String(result.auth_mode || ""),
                error,
                Date.now(),
                Number(id),
                currentStatus,
            ],
        );
        const updated = rows[0] || null;
        if (updated && nextStatus === "unused") {
            await client.query(
                `UPDATE recharge_queue SET card_id=0
                 WHERE card_id=$1 AND status='error'`,
                [Number(id)],
            );
        }
        return updated;
    });
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

/** 失败/退回后把卡密放回未使用池，换号可再领。已充上的 (done) 不动。 */
export async function unpairRechargeCards(ids) {
    const list = [...new Set((ids || []).map(Number).filter(Number.isInteger))];
    if (!list.length) return 0;
    return withTransaction(async (client) => {
        await client.query(
            `SELECT id FROM recharge_queue WHERE card_id = ANY($1) ORDER BY id FOR UPDATE`,
            [list],
        );
        await client.query(
            `SELECT id FROM recharge_cards WHERE id = ANY($1) ORDER BY id FOR UPDATE`,
            [list],
        );
        const {rows} = await client.query(
            `UPDATE recharge_cards SET
                status='unused',
                account_id=0,
                account_email='',
                error='',
                task_no='',
                task_status='',
                task_message='',
                updated_at=$1
             WHERE id = ANY($2)
               AND status IN ('unused','paired','error')
               AND NOT EXISTS (
                   SELECT 1 FROM recharge_queue rq
                   WHERE rq.card_id=recharge_cards.id AND ${RECHARGE_CARD_REUSE_BLOCKING_REFERENCE_SQL}
               )
             RETURNING id`,
            [Date.now(), list],
        );
        const released = rows.map((row) => Number(row.id));
        if (released.length) {
            await client.query(
                `UPDATE recharge_queue SET card_id=0
                 WHERE card_id = ANY($1) AND status='error'`,
                [released],
            );
        }
        return released.length;
    });
}

export async function rechargeUnusedCount() {
    const { rows: [r] } = await query(
        `SELECT COUNT(*)::int AS n FROM recharge_cards c
         WHERE c.status='unused'
           AND NOT EXISTS (
               SELECT 1 FROM recharge_queue rq
               WHERE rq.card_id=c.id AND ${RECHARGE_CARD_REUSE_BLOCKING_REFERENCE_SQL}
           )`,
    );
    return r.n;
}

export async function pickUnusedCards(n) {
    return claimUnusedCards(n);
}

// 原子取卡:FOR UPDATE SKIP LOCKED,立刻标 paired,避免多实例抢同一张卡。数量不足则一张不取。
export async function claimUnusedCards(n, {excludeIds = []} = {}) {
    const need = Math.max(0, Number(n) || 0);
    if (!need) return [];
    const excluded = [...new Set((excludeIds || []).map(Number).filter(Number.isInteger))];
    return withTransaction(async (client) => {
        const { rows } = await client.query(
            `SELECT * FROM recharge_cards c
             WHERE c.status='unused' AND NOT (c.id = ANY($2::int[]))
               AND NOT EXISTS (
                   SELECT 1 FROM recharge_queue rq
                   WHERE rq.card_id=c.id AND ${RECHARGE_CARD_REUSE_BLOCKING_REFERENCE_SQL}
               )
             ORDER BY c.id LIMIT $1 FOR UPDATE OF c SKIP LOCKED`,
            [need, excluded]
        );
        if (rows.length < need) return [];
        const ids = rows.map((r) => r.id);
        const now = Date.now();
        await client.query(`UPDATE recharge_cards SET status='paired', updated_at=$1 WHERE id = ANY($2)`, [now, ids]);
        return rows.map((r) => ({ ...r, status: "paired", updated_at: now }));
    });
}

export async function listErrorRechargeCards() {
    const {rows} = await query(
        `SELECT id, code, status, updated_at FROM recharge_cards WHERE status='error' ORDER BY updated_at, id`,
    );
    return rows;
}
