// @ts-nocheck
import {instanceId, query, withTransaction} from "./database-context.js";
import {
    releaseRechargeQueueByInstance,
} from "./recharge-queue-lease-repository.js";
import {releaseWorkTasksByOwner} from "./work-task-repository.js";

async function parkRebindWork(client, {instId, reason}) {
    const owner = instId === null ? null : String(instId || "").trim();
    if (instId !== null && !owner) throw new Error("换绑停放缺少实例标识");
    const scope = (alias) => owner === null
        ? `COALESCE(${alias}.rebind_instance,'')<>''`
        : `${alias}.rebind_instance=$1`;
    const scopeParams = owner === null ? [] : [owner];
    const message = String(reason || "实例在 verify 阶段退出，状态待核对").slice(0, 180);
    const reasonIndex = scopeParams.length + 1;

    const {rows: unknownRows} = await client.query(
        `UPDATE recharge_queue rq SET
            rebind_status='unknown',
            rebind_error=$${reasonIndex}
         WHERE ${scope("rq")} AND rq.rebind_status='pending' AND rq.rebind_attempt_stage='verify'
         RETURNING rq.id`,
        [...scopeParams, message],
    );
    const {rows: releasedMailboxes} = await client.query(
        `UPDATE mailboxes m SET usage='hold', claimed_at=0
         FROM recharge_queue rq
         WHERE ${scope("rq")}
           AND rq.rebind_status='pending'
           AND COALESCE(rq.rebind_attempt_stage,'')<>'verify'
           AND rq.rebind_attempt_mailbox_id=m.id
           AND m.usage='gpt'
           AND COALESCE(m.sold_at,0)=0
           AND NOT EXISTS (SELECT 1 FROM gpt_accounts g WHERE g.mailbox_id=m.id AND COALESCE(g.deleted_at,0)=0)
         RETURNING m.id`,
        scopeParams,
    );
    const {rows: releasedRows} = await client.query(
        `UPDATE recharge_queue rq SET rebind_instance='' WHERE ${scope("rq")} RETURNING rq.id`,
        scopeParams,
    );
    return {
        unknown: unknownRows.length,
        mailboxes: releasedMailboxes.length,
        leases: releasedRows.length,
    };
}

/** 中止本实例换绑：verify 后保留目标邮箱待对账，verify 前安全归还，再释放执行租约。 */
export async function parkRebindWorkByInstance(instId = instanceId, reason = "实例在 verify 阶段退出，状态待核对") {
    return withTransaction((client) => parkRebindWork(client, {instId, reason}));
}

/** 进程退出时只释放本实例认领的各领域工作。 */
export async function releaseInstanceWork(instId = instanceId) {
    const gpt = await query(`UPDATE gpt_accounts SET status='pending', error='', started_at=NULL, finished_at=NULL, instance_id='' WHERE status='running' AND instance_id=$1 RETURNING id`, [instId]);
    const claude = await query(`UPDATE claude_accounts SET status='pending', error='', started_at=NULL, finished_at=NULL, instance_id='' WHERE status='running' AND instance_id=$1 RETURNING id`, [instId]);
    const sms = await query(`UPDATE sms_pool SET status='free', bound_email='', claimed_by='' WHERE status='claimed' AND claimed_by=$1 RETURNING id`, [instId]);
    const password = await query(`UPDATE pw_queue SET status='pending', instance_id='' WHERE status='running' AND instance_id=$1 RETURNING id`, [instId]);
    const mail = await query(`UPDATE mail_jobs SET status='pending', instance_id='', last_line='实例退出，退回排队' WHERE status='running' AND instance_id=$1 RETURNING id`, [instId]);
    const recharge = await releaseRechargeQueueByInstance(instId);
    const tasks = await releaseWorkTasksByOwner(instId);
    return {
        gpt: gpt.rowCount || 0,
        claude: claude.rowCount || 0,
        sms: sms.rowCount || 0,
        pw: password.rowCount || 0,
        mail: mail.rowCount || 0,
        recharge,
        tasks,
    };
}
