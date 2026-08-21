// @ts-nocheck
import {query, withTransaction} from "./database-context.js";

// ---- 日志 ----

const ACCOUNT_LOG_MAX_ENTRIES = Math.max(100, Math.min(10_000, Number(process.env.ACCOUNT_LOG_MAX_ENTRIES || 5_000) || 5_000));
const OPERATION_LOG_MAX_ENTRIES = Math.max(5_000, Math.min(100_000, Number(process.env.OPERATION_LOG_MAX_ENTRIES || 50_000) || 50_000));

export async function appendLog(id, line) {
    await withTransaction(async (client) => {
        await client.query(`SELECT pg_advisory_xact_lock(hashtext($1)::bigint)`, [`codex:account-log:${Number(id)}`]);
        await client.query(`INSERT INTO logs(account_id,ts,line) VALUES($1,$2,$3)`, [id, Date.now(), line]);
        await client.query(
            `DELETE FROM logs WHERE id IN (
                SELECT id FROM logs WHERE account_id=$1 ORDER BY id DESC OFFSET $2
            )`,
            [id, ACCOUNT_LOG_MAX_ENTRIES],
        );
    });
}

export async function listLogs(id, limit = ACCOUNT_LOG_MAX_ENTRIES) {
    const safeLimit = Math.max(1, Math.min(10_000, Number(limit) || ACCOUNT_LOG_MAX_ENTRIES));
    const { rows } = await query(
        `SELECT id,ts,line FROM logs WHERE account_id=$1 ORDER BY id DESC LIMIT $2`,
        [id, safeLimit],
    );
    return rows.reverse();
}

export async function appendOperationLog({instanceId = "", scope = "recharge", accountId = null, line, ts = Date.now()} = {}) {
    const logScope = String(scope || "recharge");
    await withTransaction(async (client) => {
        await client.query(`SELECT pg_advisory_xact_lock(hashtext($1)::bigint)`, [`codex:operation-log:${logScope}`]);
        await client.query(
            `INSERT INTO operation_logs(ts,instance_id,scope,account_id,line) VALUES($1,$2,$3,$4,$5)`,
            [ts, String(instanceId || ""), logScope, accountId !== null && accountId !== undefined && Number.isInteger(Number(accountId)) && Number(accountId) > 0 ? Number(accountId) : null, String(line || "")],
        );
        await client.query(
            `DELETE FROM operation_logs WHERE id IN (
                SELECT id FROM operation_logs WHERE scope=$1 ORDER BY id DESC OFFSET $2
            )`,
            [logScope, OPERATION_LOG_MAX_ENTRIES],
        );
    });
}

export async function listOperationLogs({scope = "recharge", accountId = null, limit = 2000} = {}) {
    const values = [String(scope || "recharge")];
    const clauses = ["scope=$1"];
    if (accountId !== null && accountId !== undefined && Number.isInteger(Number(accountId)) && Number(accountId) > 0) {
        values.push(Number(accountId));
        clauses.push(`account_id=$${values.length}`);
    }
    values.push(Math.max(1, Math.min(10_000, Number(limit) || 2000)));
    const {rows} = await query(
        `SELECT id,ts,instance_id,scope,account_id,line FROM operation_logs WHERE ${clauses.join(" AND ")} ORDER BY id DESC LIMIT $${values.length}`,
        values,
    );
    return rows.reverse();
}

export async function clearOperationLogs(scope = "recharge") {
    await query(`DELETE FROM operation_logs WHERE scope=$1`, [String(scope || "recharge")]);
}

export async function appendMailboxLog(mailboxId, line) {
    await query(`INSERT INTO mailbox_logs(mailbox_id,ts,line) VALUES($1,$2,$3)`, [mailboxId, Date.now(), line]);
}

export async function listMailboxLogs(mailboxId) {
    const { rows } = await query(`SELECT id,ts,line FROM mailbox_logs WHERE mailbox_id=$1 ORDER BY id`, [mailboxId]);
    return rows;
}

export async function appendClaudeLog(claudeId, line) {
    await query(`INSERT INTO claude_logs(claude_id,ts,line) VALUES($1,$2,$3)`, [claudeId, Date.now(), line]);
}

export async function listClaudeLogs(claudeId) {
    const { rows } = await query(`SELECT id,ts,line FROM claude_logs WHERE claude_id=$1 ORDER BY id`, [claudeId]);
    return rows;
}

