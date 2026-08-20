// @ts-nocheck
import {instanceId, query, withAdvisoryLock, withTransaction} from "./database-context.js";

export function withRechargePollLease(task) {
    return withAdvisoryLock("codex-register:recharge-poll", task);
}

/** 原子认领未被其他实例占用且尚未提交完成的队列项。 */
export async function claimRechargeQueueItems(ids, instId = instanceId, {allowError = false} = {}) {
    const idList = (ids || []).map(Number).filter(Number.isInteger);
    if (!idList.length) return { claimed: [], skipped: [] };
    return withTransaction(async (client) => {
        const { rows: all } = await client.query(
            `SELECT id, email, status, instance_id, delivery_status FROM recharge_queue WHERE id = ANY($1)`,
            [idList]
        );
        const { rows } = await client.query(
            `SELECT * FROM recharge_queue
             WHERE id = ANY($1)
               AND status NOT IN ('submitting', 'submitted', 'done')
               AND ($2::boolean OR status<>'error')
               AND COALESCE(delivery_status,'undelivered')='undelivered'
               AND instance_id = ''
             FOR UPDATE SKIP LOCKED`,
            [idList, !!allowError]
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
            reason: r.delivery_status === "delivered"
                ? "已交付"
                : r.delivery_status === "failed"
                ? "已人工标记失败"
                : ["submitting", "submitted", "done", "error"].includes(String(r.status || ""))
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

/**
 * 收尾只释放执行租约。submitting 可能已经被平台接单，必须保留并交给卡密查询对账，
 * 不能回退后重复提交。ids 给了就只收自己这一批；不给才回收本实例全部租约。
 */
export async function releaseRechargeQueueByInstance(instId = instanceId, ids = null) {
    const idList = ids === null ? null : (ids || []).map(Number).filter(Number.isInteger);
    if (idList !== null && !idList.length) return 0;
    const params: any[] = [instId];
    let extra = "";
    if (idList !== null) {
        params.push(idList);
        extra = ` AND id = ANY($${params.length})`;
    }
    const { rowCount } = await query(
        `UPDATE recharge_queue SET instance_id = ''
         WHERE instance_id = $1${extra}`,
        params
    );
    return rowCount || 0;
}
