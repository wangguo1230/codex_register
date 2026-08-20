// @ts-nocheck
import {instanceId, withTransaction} from "./database-context.js";
import {resolveRechargeTaskSettlement, resolveRechargeTaskTransition} from "../domain/recharge-task-state.js";
import {RECHARGE_CARD_REUSE_BLOCKING_REFERENCE_SQL} from "./recharge-card-reference-policy.js";

/**
 * 将已认领卡密绑定到本实例的队列项。队列和卡密必须在同一事务内更新，
 * 否则任一写入失败都会制造无法自动判断归属的半配对状态。
 */
export async function assignClaimedRechargeCard(queueId, cardId, accountId, accountEmail, instId = instanceId) {
    const qid = Number(queueId);
    const cid = Number(cardId);
    const aid = Number(accountId);
    if (![qid, cid, aid].every(Number.isInteger)) throw new Error("配卡参数无效");
    return withTransaction(async (client) => {
        const {rows: [queueItem]} = await client.query(
            `SELECT * FROM recharge_queue WHERE id=$1 FOR UPDATE`,
            [qid],
        );
        if (!queueItem) throw new Error("充值队列项不存在");
        if (Number(queueItem.account_id) !== aid) throw new Error("充值队列账号不匹配");
        if (String(queueItem.instance_id || "") !== String(instId || "")) throw new Error("充值队列认领已失效");
        if (["submitted", "done"].includes(String(queueItem.status || ""))) {
            throw new Error(`充值队列状态不可配卡: ${queueItem.status}`);
        }
        if (String(queueItem.delivery_status || "undelivered") !== "undelivered") throw new Error("充值队列已交付或已标记失败");

        const {rows: [card]} = await client.query(
            `SELECT * FROM recharge_cards WHERE id=$1 FOR UPDATE`,
            [cid],
        );
        if (!card) throw new Error("充值卡密不存在");
        const currentOwner = Number(card.account_id || 0);
        const isCurrentQueueCard = Number(queueItem.card_id || 0) === cid;
        if (String(card.status || "") === "done") throw new Error("充值卡密已使用");
        if (currentOwner && currentOwner !== aid) throw new Error("充值卡密已绑定其他账号");
        if (String(card.status || "") !== "paired" && !isCurrentQueueCard) throw new Error(`充值卡密状态不可配对: ${card.status}`);

        const {rows: conflicts} = await client.query(
            `SELECT rq.id FROM recharge_queue rq
             WHERE rq.card_id=$1 AND rq.id<>$2
               AND ${RECHARGE_CARD_REUSE_BLOCKING_REFERENCE_SQL}
               AND COALESCE(rq.delivery_status,'undelivered')='undelivered'
             LIMIT 1`,
            [cid, qid],
        );
        if (conflicts.length) throw new Error("充值卡密已绑定其他队列项");

        const now = Date.now();
        const {rows: [nextQueue]} = await client.query(
            `UPDATE recharge_queue SET
                status='paired', card_id=$1, card_code=$2,
                task_no='', task_status='', task_message='', error='', submitted_at=0, finished_at=0
             WHERE id=$3
             RETURNING *`,
            [cid, card.code || "", qid],
        );
        const {rows: [nextCard]} = await client.query(
            `UPDATE recharge_cards SET
                status='paired', account_id=$1, account_email=$2,
                task_no='', task_status='', task_message='', error='', updated_at=$3
             WHERE id=$4
             RETURNING *`,
            [aid, String(accountEmail || ""), now, cid],
        );
        return {queueItem: nextQueue, card: nextCard};
    });
}

async function lockClaimedRechargePair(client, queueId, cardId, instId) {
    const {rows: [queueItem]} = await client.query(
        `SELECT * FROM recharge_queue WHERE id=$1 FOR UPDATE`,
        [Number(queueId)],
    );
    if (!queueItem) throw new Error("充值队列项不存在");
    if (String(queueItem.instance_id || "") !== String(instId || "")) throw new Error("充值队列认领已失效");
    if (Number(queueItem.card_id || 0) !== Number(cardId)) throw new Error("充值队列卡密已变化");
    const {rows: [card]} = await client.query(
        `SELECT * FROM recharge_cards WHERE id=$1 FOR UPDATE`,
        [Number(cardId)],
    );
    if (!card) throw new Error("充值卡密不存在");
    return {queueItem, card};
}

/** 提交前原子推进队列和卡密，避免出现单边 submitting。 */
export async function beginRechargeSubmission(queueId, cardId, instId = instanceId) {
    return withTransaction(async (client) => {
        const current = await lockClaimedRechargePair(client, queueId, cardId, instId);
        if (current.queueItem.status !== "paired" || current.card.status !== "paired") {
            throw new Error(`充值状态不可提交: queue=${current.queueItem.status}, card=${current.card.status}`);
        }
        await client.query(`UPDATE recharge_queue SET status='submitting' WHERE id=$1`, [Number(queueId)]);
        await client.query(
            `UPDATE recharge_cards SET status='submitting', updated_at=$1 WHERE id=$2`,
            [Date.now(), Number(cardId)],
        );
    });
}

/** 平台请求尚未开始时撤销配对，停止批次和本地异常都可安全重试。 */
export async function cancelPairedRechargeSubmission(queueId, cardId, instId = instanceId, {allowSubmitting = false} = {}) {
    return withTransaction(async (client) => {
        const current = await lockClaimedRechargePair(client, queueId, cardId, instId);
        const queueStatus = String(current.queueItem.status || "");
        const cardStatus = String(current.card.status || "");
        const canRelease = queueStatus === "paired" && cardStatus === "paired"
            || allowSubmitting && queueStatus === "submitting" && cardStatus === "submitting";
        if (!canRelease) {
            return {released: false, reason: "配对已进入提交阶段"};
        }
        await client.query(
            `UPDATE recharge_queue SET
                status='pending', card_id=0, card_code='', task_no='', task_status='', task_message='',
                error='', submitted_at=0, finished_at=0
             WHERE id=$1 AND status=$2`,
            [Number(queueId), queueStatus],
        );
        await client.query(
            `UPDATE recharge_cards SET
                status='unused', account_id=0, account_email='', error='', task_no='', task_status='',
                task_message='', updated_at=$1
             WHERE id=$2 AND status=$3`,
            [Date.now(), Number(cardId), cardStatus],
        );
        return {released: true};
    });
}

/** 平台接单后原子记录任务号和双方 submitted 状态。 */
export async function completeRechargeSubmission(queueId, cardId, task, instId = instanceId) {
    return withTransaction(async (client) => {
        const current = await lockClaimedRechargePair(client, queueId, cardId, instId);
        const taskNo = String(task?.taskNo || "");
        const taskStatus = String(task?.status || "queued");
        const taskMessage = String(task?.message || "");
        const now = Date.now();
        const queueTerminal = current.queueItem.status === "done"
            || current.queueItem.status === "error"
            || String(current.queueItem.task_status || "").toLowerCase() === "paid";
        if (queueTerminal) return {applied: false, reason: `队列已到终态 ${current.queueItem.status}`};
        if (!["submitting", "submitted"].includes(String(current.queueItem.status || ""))) {
            throw new Error(`充值状态不可完成提交: ${current.queueItem.status}`);
        }
        const transition = resolveRechargeTaskTransition(current.queueItem, {
            task_status: taskStatus,
            task_message: taskMessage,
        });
        if (!transition.applied) return transition;
        const effectiveTaskNo = taskNo || String(current.queueItem.task_no || "");
        const effectiveTaskStatus = transition.updates.task_status === undefined
            ? String(current.queueItem.task_status || taskStatus)
            : String(transition.updates.task_status);
        const effectiveTaskMessage = transition.updates.task_message === undefined
            ? String(current.queueItem.task_message || "")
            : String(transition.updates.task_message);
        const settlement = resolveRechargeTaskSettlement(effectiveTaskStatus, () => now);
        const nextCardId = settlement.releaseCard ? 0 : Number(cardId);
        await client.query(
            `UPDATE recharge_queue SET status=$1, card_id=$2, task_no=$3, task_status=$4, task_message=$5,
                submitted_at=CASE WHEN COALESCE(submitted_at,0)>0 THEN submitted_at ELSE $6 END,
                finished_at=CASE WHEN $7::bigint>0 THEN $7 ELSE finished_at END
             WHERE id=$8 AND status IN ('submitting','submitted')`,
            [settlement.queueStatus, nextCardId, effectiveTaskNo, effectiveTaskStatus, effectiveTaskMessage, now, settlement.finishedAt, Number(queueId)],
        );
        if (settlement.releaseCard) {
            await client.query(
                `UPDATE recharge_cards SET status='unused', account_id=0, account_email='', error='',
                    task_no='', task_status='', task_message='', updated_at=$1
                 WHERE id=$2 AND status IN ('submitting','submitted')`,
                [now, Number(cardId)],
            );
        } else {
            await client.query(
                `UPDATE recharge_cards SET status=$1, task_no=$2, task_status=$3, task_message=$4, updated_at=$5
                 WHERE id=$6 AND status IN ('submitting','submitted')`,
                [settlement.cardStatus, effectiveTaskNo, effectiveTaskStatus, effectiveTaskMessage, now, Number(cardId)],
            );
        }
        return {applied: true, ...settlement};
    });
}

/** 创建平台任务的响应未知时保留 submitting 配对，交给 lookup 对账。 */
export async function markRechargeSubmissionUnknown(queueId, cardId, message, instId = instanceId) {
    return withTransaction(async (client) => {
        const current = await lockClaimedRechargePair(client, queueId, cardId, instId);
        if (["done", "error"].includes(String(current.queueItem.status || ""))) {
            return {applied: false, reason: `队列已到终态 ${current.queueItem.status}`};
        }
        const detail = String(message || "平台任务创建结果未知").slice(0, 200);
        await client.query(
            `UPDATE recharge_queue SET task_status='unknown', task_message=$1 WHERE id=$2 AND status='submitting'`,
            [detail, Number(queueId)],
        );
        await client.query(
            `UPDATE recharge_cards SET task_status='unknown', task_message=$1, updated_at=$2
             WHERE id=$3 AND status='submitting'`,
            [detail, Date.now(), Number(cardId)],
        );
        return {applied: true};
    });
}

/** 平台接单前失败时原子解绑队列并锁定卡密，防止卡密被后续账号误用。 */
export async function failRechargeSubmission(queueId, cardId, {message = "", cardCode = ""} = {}, instId = instanceId) {
    return withTransaction(async (client) => {
        const current = await lockClaimedRechargePair(client, queueId, cardId, instId);
        if (current.queueItem.status !== "submitting" || current.card.status !== "submitting") {
            return {applied: false, reason: `充值状态已变化: queue=${current.queueItem.status}, card=${current.card.status}`};
        }
        const error = String(message || "提交失败").slice(0, 200);
        const now = Date.now();
        await client.query(
            `UPDATE recharge_queue SET status='error', error=$1, finished_at=$2,
                card_id=0, card_code=$3, instance_id='' WHERE id=$4`,
            [error, now, String(cardCode || ""), Number(queueId)],
        );
        await client.query(
            `UPDATE recharge_cards SET status='error', error=$1, updated_at=$2 WHERE id=$3`,
            [error, now, Number(cardId)],
        );
        return {applied: true};
    });
}

/** 平台任务结果同时收敛队列与卡密；旧轮询快照不得覆盖已经重新配卡的队列项。 */
export async function applyRechargeTaskResult(queueId, cardId, updates, {releaseCard = false} = {}) {
    const qid = Number(queueId);
    const cid = Number(cardId || 0);
    if (!Number.isInteger(qid)) throw new Error("充值任务收敛参数无效");
    return withTransaction(async (client) => {
        const {rows: [current]} = await client.query(
            `SELECT id, card_id, status, task_status, submitted_at FROM recharge_queue WHERE id=$1 FOR UPDATE`,
            [qid],
        );
        if (!current) return {applied: false, reason: "队列项不存在"};
        if (cid > 0 && Number(current.card_id || 0) !== cid) {
            return {applied: false, reason: "队列项已重新配卡"};
        }

        const transition = resolveRechargeTaskTransition(current, updates);
        if (!transition.applied) return transition;
        const effectiveUpdates = transition.updates;

        let lockedCard = null;
        if (cid > 0) {
            const {rows: [card]} = await client.query(
                `SELECT id, status, task_status FROM recharge_cards WHERE id=$1 FOR UPDATE`,
                [cid],
            );
            lockedCard = card || null;
        }

        const queueAllowed = ["status", "card_id", "task_no", "task_status", "task_message", "submitted_at", "finished_at"];
        const queueSets = [];
        const queueValues = [];
        for (const key of queueAllowed) {
            if (effectiveUpdates[key] === undefined) continue;
            queueSets.push(`${key}=$${queueValues.length + 1}`);
            queueValues.push(effectiveUpdates[key]);
        }
        if (queueSets.length) {
            queueValues.push(qid);
            await client.query(
                `UPDATE recharge_queue SET ${queueSets.join(",")} WHERE id=$${queueValues.length}`,
                queueValues,
            );
        }

        if (cid > 0 && releaseCard) {
            await client.query(
                `UPDATE recharge_cards SET
                    status='unused', account_id=0, account_email='', error='',
                    task_no='', task_status='', task_message='', updated_at=$1
                 WHERE id=$2 AND status<>'done'`,
                [Date.now(), cid],
            );
        } else if (cid > 0 && lockedCard?.status !== "done") {
            const cardAllowed = ["status", "task_no", "task_status", "task_message"];
            const cardSets = [];
            const cardValues = [];
            for (const key of cardAllowed) {
                if (effectiveUpdates[key] === undefined) continue;
                cardSets.push(`${key}=$${cardValues.length + 1}`);
                cardValues.push(effectiveUpdates[key]);
            }
            if (cardSets.length) {
                cardSets.push(`updated_at=$${cardValues.length + 1}`);
                cardValues.push(Date.now(), cid);
                await client.query(
                    `UPDATE recharge_cards SET ${cardSets.join(",")} WHERE id=$${cardValues.length}`,
                    cardValues,
                );
            }
        }
        return {applied: true};
    });
}
