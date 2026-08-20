// @ts-nocheck
import {query, withTransaction} from "./database-context.js";

export async function addToRechargeQueue(accountIds, batch = "") {
    const ids = [...new Set((accountIds || []).map(Number).filter(Number.isInteger))];
    if (!ids.length) return {added: 0, total: accountIds.length};
    const now = Date.now();
    return withTransaction(async (client) => {
        const {rows} = await client.query(
            `WITH inserted AS (
                INSERT INTO recharge_queue(account_id,email,auth_file,plan,batch,created_at,auth_data)
                SELECT g.id, m.email, COALESCE(g.auth_file,''), COALESCE(g.plan,''), $1, $2, g.auth_data
                FROM gpt_accounts g
                JOIN mailboxes m ON m.id=g.mailbox_id
                WHERE g.id = ANY($3)
                ON CONFLICT(account_id) DO NOTHING
                RETURNING account_id
             )
             UPDATE gpt_accounts g SET sold_at=$2
             FROM inserted i
             WHERE g.id=i.account_id
             RETURNING g.id`,
            [batch, now, ids],
        );
        return {added: rows.length, total: accountIds.length};
    });
}

/** 移出队列 = 标记已交付；保留队列行与换绑记录，不删 GPT/邮箱。 */
export async function removeFromRechargeQueue(ids) {
    return deliverRechargeQueue(ids);
}

/** 标记已交付并在同一事务删除已消耗的卡密池记录。 */
export async function deliverRechargeQueue(ids) {
    const list = [...new Set((ids || []).map(Number).filter(Number.isInteger))];
    if (!list.length) return { count: 0, skipped: 0, cardsRemoved: 0 };
    const now = Date.now();
    return withTransaction(async (client) => {
        const { rows: skipRows } = await client.query(
            `SELECT COUNT(*)::int AS n FROM recharge_queue
             WHERE id = ANY($1)
               AND COALESCE(delivery_status,'undelivered')<>'delivered'
               AND NOT (status='done' OR task_status='paid')`,
            [list],
        );
        const { rows: delivered } = await client.query(
            `UPDATE recharge_queue
             SET delivery_status='delivered',
                 delivered_at=CASE WHEN COALESCE(delivered_at,0)>0 THEN delivered_at ELSE $1 END,
                 instance_id=''
             WHERE id = ANY($2)
               AND COALESCE(delivery_status,'undelivered')<>'delivered'
               AND (status='done' OR task_status='paid')
             RETURNING id`,
            [now, list],
        );
        let cardsRemoved = 0;
        if (delivered.length) {
            // 只按 card_id 关联；换绑后队列邮箱与卡密原账号邮箱可能不同。
            const res = await client.query(
                `DELETE FROM recharge_cards c
                 USING recharge_queue q
                 WHERE q.id = ANY($1)
                   AND c.id = q.card_id
                   AND c.status = 'done'
                   AND c.account_id = q.account_id`,
                [delivered.map((r) => Number(r.id))],
            );
            cardsRemoved = res.rowCount || 0;
        }
        return { count: delivered.length, skipped: Number(skipRows[0]?.n || 0), cardsRemoved };
    });
}

/** 已交付误点恢复；已消耗的卡密不会恢复。 */
export async function undeliverRechargeQueue(ids) {
    const list = [...new Set((ids || []).map(Number).filter(Number.isInteger))];
    if (!list.length) return { count: 0 };
    const { rowCount } = await query(
        `UPDATE recharge_queue
         SET delivery_status='undelivered', delivered_at=0
         WHERE id = ANY($1)
           AND COALESCE(delivery_status,'undelivered')='delivered'`,
        [list],
    );
    return { count: rowCount || 0 };
}

export async function setRechargeQueueBatch(ids, batch) {
    const list = [...new Set((ids || []).map(Number).filter(Number.isInteger))];
    if (!list.length) return;
    await query(`UPDATE recharge_queue SET batch=$1 WHERE id = ANY($2)`, [batch, list]);
}
