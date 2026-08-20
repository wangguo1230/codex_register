// @ts-nocheck
import {instanceId, query, withTransaction} from "./database-context.js";

/** 以调用方读到的旧状态做 CAS 排队，禁止覆盖执行租约或已被其他请求推进的状态。 */
export async function scheduleGmailRebind(queueId, {expectedStatus = "", target = "", pool = null} = {}) {
    const serializedPool = pool && typeof pool === "object" ? JSON.stringify(pool) : pool;
    return withTransaction(async (client) => {
        const {rows: activeTasks} = await client.query(
            `SELECT id FROM work_tasks WHERE kind='gmail_rebind' AND entity_id=$1 AND status IN ('pending','running') LIMIT 1 FOR UPDATE`,
            [Number(queueId)],
        );
        if (activeTasks.length) return false;
        const {rows} = await client.query(
            `UPDATE recharge_queue
             SET rebind_status='pending', rebind_error='', rebind_target=$1, rebind_pool=$2
             WHERE id=$3
               AND COALESCE(rebind_status,'')=$4
               AND COALESCE(rebind_instance,'')=''
             RETURNING id`,
            [String(target || ""), serializedPool, Number(queueId), String(expectedStatus || "")],
        );
        if (!rows.length) return false;
        const {rowCount} = await client.query(
            `INSERT INTO work_tasks(kind, entity_id, status, payload, priority, available_at, created_at, updated_at)
             VALUES('gmail_rebind',$1,'pending',$2::jsonb,10,$3,$3,$3)
             ON CONFLICT DO NOTHING`,
            [Number(queueId), JSON.stringify({target: String(target || ""), pool: pool || {}}), Date.now()],
        );
        if (!rowCount) {
            await client.query(
                `UPDATE recharge_queue SET rebind_status=$1, rebind_error=$2, rebind_target='', rebind_pool=NULL WHERE id=$3`,
                [String(expectedStatus || ""), "", Number(queueId)],
            );
            return false;
        }
        return true;
    });
}

/** 取消不在本进程队列中的等待项；已经被任一实例认领时不允许伪装成已取消。 */
export async function cancelUnclaimedGmailRebind(queueId) {
    return withTransaction(async (client) => {
        const {rows} = await client.query(
            `UPDATE recharge_queue
             SET rebind_status='fail', rebind_error='已取消换绑', rebind_pool=NULL
             WHERE id=$1
               AND rebind_status='pending'
               AND COALESCE(rebind_instance,'')=''
             RETURNING id`,
            [Number(queueId)],
        );
        if (!rows.length) return false;
        await client.query(
            `UPDATE work_tasks SET status='canceled', finished_at=$1, updated_at=$1, last_error='人工取消换绑'
             WHERE kind='gmail_rebind' AND entity_id=$2 AND status='pending'`,
            [Date.now(), Number(queueId)],
        );
        return true;
    });
}

/** 原子认领一次换绑执行，避免多个 HTTP 实例同时操作同一个 GPT 账号。 */
export async function claimRebindExecution(queueId, instId = instanceId) {
    const {rows} = await query(
        `UPDATE recharge_queue
         SET rebind_instance=$1
         WHERE id=$2
           AND rebind_status='pending'
           AND COALESCE(rebind_instance,'')=''
         RETURNING *`,
        [String(instId || ""), Number(queueId)],
    );
    return rows[0] || null;
}

export async function releaseRebindExecution(queueId, instId = instanceId) {
    const {rowCount} = await query(
        `UPDATE recharge_queue SET rebind_instance=''
         WHERE id=$1 AND rebind_instance=$2`,
        [Number(queueId), String(instId || "")],
    );
    return rowCount || 0;
}

/** 换绑意图落盘：打官方 verify 之前调用，失联后依靠这些字段对账。 */
export async function markRebindAttempt(queueId, {email = "", mailboxId = 0, stage = "begin"} = {}) {
    await query(
        `UPDATE recharge_queue
         SET rebind_attempt_email=$1, rebind_attempt_mailbox_id=$2, rebind_attempt_at=$3, rebind_attempt_stage=$4
         WHERE id=$5`,
        [String(email || "").trim().toLowerCase(), Number(mailboxId) || 0, Date.now(), String(stage || ""), Number(queueId)],
    );
}

/** 多实例下用 SKIP LOCKED 原子认领超过宽限期的 unknown 换绑。 */
export async function claimRebindReconcile(limit = 5, instId = instanceId, graceMs = 30_000) {
    const size = Math.max(1, Math.min(50, Number(limit) || 5));
    return withTransaction(async (client) => {
        const {rows} = await client.query(
            `SELECT * FROM recharge_queue
             WHERE rebind_status='unknown'
               AND COALESCE(rebind_instance,'')=''
               AND COALESCE(rebind_attempt_at,0) < $1
             ORDER BY rebind_attempt_at
             LIMIT $2
             FOR UPDATE SKIP LOCKED`,
            [Date.now() - Math.max(0, Number(graceMs) || 0), size],
        );
        if (!rows.length) return [];
        await client.query(
            `UPDATE recharge_queue SET rebind_instance=$1 WHERE id = ANY($2)`,
            [instId, rows.map((row) => row.id)],
        );
        return rows;
    });
}

/** 手工指定对账也必须先认领，避免与周期对账重复请求官方接口。 */
export async function claimRebindReconcileItems(ids, instId = instanceId) {
    const idList = [...new Set((ids || []).map(Number).filter(Number.isInteger))];
    if (!idList.length) return [];
    return withTransaction(async (client) => {
        const {rows} = await client.query(
            `SELECT * FROM recharge_queue
             WHERE id = ANY($1)
               AND rebind_status='unknown'
               AND COALESCE(rebind_instance,'')=''
             ORDER BY id
             FOR UPDATE SKIP LOCKED`,
            [idList],
        );
        if (!rows.length) return [];
        await client.query(
            `UPDATE recharge_queue SET rebind_instance=$1 WHERE id = ANY($2)`,
            [String(instId || ""), rows.map((row) => Number(row.id))],
        );
        return rows.map((row) => ({...row, rebind_instance: String(instId || "")}));
    });
}

export async function releaseRebindReconcile(ids, instId = instanceId) {
    const idList = (ids || []).map(Number).filter(Number.isInteger);
    if (!idList.length) return 0;
    const {rowCount} = await query(
        `UPDATE recharge_queue SET rebind_instance='' WHERE rebind_instance=$1 AND id = ANY($2)`,
        [instId, idList],
    );
    return rowCount || 0;
}

/** 实例启动或退出时释放自己未完成的对账认领。 */
export async function releaseRebindReconcileByInstance(instId = instanceId) {
    const {rowCount} = await query(
        `UPDATE recharge_queue SET rebind_instance='' WHERE rebind_instance=$1`,
        [instId],
    );
    return rowCount || 0;
}

export async function countRebindReconcile() {
    const {rows: [row]} = await query(
        `SELECT COUNT(*)::int AS n FROM recharge_queue WHERE rebind_status='unknown'`,
    );
    return Number(row?.n || 0);
}
