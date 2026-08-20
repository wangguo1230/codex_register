// @ts-nocheck
import {query, withTransaction} from "./database-context.js";
import {REBIND_GMAIL_POOL_GRP} from "./gmail-rebind-mailbox-scope.js";
import {refreshMailboxGoogleState} from "./mailbox-google-state-repository.js";

export async function markRebindGmailUnavailable(ids, reason = "登录不可用") {
    const list = [...new Set((ids || []).map(Number).filter(Number.isInteger))];
    if (!list.length) return 0;
    let count = 0;
    for (const id of list) {
        const hit = await quarantineMailbox(id, reason);
        if (!hit) continue;
        try {
            await refreshMailboxGoogleState(id, {
                login: "fail",
                stage: "login_fail",
                last_error: String(reason || "登录不可用").slice(0, 120),
            });
        } catch { /* stage 写失败不影响踢出池 */ }
        count += 1;
    }
    return count;
}

export async function markMailboxSold(id, note = "") {
    const mailboxId = Number(id);
    if (!Number.isInteger(mailboxId)) return 0;
    const {rowCount} = await query(
        `UPDATE mailboxes
         SET sold_at=CASE WHEN sold_at>0 THEN sold_at ELSE $1 END,
             note=CASE WHEN $3='' THEN note ELSE $3 END,
             grp=CASE WHEN COALESCE(grp,'')=$4 THEN '' ELSE grp END
         WHERE id=$2 AND deleted_at=0`,
        [Date.now(), mailboxId, String(note || "").slice(0, 80), REBIND_GMAIL_POOL_GRP],
    );
    return rowCount || 0;
}

export async function quarantineMailbox(id, reason = "") {
    const mailboxId = Number(id);
    if (!Number.isInteger(mailboxId)) return 0;
    const {rowCount} = await query(
        `UPDATE mailboxes SET usage='hold',
            sold_at=CASE WHEN sold_at>0 THEN sold_at ELSE $1 END,
            note=$2,
            grp=CASE WHEN COALESCE(grp,'')=$3 THEN '' ELSE grp END
         WHERE id=$4 AND deleted_at=0`,
        [Date.now(), String(reason || "官方已占用").slice(0, 80), REBIND_GMAIL_POOL_GRP, mailboxId],
    );
    return rowCount || 0;
}

export async function releaseMailboxToFree(id) {
    const mailboxId = Number(id);
    if (!Number.isInteger(mailboxId)) return 0;
    const {rowCount} = await query(
        `UPDATE mailboxes SET usage='hold', claimed_at=0 WHERE id=$1 AND deleted_at=0 AND usage='gpt'`,
        [mailboxId],
    );
    return rowCount || 0;
}

export async function setMailboxNote(id, note = "") {
    const mailboxId = Number(id);
    if (!Number.isInteger(mailboxId)) return 0;
    const {rowCount} = await query(
        `UPDATE mailboxes SET note=$1 WHERE id=$2 AND deleted_at=0`,
        [String(note || "").slice(0, 80), mailboxId],
    );
    return rowCount || 0;
}

async function rebindGptMailboxInTransaction(client, gptId, newMailboxId) {
        const {rows: [gpt]} = await client.query(
            `SELECT id, mailbox_id FROM gpt_accounts WHERE id=$1 FOR UPDATE`,
            [gptId],
        );
        if (!gpt) throw new Error("GPT 账号不存在");
        const {rows: [mailbox]} = await client.query(
            `SELECT id, email FROM mailboxes WHERE id=$1 AND deleted_at=0 FOR UPDATE`,
            [newMailboxId],
        );
        if (!mailbox) throw new Error("目标邮箱不存在");
        if (gpt.mailbox_id === newMailboxId) return {oldMailboxId: gpt.mailbox_id, newMailboxId, email: mailbox.email};
        const {rows: [taken]} = await client.query(
            `SELECT id FROM gpt_accounts WHERE mailbox_id=$1 AND id<>$2`,
            [newMailboxId, gptId],
        );
        if (taken) throw new Error("目标邮箱已被其他 GPT 占用");
        const oldMailboxId = gpt.mailbox_id;
        const now = Date.now();
        await client.query(
            `UPDATE gpt_accounts SET mailbox_id=$1, sold_at=CASE WHEN sold_at>0 THEN sold_at ELSE $2 END WHERE id=$3`,
            [newMailboxId, now, gptId],
        );
        await client.query(
            `UPDATE mailboxes SET usage='gpt',
                sold_at=CASE WHEN sold_at>0 THEN sold_at ELSE $2 END,
                grp=CASE WHEN COALESCE(grp,'')=$3 THEN '' ELSE grp END
             WHERE id=$1`,
            [newMailboxId, now, REBIND_GMAIL_POOL_GRP],
        );
        if (oldMailboxId && oldMailboxId !== newMailboxId) {
            await client.query(
                `UPDATE mailboxes SET usage='hold',
                    sold_at=CASE WHEN sold_at>0 THEN sold_at ELSE $1 END,
                    grp=CASE WHEN COALESCE(grp,'')=$3 THEN '' ELSE grp END
                 WHERE id=$2 AND deleted_at=0`,
                [now, oldMailboxId, REBIND_GMAIL_POOL_GRP],
            );
        }
        return {oldMailboxId, newMailboxId, email: mailbox.email};
}

/** 官方换绑成功后，在同一事务中切换账号邮箱指针并封存旧邮箱。 */
export async function rebindGptMailbox(gptId, newMailboxId) {
    return withTransaction((client) => rebindGptMailboxInTransaction(client, gptId, newMailboxId));
}

/**
 * 官方换绑成功的本地提交点。账号邮箱指针、邮箱占用状态和充值队列终态必须原子落库，
 * 避免账号已经换绑但目标邮箱被补偿回空闲池。
 */
export async function completeGmailRebind(queueId, gptId, newMailboxId, {
    fromEmail = "",
    destination = "gmail",
} = {}, instId = "") {
    return withTransaction(async (client) => {
        const {rows: [queueItem]} = await client.query(
            `SELECT id, account_id, rebind_status, rebind_instance
             FROM recharge_queue WHERE id=$1 FOR UPDATE`,
            [Number(queueId)],
        );
        if (!queueItem) throw new Error("充值队列项不存在");
        if (Number(queueItem.account_id) !== Number(gptId)) throw new Error("换绑队列账号不匹配");
        if (!["pending", "unknown"].includes(String(queueItem.rebind_status || ""))) {
            throw new Error(`换绑队列状态不可提交: ${queueItem.rebind_status || "空"}`);
        }
        if (instId && String(queueItem.rebind_instance || "") !== String(instId)) {
            throw new Error("换绑执行认领已失效");
        }

        const rebound = await rebindGptMailboxInTransaction(client, Number(gptId), Number(newMailboxId));
        const email = String(rebound.email || "").trim().toLowerCase();
        await client.query(
            `UPDATE recharge_queue SET
                email=$1, rebind_status='ok', rebind_email=$1, rebind_from=$2,
                rebind_error='', rebind_target=$3,
                rebind_attempt_email='', rebind_attempt_mailbox_id=0,
                rebind_attempt_at=0, rebind_attempt_stage=''
             WHERE id=$4`,
            [email, String(fromEmail || "").trim(), String(destination || "gmail"), Number(queueId)],
        );
        return {...rebound, queueId: Number(queueId)};
    });
}
