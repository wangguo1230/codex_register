// @ts-nocheck
import {query} from "./database-context.js";
import {isMailClaimPaused} from "./mail-job-runtime-repository.js";

export async function listResumableHardenMailboxIds() {
    return listResumableMailJobs({kinds: ["harden"], onlyError: false});
}

export async function listGoogleHardenGaps(ids = null) {
    const {needsHardenRetry} = await import("../../src/mail/google-state.ts");
    const wanted = Array.isArray(ids) ? ids.map(Number).filter(Number.isInteger) : [];
    const {rows} = wanted.length
        ? await query(
            `SELECT id, email, password, pw_status, google_state, google_stage, totp_secret, imap_password, recovery_email, provider
             FROM mailboxes
             WHERE deleted_at=0 AND provider='google' AND COALESCE(google_stage,'') NOT IN ('gpt_ok','blocked') AND id = ANY($1)`,
            [wanted],
        )
        : await query(
            `SELECT id, email, password, pw_status, google_state, google_stage, totp_secret, imap_password, recovery_email, provider
             FROM mailboxes
             WHERE deleted_at=0 AND provider='google' AND COALESCE(google_stage,'') NOT IN ('gpt_ok','blocked')`,
        );
    return rows.filter((mailbox) => needsHardenRetry(mailbox));
}

/** 和任务条失败数同一口径：最近一批里 status=error 的号。 */
export async function listNewestBatchErrorJobs(kind = "harden") {
    const {rows: newest} = await query(
        `SELECT batch_id FROM mail_jobs
         WHERE status IN ('pending','running') AND COALESCE(batch_id,'')<>'' AND kind=$1
         ORDER BY id DESC LIMIT 1`,
        [kind],
    );
    let batchId = newest[0]?.batch_id || "";
    if (!batchId) {
        const {rows: [last]} = await query(
            `SELECT batch_id FROM mail_jobs WHERE COALESCE(batch_id,'')<>'' AND kind=$1 ORDER BY id DESC LIMIT 1`,
            [kind],
        );
        batchId = last?.batch_id || "";
    }
    if (!batchId) return [];
    const {rows} = await query(
        `SELECT DISTINCT ON (mailbox_id) mailbox_id, email, kind, status, error
         FROM mail_jobs
         WHERE kind=$1 AND batch_id=$2 AND status='error'
         ORDER BY mailbox_id, id DESC`,
        [kind, batchId],
    );
    return rows.map((row) => ({
        id: Number(row.mailbox_id), email: row.email || "", kind: row.kind,
        status: row.status, error: row.error || "",
    }));
}

export async function listResumableMailJobs({kinds = ["harden"], onlyError = false, since = 0} = {}) {
    const wanted = (kinds || ["harden"]).filter(Boolean);
    const cutoff = Number(since) > 0 ? Number(since) : 0;
    const {rows} = await query(
        `SELECT DISTINCT ON (kind, mailbox_id) mailbox_id, email, kind, status, error, finished_at
         FROM mail_jobs
         WHERE kind = ANY($1) AND ($2=0 OR COALESCE(finished_at, created_at, 0) > $2)
         ORDER BY kind, mailbox_id, id DESC`,
        [wanted, cutoff],
    );
    return rows
        .filter((row) => onlyError ? row.status === "error" : (row.status === "canceled" || row.status === "error"))
        .map((row) => ({
            id: Number(row.mailbox_id), email: row.email || "", kind: row.kind,
            status: row.status, error: row.error || "",
        }));
}

export async function mailJobsProgress(kind = "") {
    const kindFilter = kind ? "AND kind=$1" : "";
    const params = kind ? [kind] : [];
    const {rows: newest} = await query(
        `SELECT batch_id FROM mail_jobs
         WHERE status IN ('pending','running') AND COALESCE(batch_id,'')<>'' ${kindFilter}
         ORDER BY id DESC LIMIT 1`,
        params,
    );
    const {rows: open} = await query(
        `SELECT DISTINCT batch_id FROM mail_jobs WHERE status IN ('pending','running') AND COALESCE(batch_id,'')<>'' ${kindFilter}`,
        params,
    );
    let batchIds = newest.map((row) => row.batch_id).filter(Boolean);
    if (!batchIds.length) {
        const {rows: [last]} = await query(
            `SELECT batch_id FROM mail_jobs WHERE COALESCE(batch_id,'')<>'' ${kindFilter} ORDER BY id DESC LIMIT 1`,
            params,
        );
        if (last?.batch_id) batchIds = [last.batch_id];
    }
    const paused = await isMailClaimPaused();
    const empty = {running: false, kind: kind || "mail", done: 0, total: 0, ok: 0, fail: 0, queued: 0, runningCount: 0, rate: 0, current: [], lastLine: "", batchId: "", byKind: {}, paused};
    if (!batchIds.length) return empty;
    const allOpenIds = [...new Set(open.map((row) => row.batch_id).filter(Boolean).concat(batchIds))];
    const {rows} = await query(
        `SELECT kind, status, COUNT(*)::int AS n, COUNT(*) FILTER (WHERE ok)::int AS okc
         FROM mail_jobs WHERE batch_id = ANY($1) ${kind ? "AND kind=$2" : ""}
         GROUP BY kind, status`,
        kind ? [batchIds, kind] : [batchIds],
    );
    const {rows: liveRows} = await query(
        `SELECT status, COUNT(*)::int AS n
         FROM mail_jobs WHERE status IN ('pending','running') AND batch_id = ANY($1) ${kind ? "AND kind=$2" : ""}
         GROUP BY status`,
        kind ? [allOpenIds, kind] : [allOpenIds],
    );
    const byStatus = {pending: 0, running: 0, done: 0, error: 0, canceled: 0};
    const byKind = {};
    let ok = 0;
    for (const row of rows) {
        if (byStatus[row.status] !== undefined) byStatus[row.status] += row.n;
        if (row.status === "done") ok += row.okc || 0;
        if (!byKind[row.kind]) byKind[row.kind] = {pending: 0, running: 0, done: 0, error: 0, ok: 0};
        if (byKind[row.kind][row.status] !== undefined) byKind[row.kind][row.status] += row.n;
        if (row.status === "done") byKind[row.kind].ok += row.okc || 0;
    }
    byStatus.pending = 0;
    byStatus.running = 0;
    for (const row of liveRows) {
        if (row.status === "pending") byStatus.pending = row.n;
        if (row.status === "running") byStatus.running = row.n;
    }
    const fail = byStatus.error;
    const done = byStatus.done + byStatus.error;
    const total = byStatus.pending + byStatus.running + byStatus.done + byStatus.error;
    const now = Date.now();
    const {rows: current} = await query(
        `SELECT id, kind, mailbox_id, email, last_line, instance_id, claimed_at
         FROM mail_jobs WHERE status='running' AND batch_id = ANY($1) ${kind ? "AND kind=$2" : ""}
         ORDER BY claimed_at`,
        kind ? [allOpenIds, kind] : [allOpenIds],
    );
    const {rows: [timing]} = await query(
        `SELECT
            MIN(created_at) AS first_created,
            MIN(claimed_at) FILTER (WHERE claimed_at>0) AS first_claim,
            MAX(finished_at) FILTER (WHERE finished_at>0) AS last_finish,
            AVG(finished_at - claimed_at) FILTER (
                WHERE finished_at>0 AND claimed_at>0 AND finished_at>claimed_at
            ) AS avg_ms
         FROM mail_jobs WHERE batch_id = ANY($1) ${kind ? "AND kind=$2" : ""}`,
        kind ? [batchIds, kind] : [batchIds],
    );
    const {rows: finished} = await query(
        `SELECT finished_at, ok FROM mail_jobs
         WHERE batch_id = ANY($1) AND status IN ('done','error') AND finished_at>0
         ${kind ? "AND kind=$2" : ""}`,
        kind ? [batchIds, kind] : [batchIds],
    );
    const hourStart = (timestamp) => {
        const date = new Date(Number(timestamp) || 0);
        date.setMinutes(0, 0, 0);
        return date.getTime();
    };
    const hourMap = new Map();
    for (const row of finished) {
        const at = hourStart(row.finished_at);
        if (!at) continue;
        const bucket = hourMap.get(at) || {at, done: 0, ok: 0, fail: 0};
        bucket.done += 1;
        if (row.ok) bucket.ok += 1;
        else bucket.fail += 1;
        hourMap.set(at, bucket);
    }
    const hourly = [...hourMap.values()].sort((a, b) => a.at - b.at);
    const startedAt = Number(timing?.first_claim || timing?.first_created || 0) || 0;
    const lastFinish = Number(timing?.last_finish || 0) || 0;
    const live = byStatus.running + byStatus.pending > 0;
    const endedAt = live ? 0 : lastFinish;
    const elapsedMs = startedAt ? Math.max(0, (live ? now : (endedAt || now)) - startedAt) : 0;
    const avgMs = Math.round(Number(timing?.avg_ms || 0) || 0);
    const thisHourAt = hourStart(now);
    const hourNow = hourly.find((hour) => hour.at === thisHourAt) || {at: thisHourAt, done: 0, ok: 0, fail: 0};
    const remain = byStatus.pending + byStatus.running;
    const etaMs = avgMs && remain ? Math.round((avgMs * remain) / Math.max(1, byStatus.running || 1)) : 0;
    const lastLine = current[0]?.last_line || (byStatus.pending || byStatus.running ? `排队 ${byStatus.pending} · 执行 ${byStatus.running}` : `结束 成功 ${ok}/${done}`);
    const {rows: failRows} = await query(
        `SELECT DISTINCT ON (mailbox_id) email
         FROM mail_jobs
         WHERE batch_id = ANY($1) AND status='error' ${kind ? "AND kind=$2" : ""}
         ORDER BY mailbox_id, id DESC`,
        kind ? [batchIds, kind] : [batchIds],
    );
    const failEmails = failRows.map((row) => String(row.email || "").trim()).filter(Boolean);
    return {
        running: live,
        kind: kind || "mail",
        done,
        total,
        ok,
        fail,
        queued: byStatus.pending,
        runningCount: byStatus.running,
        rate: done ? Math.round((ok / done) * 100) : 0,
        current: current.map((row) => ({
            id: row.mailbox_id, email: row.email, lastLine: row.last_line || "运行中",
            instanceId: row.instance_id, kind: row.kind,
            claimedAt: Number(row.claimed_at || 0) || 0,
            elapsedMs: row.claimed_at ? Math.max(0, now - Number(row.claimed_at)) : 0,
        })),
        lastLine,
        batchId: batchIds.join(","),
        byKind,
        paused,
        startedAt,
        endedAt,
        elapsedMs,
        avgMs,
        etaMs,
        hourly,
        hourNow,
        failEmails,
    };
}
