// @ts-nocheck
import {ACC_COLS_FULL, ACC_FROM, query, withTransaction} from "./database-context.js";
import {canSafelyReleaseQueueCard} from "../domain/recharge-card-release-policy.js";
import {RECHARGE_CARD_REUSE_BLOCKING_REFERENCE_SQL} from "./recharge-card-reference-policy.js";

export {canSafelyReleaseQueueCard};

function queueIds(values) {
    return [...new Set((values || []).map(Number).filter(Number.isInteger))].sort((a, b) => a - b);
}

async function releaseQueueCard(client, item, card, now) {
    if (!card || !canSafelyReleaseQueueCard(item, card)) return false;
    const {rowCount} = await client.query(
        `UPDATE recharge_cards SET
            status='unused', account_id=0, account_email='', error='',
            task_no='', task_status='', task_message='', updated_at=$1
         WHERE id=$2 AND status IN ('paired','unused')
           AND COALESCE(task_no,'')='' AND COALESCE(task_status,'')=''
               AND NOT EXISTS (
                   SELECT 1 FROM recharge_queue rq
                   WHERE rq.card_id=recharge_cards.id AND rq.id<>$3
                     AND ${RECHARGE_CARD_REUSE_BLOCKING_REFERENCE_SQL}
               )`,
        [now, Number(card.id), Number(item.id)],
    );
    return rowCount === 1;
}

export async function updateQueueItem(id, fields) {
    const allowed = ["status", "card_id", "card_code", "task_no", "task_status", "task_message", "error", "batch", "plan_type", "submitted_at", "finished_at", "instance_id", "email", "rebind_status", "rebind_email", "rebind_error", "rebind_target", "rebind_pool", "rebind_from", "delivery_status", "delivered_at", "rebind_attempt_email", "rebind_attempt_mailbox_id", "rebind_attempt_at", "rebind_attempt_stage", "rebind_instance", "rebind_blocked_until"];
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

/** 人工把队列项标失败：只有可证明未提交的卡密才放回未使用池。 */
export async function markRechargeQueueError(ids, reason = "") {
    const why = String(reason || "人工标记失败").trim().slice(0, 200);
    const now = Date.now();
    let count = 0, reclaimed = 0, skipped = 0;
    await withTransaction(async (client) => {
        for (const id of queueIds(ids)) {
            const { rows: [item] } = await client.query(`SELECT * FROM recharge_queue WHERE id=$1 FOR UPDATE`, [id]);
            if (!item) { skipped++; continue; }
            if (String(item.instance_id || "")
                || ["submitting", "submitted", "done"].includes(String(item.status || ""))
                || item.task_status === "paid") {
                skipped++;
                continue;
            }
            const cardCode = String(item.card_code || "").trim();
            let cardId = Number(item.card_id || 0);
            if (!cardId && cardCode) {
                const { rows: [byCode] } = await client.query(`SELECT * FROM recharge_cards WHERE code=$1 FOR UPDATE`, [cardCode]);
                if (byCode) cardId = byCode.id;
            }
            if (cardId) {
                const {rows: [card]} = await client.query(`SELECT * FROM recharge_cards WHERE id=$1 FOR UPDATE`, [cardId]);
                if (card && !(await releaseQueueCard(client, item, card, now))) {
                    skipped++;
                    continue;
                }
                if (card) reclaimed++;
            }
            await client.query(
                `UPDATE recharge_queue SET status='error', error=$1, instance_id='', card_id=0, card_code=$2,
                 delivery_status='failed',
                 finished_at=CASE WHEN COALESCE(finished_at,0)>0 THEN finished_at ELSE $3 END WHERE id=$4`,
                [why, cardCode, now, id],
            );
            count++;
        }
    });
    return {count, reclaimed, skipped};
}

export async function resetRechargeQueue(ids) {
    const reclaimInfo: {reset: number; reclaimed: number; kept: number; skipped: number} = {reset: 0, reclaimed: 0, kept: 0, skipped: 0};
    await withTransaction(async (client) => {
        for (const id of queueIds(ids)) {
            const { rows: [item] } = await client.query(`SELECT * FROM recharge_queue WHERE id=$1 FOR UPDATE`, [id]);
            if (!item
                || String(item.instance_id || "")
                || ["submitting", "submitted", "done"].includes(String(item.status || ""))) {
                reclaimInfo.skipped++;
                continue;
            }
            if (item.card_id) {
                const { rows: [card] } = await client.query(`SELECT * FROM recharge_cards WHERE id=$1 FOR UPDATE`, [item.card_id]);
                if (card && !(await releaseQueueCard(client, item, card, Date.now()))) {
                    reclaimInfo.kept++;
                    reclaimInfo.skipped++;
                    continue;
                }
                if (card) reclaimInfo.reclaimed++;
            }
            const { rows: [acc] } = await client.query(`SELECT ${ACC_COLS_FULL} ${ACC_FROM} WHERE g.id=$1`, [item.account_id]);
            const freshAuthFile = acc?.auth_file || item.auth_file;
            const freshAuthData = acc?.auth_data || item.auth_data;
            await client.query(
                `UPDATE recharge_queue SET status='pending', card_id=0, card_code='', task_no='', task_status='', task_message='', error='', submitted_at=0, finished_at=0,
                 delivery_status=CASE WHEN COALESCE(delivery_status,'undelivered')='failed' THEN 'undelivered' ELSE delivery_status END,
                 auth_file=$1, auth_data=$2 WHERE id=$3`,
                [freshAuthFile, freshAuthData ? JSON.stringify(freshAuthData) : null, id]
            );
            reclaimInfo.reset++;
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
