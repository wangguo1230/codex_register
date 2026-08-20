// @ts-nocheck
// 跨实例任务控制面：只管理任务租约，不解释具体业务状态。
import {instanceId, query, withTransaction} from "./database-context.js";

const ACTIVE_TASK_STATUSES = ["pending", "running"];

function idOf(value) {
    const id = Number(value);
    return Number.isInteger(id) && id > 0 ? id : 0;
}

function normalizeKind(value) {
    const kind = String(value || "").trim();
    if (!kind || !/^[a-z0-9_.:-]+$/i.test(kind)) throw new Error("任务类型无效");
    return kind;
}

function jsonValue(value) {
    return value == null ? null : JSON.stringify(value);
}

export async function enqueueWorkTask(kind, entityId, payload = {}, {
    priority = 0,
    availableAt = Date.now(),
    owner = "",
} = {}) {
    const [task] = await enqueueWorkTasks(kind, [{
        entityId,
        payload,
        priority,
        availableAt,
    }]);
    return task || null;
}

/**
 * 批量入队只执行一次 INSERT。ON CONFLICT 处理多实例同时点击同一批账号的竞态，
 * 调用方通过返回的行集合判断哪些任务实际由本次请求创建。
 */
export async function enqueueWorkTasks(kind, items = []) {
    const normalizedKind = normalizeKind(kind);
    const now = Date.now();
    const normalized = [];
    const seen = new Set();
    for (const item of items || []) {
        const id = idOf(item?.entityId ?? item?.entity_id);
        if (!id || seen.has(id)) continue;
        seen.add(id);
        normalized.push({
            entity_id: id,
            payload: item?.payload == null ? {} : item.payload,
            priority: Number(item?.priority) || 0,
            available_at: Number(item?.availableAt ?? item?.available_at) || now,
        });
    }
    if (!normalized.length) return [];
    const {rows} = await query(
        `INSERT INTO work_tasks(
            kind, entity_id, status, payload, priority, available_at,
            lease_owner, lease_token, lease_until, heartbeat_at,
            attempts, created_at, updated_at
         )
         SELECT $1, item.entity_id, 'pending', COALESCE(item.payload, '{}'::jsonb),
                COALESCE(item.priority, 0), COALESCE(item.available_at, $2),
                '', '', 0, 0, 0, $2, $2
         FROM jsonb_to_recordset($3::jsonb) AS item(
             entity_id BIGINT,
             payload JSONB,
             priority INTEGER,
             available_at BIGINT
         )
         ON CONFLICT DO NOTHING
         RETURNING *`,
        [normalizedKind, now, JSON.stringify(normalized)],
    );
    return rows;
}

export async function getActiveWorkTask(kind, entityId) {
    const normalizedKind = normalizeKind(kind);
    const id = idOf(entityId);
    if (!id) return null;
    const {rows} = await query(
        `SELECT * FROM work_tasks WHERE kind=$1 AND entity_id=$2 AND status = ANY($3::text[]) ORDER BY id DESC LIMIT 1`,
        [normalizedKind, id, ACTIVE_TASK_STATUSES],
    );
    return rows[0] || null;
}

export async function claimWorkTasks(kind, owner = instanceId, limit = 1, leaseMs = 120_000) {
    const normalizedKind = normalizeKind(kind);
    const inst = String(owner || instanceId);
    const size = Math.max(1, Math.min(50, Number(limit) || 1));
    const lease = Math.max(15_000, Number(leaseMs) || 120_000);
    return withTransaction(async (client) => {
        const now = Date.now();
        const {rows} = await client.query(
            `WITH candidates AS (
                 SELECT id, priority
                 FROM work_tasks
                 WHERE kind=$1 AND status='pending' AND available_at <= $2
                 ORDER BY priority DESC, id
                 LIMIT $3
                 FOR UPDATE SKIP LOCKED
             ), claimed AS (
                 UPDATE work_tasks task
                 SET status='running',
                     lease_owner=$4,
                     lease_token=md5(random()::text || clock_timestamp()::text || task.id::text || $4),
                     lease_until=$5,
                     heartbeat_at=$2,
                     attempts=task.attempts+1,
                     started_at=COALESCE(task.started_at,$2),
                     updated_at=$2
                 FROM candidates
                 WHERE task.id=candidates.id AND task.status='pending'
                 RETURNING task.*
             )
             SELECT * FROM claimed ORDER BY priority DESC, id`,
            [normalizedKind, now, size, inst, now + lease],
        );
        return rows;
    });
}

export async function heartbeatWorkTask(taskId, owner = instanceId, token, leaseMs = 120_000) {
    const lease = Math.max(15_000, Number(leaseMs) || 120_000);
    const {rowCount} = await query(
        `UPDATE work_tasks SET heartbeat_at=$1, lease_until=$2, updated_at=$1
         WHERE id=$3 AND status='running' AND lease_owner=$4 AND lease_token=$5`,
        [Date.now(), Date.now() + lease, idOf(taskId), String(owner || instanceId), String(token || "")],
    );
    return (rowCount || 0) > 0;
}

export async function completeWorkTask(taskId, owner = instanceId, token, result = null) {
    const now = Date.now();
    const {rowCount} = await query(
        `UPDATE work_tasks SET status='success', result=$1::jsonb, lease_owner='', lease_token='',
             lease_until=0, heartbeat_at=0, finished_at=$2, updated_at=$2, last_error=''
         WHERE id=$3 AND status='running' AND lease_owner=$4 AND lease_token=$5`,
        [jsonValue(result || {}), now, idOf(taskId), String(owner || instanceId), String(token || "")],
    );
    return (rowCount || 0) > 0;
}

export async function failWorkTask(taskId, owner = instanceId, token, error, {
    retry = true,
    maxAttempts = 3,
    retryDelayMs = 5_000,
} = {}) {
    const detail = String(error?.message || error || "任务失败").slice(0, 500);
    const now = Date.now();
    const {rowCount} = await query(
        `UPDATE work_tasks SET status=CASE WHEN $8::boolean AND attempts < $9 THEN 'pending' ELSE 'failed' END,
             available_at=CASE WHEN $8::boolean AND attempts < $9 THEN $1 ELSE available_at END,
             lease_owner='', lease_token='', lease_until=0, heartbeat_at=0,
             finished_at=CASE WHEN $8::boolean AND attempts < $9 THEN finished_at ELSE $2 END,
             last_error=$4, updated_at=$3
         WHERE id=$5 AND status='running' AND lease_owner=$6 AND lease_token=$7`,
        [now + Math.max(1_000, Number(retryDelayMs) || 5_000), now, now, detail,
            idOf(taskId), String(owner || instanceId), String(token || ""), !!retry, Math.max(1, Number(maxAttempts) || 3)],
    );
    return (rowCount || 0) > 0;
}

export async function releaseWorkTask(taskId, owner = instanceId, token, reason = "实例停止，任务退回排队") {
    const {rowCount} = await query(
        `UPDATE work_tasks SET status='pending', available_at=$1, lease_owner='', lease_token='',
             lease_until=0, heartbeat_at=0, last_error=$2, updated_at=$1
         WHERE id=$3 AND status='running' AND lease_owner=$4 AND lease_token=$5`,
        [Date.now(), String(reason || "任务退回排队").slice(0, 500), idOf(taskId), String(owner || instanceId), String(token || "")],
    );
    return (rowCount || 0) > 0;
}

export async function cancelWorkTask(kind, entityId, reason = "人工取消任务") {
    const normalizedKind = normalizeKind(kind);
    const id = idOf(entityId);
    const {rowCount} = await query(
        `UPDATE work_tasks SET status='canceled', finished_at=$1, updated_at=$1, last_error=$2,
             lease_owner='', lease_token='', lease_until=0, heartbeat_at=0
         WHERE kind=$3 AND entity_id=$4 AND status IN ('pending','running')`,
        [Date.now(), String(reason || "人工取消任务").slice(0, 500), normalizedKind, id],
    );
    return (rowCount || 0) > 0;
}

export async function releaseWorkTasksByOwner(owner = instanceId) {
    const {rowCount} = await query(
        `UPDATE work_tasks SET status='pending', available_at=$1, lease_owner='', lease_token='',
             lease_until=0, heartbeat_at=0, last_error='实例退出，任务退回排队', updated_at=$1
         WHERE status='running' AND lease_owner=$2`,
        [Date.now(), String(owner || instanceId)],
    );
    return rowCount || 0;
}

/** 只由人工恢复接口调用，普通启动和心跳不执行该操作。 */
export async function recoverStaleWorkTasks({kind = "", ids = null, staleMs = 45_000} = {}) {
    const selected = Array.isArray(ids) ? ids.map(idOf).filter(Boolean) : null;
    const params = [Date.now() - Math.max(30_000, Number(staleMs) || 45_000), Date.now()];
    const where = ["status='running'", "COALESCE(heartbeat_at,0) < $1"];
    if (kind) { params.push(normalizeKind(kind)); where.push(`kind=$${params.length}`); }
    if (selected?.length) { params.push(selected); where.push(`entity_id = ANY($${params.length})`); }
    const {rowCount} = await query(
        `UPDATE work_tasks SET status='pending', available_at=$2, lease_owner='', lease_token='',
             lease_until=0, heartbeat_at=0, last_error='人工恢复残留任务，退回排队', updated_at=$2
         WHERE ${where.join(" AND ")}
           AND NOT EXISTS (
               SELECT 1 FROM mail_instances mi
               WHERE mi.instance_id = work_tasks.lease_owner
                 AND mi.last_seen >= $1
           )`,
        params,
    );
    return rowCount || 0;
}

export async function workTaskStats(kind = "") {
    const params = [];
    const where = kind ? "WHERE kind=$1" : "";
    if (kind) params.push(normalizeKind(kind));
    const {rows} = await query(
        `SELECT status, COUNT(*)::int AS count FROM work_tasks ${where} GROUP BY status`,
        params,
    );
    return Object.fromEntries(rows.map((row) => [row.status, Number(row.count || 0)]));
}

export async function listLatestWorkTasks(kind, entityIds = []) {
    const normalizedKind = normalizeKind(kind);
    const ids = [...new Set((entityIds || []).map(idOf).filter(Boolean))];
    if (!ids.length) return [];
    const {rows} = await query(
        `SELECT DISTINCT ON (entity_id) *
         FROM work_tasks
         WHERE kind=$1 AND entity_id = ANY($2::bigint[])
         ORDER BY entity_id, id DESC`,
        [normalizedKind, ids],
    );
    return rows;
}
