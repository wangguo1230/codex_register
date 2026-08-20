// @ts-nocheck
import {instanceId, query, withTransaction} from "./database-context.js";

// ========== 邮箱任务共享队列（整备等，各机本机代理认领）==========

export async function enqueueMailJobs(items, kind = "harden", batchId = "") {
    const now = Date.now();
    const bid = String(batchId || now.toString(36));
    let inserted = 0;
    await withTransaction(async (client) => {
        for (const it of items) {
            const mailboxId = Number(it.mailbox_id ?? it.id);
            if (!Number.isInteger(mailboxId)) continue;
            const email = String(it.email || "");
            const payload = it.payload != null ? JSON.stringify(it.payload) : null;
            const r = await client.query(
                `INSERT INTO mail_jobs(kind, mailbox_id, email, batch_id, status, created_at, payload)
                 SELECT $1,$2,$3,$4,'pending',$5,$6::jsonb
                 WHERE NOT EXISTS (
                    SELECT 1 FROM mail_jobs
                    WHERE mailbox_id=$2 AND status IN ('pending','running')
                 )`,
                [kind, mailboxId, email, bid, now, payload],
            );
            if (r.rowCount) inserted += 1;
        }
    });
    return {inserted, batchId: bid};
}

export async function claimMailJobs(instId = instanceId, limit = 1, kind = "", maxRunning = 0) {
    const want = Math.max(1, Math.min(8, Number(limit) || 1));
    const cap = Math.max(0, Number(maxRunning) || 0);
    return withTransaction(async (client) => {
        await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`mail-claim:${instId}`]);
        let n = want;
        if (cap > 0) {
            const {rows: [{n: running}]} = await client.query(
                `SELECT COUNT(*)::int AS n FROM mail_jobs WHERE status='running' AND instance_id=$1`,
                [instId],
            );
            n = Math.min(want, Math.max(0, cap - Number(running || 0)));
            if (!n) return [];
        }
        const {rows} = await client.query(
            kind
                ? `SELECT id, kind, mailbox_id, email, batch_id, payload
                   FROM mail_jobs
                   WHERE status='pending' AND kind=$1
                   ORDER BY id LIMIT $2 FOR UPDATE SKIP LOCKED`
                : `SELECT id, kind, mailbox_id, email, batch_id, payload
                   FROM mail_jobs
                   WHERE status='pending'
                   ORDER BY id LIMIT $1 FOR UPDATE SKIP LOCKED`,
            kind ? [kind, n] : [n],
        );
        if (!rows.length) return [];
        const ids = rows.map((r) => r.id);
        const now = Date.now();
        await client.query(
            `UPDATE mail_jobs SET status='running', instance_id=$1, claimed_at=$2, heartbeat_at=$2, last_line='已认领'
             WHERE id = ANY($3)`,
            [instId, now, ids],
        );
        return rows.map((r) => ({...r, instance_id: instId}));
    });
}

/** 只续租本进程内真实执行的邮箱任务，避免同端口重启后给历史 running 续命。 */
export async function heartbeatMailJobs(instId = instanceId, mailboxIds = []) {
    const ids = [...new Set((mailboxIds || []).map(Number).filter(Number.isInteger))];
    if (!ids.length) return 0;
    const {rowCount} = await query(
        `UPDATE mail_jobs SET heartbeat_at=$1
         WHERE status='running' AND instance_id=$2 AND mailbox_id = ANY($3)`,
        [Date.now(), instId, ids],
    );
    return rowCount || 0;
}

/** 人工恢复失联任务。只以任务自身心跳为准，避免实例统计上报延迟时回收活任务。 */
export async function recoverInterruptedMailJobs(mailboxIds = null, {
    excludeMailboxIds = [],
    staleMs = 45_000,
} = {}) {
    const selected = Array.isArray(mailboxIds)
        ? [...new Set(mailboxIds.map(Number).filter(Number.isInteger))]
        : null;
    if (selected !== null && !selected.length) return 0;
    const excluded = [...new Set((excludeMailboxIds || []).map(Number).filter(Number.isInteger))];
    const cutoff = Date.now() - Math.max(30_000, Number(staleMs) || 45_000);
    const params: any[] = [cutoff];
    let scope = "";
    if (selected !== null) {
        params.push(selected);
        scope += ` AND j.mailbox_id = ANY($${params.length})`;
    }
    if (excluded.length) {
        params.push(excluded);
        scope += ` AND NOT (j.mailbox_id = ANY($${params.length}))`;
    }
    const {rowCount} = await query(
        `UPDATE mail_jobs j
         SET status='pending', instance_id='', claimed_at=0, heartbeat_at=0,
             last_line='人工恢复残留任务，退回排队', error='', ok=NULL, finished_at=NULL
         WHERE j.status='running'${scope}
           AND (
             COALESCE(j.instance_id,'')=''
             OR COALESCE(j.heartbeat_at,0)<$1
           )`,
        params,
    );
    return rowCount || 0;
}

export async function setMailJobLine(jobId, line) {
    await query(`UPDATE mail_jobs SET last_line=$1, heartbeat_at=$2 WHERE id=$3 AND status='running'`,
        [String(line || "").slice(0, 180), Date.now(), jobId]);
}

export async function requeueMailJob(jobId, line = "比特异常，退回排队") {
    await query(
        `UPDATE mail_jobs
         SET status='pending', instance_id='', last_line=$1, error='', ok=NULL, finished_at=NULL
         WHERE id=$2 AND status IN ('running','error')`,
        [String(line || "").slice(0, 180), jobId],
    );
}

export async function requeueRunningOnInstance(instId, line = "比特掉登录，退回排队") {
    const {rows} = await query(
        `UPDATE mail_jobs
         SET status='pending', instance_id='', last_line=$1, error='', ok=NULL, finished_at=NULL
         WHERE status='running' AND instance_id=$2
         RETURNING id`,
        [String(line || "").slice(0, 180), instId],
    );
    return rows.length;
}

export async function requeueRecentBitTransientFails() {
    const {rows} = await query(
        `UPDATE mail_jobs j
         SET status='pending', instance_id='', last_line='比特恢复，重新排队', error='', ok=NULL, finished_at=NULL
         WHERE j.id IN (
           SELECT DISTINCT ON (mailbox_id) id FROM mail_jobs
           WHERE kind='harden' AND (
             (status='error'
               AND finished_at > $1
               AND (error ILIKE '%比特%' OR error ILIKE '%Login Expired%' OR error ILIKE '%Login out%'
                    OR error ILIKE '%没有找到相应数据%' OR error ILIKE '%跳板%' OR error ILIKE '%代理不通%'
                    OR error ILIKE '%ECONNREFUSED%'))
             OR (status='canceled' AND last_line ILIKE '%等 Windows 比特重新登录%')
           )
           ORDER BY mailbox_id, id DESC
         )
         AND NOT EXISTS (
           SELECT 1 FROM mail_jobs x
           WHERE x.mailbox_id=j.mailbox_id AND x.status IN ('pending','running') AND x.id<>j.id
         )
         RETURNING j.id, j.email`,
        [Date.now() - 2 * 60 * 60 * 1000],
    );
    return rows;
}

export async function completeMailJob(jobId, ok, error = "", result = null) {
    await query(
        `UPDATE mail_jobs
         SET status=$1, ok=$2, error=$3, result=$4::jsonb, finished_at=$5, last_line=$6
         WHERE id=$7`,
        [ok ? "done" : "error", !!ok, String(error || "").slice(0, 240),
            JSON.stringify(result || {}), Date.now(), ok ? "完成" : String(error || "失败").slice(0, 180), jobId],
    );
}

export async function reclaimStaleMailJobs(maxAgeMs = 3 * 60 * 1000) {
    const cutoff = Date.now() - Math.max(30_000, maxAgeMs);
    const {rowCount} = await query(
        `UPDATE mail_jobs SET status='pending', instance_id='', last_line='心跳超时，退回排队'
         WHERE status='running' AND heartbeat_at>0 AND heartbeat_at<$1`,
        [cutoff],
    );
    return rowCount || 0;
}

/** 继续完成误把已齐（2FA+IMAP）的号又排进去时，把还没开跑的撤掉。 */
export async function cancelPendingHardenIfAlreadyUsable() {
    const {planHardenSkip} = await import("../../src/mail/google-state.ts");
    const {rows} = await query(
        `SELECT j.id, m.pw_status, m.google_state, m.totp_secret, m.imap_password, m.recovery_email, m.google_stage, m.provider
         FROM mail_jobs j
         JOIN mailboxes m ON m.id = j.mailbox_id
         WHERE j.kind='harden' AND j.status='pending'`,
    );
    const ids = rows.filter((mb) => planHardenSkip(mb).usable).map((r) => r.id);
    if (!ids.length) return 0;
    const {rowCount} = await query(
        `UPDATE mail_jobs SET status='canceled', finished_at=$1, last_line='已整备（2FA+IMAP），继续完成跳过'
         WHERE id = ANY($2) AND status='pending'`,
        [Date.now(), ids],
    );
    return rowCount || 0;
}

export async function cancelPendingMailJobs(kind = "") {
    const now = Date.now();
    const r = kind
        ? await query(`UPDATE mail_jobs SET status='canceled', finished_at=$1, last_line='已取消' WHERE status='pending' AND kind=$2`, [now, kind])
        : await query(`UPDATE mail_jobs SET status='canceled', finished_at=$1, last_line='已取消' WHERE status='pending'`, [now]);
    return r.rowCount || 0;
}

export async function failTimedOutMailJobs(maxMs = 22 * 60 * 1000) {
    const claimedCutoff = Date.now() - Math.max(60_000, maxMs);
    const beatCutoff = Date.now() - 3 * 60 * 1000;
    const {rows} = await query(
        `UPDATE mail_jobs
         SET status='error', ok=FALSE, error='单任务超时', finished_at=$1, last_line='超时失败'
         WHERE status='running' AND claimed_at>0
           AND (claimed_at<$2 OR heartbeat_at IS NULL OR heartbeat_at=0 OR heartbeat_at<$3)
         RETURNING id, mailbox_id, instance_id, kind`,
        [Date.now(), claimedCutoff, beatCutoff],
    );
    return rows;
}
