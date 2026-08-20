// @ts-nocheck
import {query} from "./database-context.js";

function rechargeQueueDeliveryKind(delivery = "undelivered") {
    const d = String(delivery || "undelivered").toLowerCase();
    if (d === "all") return "all";
    if (d === "delivered") return "delivered";
    if (d === "error" || d === "failed") return "error";
    if (d === "ready" || d === "deliverable") return "ready";
    return "undelivered";
}

function rechargeQueueWhere(kind, alias = "") {
    const column = (name) => alias ? `${alias}.${name}` : name;
    if (kind === "all") return "";
    if (kind === "delivered") return `WHERE COALESCE(${column("delivery_status")},'undelivered')='delivered'`;
    if (kind === "error") return `WHERE COALESCE(${column("delivery_status")},'undelivered')='failed'`;
    if (kind === "ready") return `WHERE COALESCE(${column("delivery_status")},'undelivered')='undelivered' AND ${column("status")}='done'`;
    return `WHERE COALESCE(${column("delivery_status")},'undelivered')='undelivered' AND ${column("status")}<>'done'`;
}

/**
 * 充值队列列表。
 * delivery: undelivered（作业中，含提交失败）| error（仅人工标记失败）| delivered（已交付）| all
 */
export async function listRechargeQueue(delivery = "undelivered") {
    const kind = rechargeQueueDeliveryKind(delivery);
    const where = rechargeQueueWhere(kind, "rq");
    const { rows: list } = await query(
        `SELECT rq.id, rq.account_id, rq.email, rq.auth_file, rq.plan,
                rq.batch, rq.batch AS recharge_group, g.batch AS source_batch, m.grp AS mailbox_group,
                rq.card_id, rq.card_code, rq.status, rq.task_no, rq.task_status,
                rq.task_message, rq.error, rq.created_at, rq.plan_type,
                rq.submitted_at, rq.instance_id, rq.finished_at,
                rq.rebind_status, rq.rebind_email, rq.rebind_error, rq.rebind_target, rq.rebind_pool,
                rq.delivery_status, rq.delivered_at, rq.rebind_from, rq.rebind_attempt_email,
                rq.rebind_blocked_until, rq.rebind_instance, rq.rebind_attempt_stage
         FROM recharge_queue rq
         LEFT JOIN gpt_accounts g ON g.id=rq.account_id
         LEFT JOIN mailboxes m ON m.id=g.mailbox_id
         ${where}
         ORDER BY ${kind === "delivered" ? "rq.delivered_at DESC NULLS LAST, rq.id DESC" : kind === "error" ? "rq.finished_at DESC NULLS LAST, rq.id DESC" : "rq.id"}`,
    );
    const out = { pending: 0, paired: 0, submitting: 0, submitted: 0, done: 0, error: 0, total: 0, undelivered: 0, delivered: 0, failed: 0, working: 0, ready: 0 };
    const { rows: statsRows } = await query(
        `SELECT COALESCE(delivery_status,'undelivered') AS delivery_status,
                status, COUNT(*)::int AS n
         FROM recharge_queue
         GROUP BY COALESCE(delivery_status,'undelivered'), status`,
    );
    for (const row of statsRows) {
        if (row.delivery_status === "undelivered") {
            out[row.status] = row.n;
            out.total += row.n;
        } else if (row.delivery_status === "failed") {
            out.failed += row.n;
        } else if (row.delivery_status === "delivered") {
            out.delivered += row.n;
        }
    }
    out.undelivered = out.total;
    out.ready = out.done || 0;
    out.working = Math.max(0, out.undelivered - out.ready);
    return { list, stats: out, delivery: kind };
}

export async function getRechargeQueueItem(id) {
    const { rows } = await query(`SELECT * FROM recharge_queue WHERE id=$1`, [id]);
    return rows[0] || undefined;
}

export async function getRechargeQueueItems(ids) {
    const list = [...new Set((ids || []).map(Number).filter(Number.isInteger))];
    if (!list.length) return [];
    const {rows} = await query(
        `SELECT * FROM recharge_queue WHERE id = ANY($1::int[]) ORDER BY id`,
        [list],
    );
    return rows;
}

export async function listQueueSubmittedPending() {
    const { rows } = await query(
        `SELECT * FROM recharge_queue
         WHERE status IN ('submitting','submitted')
           AND COALESCE(delivery_status,'undelivered')<>'delivered'
           AND COALESCE(task_status,'') NOT IN ('paid','failed','canceled','returned')
         ORDER BY id`,
    );
    return rows;
}

export async function rechargeQueueBatches(delivery = "undelivered") {
    const kind = rechargeQueueDeliveryKind(delivery);
    const scope = rechargeQueueWhere(kind, "rq");
    const where = scope
        ? `rq.batch!='' AND ${scope.replace(/^WHERE\s+/, "")}`
        : `rq.batch!=''`;
    const { rows } = await query(
        `SELECT rq.batch AS name, COUNT(*)::int AS n FROM recharge_queue rq WHERE ${where} GROUP BY rq.batch ORDER BY MAX(rq.id) DESC`,
    );
    return rows;
}

export async function listRechargeQueueFull(ids?: number[], batch?: string, opts: {includeAuth?: boolean} = {}) {
    // 默认不带整份 auth_data/session。单条 session JSON 能到数 MB，全表会把 3100 打崩。
    const extra = opts.includeAuth
        ? `, g.auth_data AS gpt_auth_data, rq.auth_data, g.rt_data AS gpt_rt_data`
        : `, NULLIF(g.rt_data->>'refresh_token','') AS refresh_token`;
    let sql = `SELECT rq.id, rq.account_id, rq.email, rq.auth_file, rq.plan, rq.batch,
                      rq.status, rq.card_code, rq.delivery_status,
                      m.password, m.provider, m.totp_secret AS mailbox_totp,
                      m.imap_password AS mailbox_imap, m.imap_password,
                      g.gpt_password, g.totp_secret, g.rt_file,
                      g.auth_file AS gpt_auth_file
                      ${extra}
               FROM recharge_queue rq
               JOIN gpt_accounts g ON rq.account_id = g.id
               JOIN mailboxes m ON g.mailbox_id = m.id`;
    const conds: string[] = [], params: any[] = [];
    if (ids && ids.length) {
        const placeholders = ids.map((_, i) => `$${params.length + i + 1}`).join(",");
        conds.push(`rq.id IN (${placeholders})`);
        params.push(...ids);
    }
    if (batch) {
        conds.push(`rq.batch = $${params.length + 1}`);
        params.push(batch);
    }
    if (conds.length) sql += ` WHERE ${conds.join(" AND ")}`;
    sql += ` ORDER BY rq.id`;
    const { rows } = await query(sql, params);
    return rows;
}
