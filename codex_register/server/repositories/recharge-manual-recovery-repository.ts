// @ts-nocheck
// 充值人工恢复事务：只处理执行租约和可证明尚未提交的平台前状态。
import {instanceId, withTransaction} from "./database-context.js";
import {canSafelyReleaseQueueCard} from "../domain/recharge-card-release-policy.js";

function uniqueIds(values) {
    return [...new Set((values || []).map(Number).filter(Number.isInteger))];
}

export function buildRechargeRecoveryPlan(rows, cards) {
    const cardsById = new Map((cards || []).map((card) => [Number(card.id), card]));
    const pairedQueueIds = [];
    const pairedCardIds = [];
    const reviewQueueIds = [];
    for (const row of rows || []) {
        if (String(row.status || "") !== "paired") continue;
        const card = cardsById.get(Number(row.card_id || 0));
        if (card
            && canSafelyReleaseQueueCard(row, card)) {
            pairedQueueIds.push(Number(row.id));
            pairedCardIds.push(Number(card.id));
        } else {
            reviewQueueIds.push(Number(row.id));
        }
    }
    const rebindRows = (rows || []).filter((row) => String(row.rebind_instance || "").trim());
    return {
        rechargeLeaseIds: (rows || []).filter((row) => String(row.instance_id || "").trim()).map((row) => Number(row.id)),
        pairedQueueIds,
        pairedCardIds,
        reviewQueueIds,
        preservedQueueIds: (rows || [])
            .filter((row) => ["submitting", "submitted"].includes(String(row.status || "")))
            .map((row) => Number(row.id)),
        rebindLeaseIds: rebindRows.map((row) => Number(row.id)),
        rebindUnknownIds: rebindRows
            .filter((row) => row.rebind_status === "pending" && row.rebind_attempt_stage === "verify")
            .map((row) => Number(row.id)),
        rebindReturnIds: rebindRows
            .filter((row) => row.rebind_status === "pending" && row.rebind_attempt_stage !== "verify")
            .map((row) => Number(row.id)),
    };
}

export function partitionRechargeRecoveryRows(rows, activeInstances, currentInstanceId) {
    const current = String(currentInstanceId || "").trim();
    const active = new Set((activeInstances || []).map((value) => String(value || "").trim()).filter(Boolean));
    const blocked = [];
    const recoverable = [];
    for (const row of rows || []) {
        const owners = [row.instance_id, row.rebind_instance]
            .map((value) => String(value || "").trim())
            .filter(Boolean);
        if (owners.some((owner) => owner !== current && active.has(owner))) blocked.push(row);
        else recoverable.push(row);
    }
    return {recoverable, blocked};
}

export async function recoverRechargeWorkItems(ids, currentInstanceId = instanceId, {activeWithinMs = 90_000} = {}) {
    const selected = uniqueIds(ids);
    if (!selected.length) return {
        selected: 0,
        notFound: 0,
        rechargeLeases: 0,
        pairedReset: 0,
        preserved: 0,
        review: 0,
        rebindLeases: 0,
        rebindUnknown: 0,
        rebindMailboxes: 0,
        activeSkipped: 0,
    };
    return withTransaction(async (client) => {
        const {rows} = await client.query(
            `SELECT id, account_id, status, card_id, instance_id,
                    task_no, task_status, submitted_at,
                    rebind_status, rebind_instance, rebind_attempt_stage, rebind_attempt_mailbox_id
             FROM recharge_queue WHERE id = ANY($1) ORDER BY id FOR UPDATE`,
            [selected],
        );
        const ownerIds = [...new Set(rows.flatMap((row) => [row.instance_id, row.rebind_instance])
            .map((value) => String(value || "").trim())
            .filter(Boolean))];
        const {rows: activeRows} = ownerIds.length
            ? await client.query(
                `SELECT instance_id FROM mail_instances
                 WHERE instance_id = ANY($1::text[]) AND last_seen >= $2`,
                [ownerIds, Date.now() - Math.max(30_000, Number(activeWithinMs) || 90_000)],
            )
            : {rows: []};
        const partition = partitionRechargeRecoveryRows(
            rows,
            activeRows.map((row) => row.instance_id),
            currentInstanceId,
        );
        const recoverableRows = partition.recoverable;
        const cardIds = uniqueIds(recoverableRows.filter((row) => row.status === "paired").map((row) => row.card_id));
        const {rows: cards} = cardIds.length
            ? await client.query(
                `SELECT id, account_id, status, task_no, task_status
                 FROM recharge_cards WHERE id = ANY($1) ORDER BY id FOR UPDATE`,
                [cardIds],
            )
            : {rows: []};
        const plan = buildRechargeRecoveryPlan(recoverableRows, cards);
        const now = Date.now();

        if (plan.pairedQueueIds.length) {
            await client.query(
                `UPDATE recharge_queue SET status='pending', card_id=0, card_code='', task_no='',
                    task_status='', task_message='', error='', submitted_at=0, finished_at=0, instance_id=''
                 WHERE id = ANY($1) AND status='paired'`,
                [plan.pairedQueueIds],
            );
            await client.query(
                `UPDATE recharge_cards SET status='unused', account_id=0, account_email='', task_no='',
                    task_status='', task_message='', error='', updated_at=$1
                 WHERE id = ANY($2) AND status='paired'`,
                [now, plan.pairedCardIds],
            );
        }
        if (plan.rechargeLeaseIds.length) {
            await client.query(
                `UPDATE recharge_queue SET instance_id='' WHERE id = ANY($1) AND COALESCE(instance_id,'')<>''`,
                [plan.rechargeLeaseIds],
            );
        }
        let rebindMailboxes = 0;
        if (plan.rebindReturnIds.length) {
            const released = await client.query(
                `UPDATE mailboxes m SET usage='hold', claimed_at=0
                 FROM recharge_queue rq
                 WHERE rq.id = ANY($1)
                   AND rq.rebind_attempt_mailbox_id=m.id
                   AND rq.rebind_status='pending'
                   AND COALESCE(rq.rebind_attempt_stage,'')<>'verify'
                   AND m.usage='gpt' AND COALESCE(m.sold_at,0)=0
                   AND NOT EXISTS (
                     SELECT 1 FROM gpt_accounts g
                     WHERE g.mailbox_id=m.id AND COALESCE(g.deleted_at,0)=0
                   )`,
                [plan.rebindReturnIds],
            );
            rebindMailboxes = released.rowCount || 0;
        }
        if (plan.rebindUnknownIds.length) {
            await client.query(
                `UPDATE recharge_queue SET rebind_status='unknown',
                    rebind_error='人工恢复：任务停在 verify 阶段，需先对账确认官方结果'
                 WHERE id = ANY($1) AND rebind_status='pending'`,
                [plan.rebindUnknownIds],
            );
        }
        if (plan.rebindLeaseIds.length) {
            await client.query(
                `UPDATE recharge_queue SET rebind_instance=''
                 WHERE id = ANY($1) AND COALESCE(rebind_instance,'')<>''`,
                [plan.rebindLeaseIds],
            );
        }
        return {
            selected: rows.length,
            notFound: selected.length - rows.length,
            rechargeLeases: plan.rechargeLeaseIds.length,
            pairedReset: plan.pairedQueueIds.length,
            preserved: plan.preservedQueueIds.length,
            review: plan.reviewQueueIds.length,
            rebindLeases: plan.rebindLeaseIds.length,
            rebindUnknown: plan.rebindUnknownIds.length,
            rebindMailboxes,
            activeSkipped: partition.blocked.length,
        };
    });
}
