// @ts-nocheck
import {query} from "./database-context.js";

// ---- 日志 ----

export async function appendLog(id, line) {
    await query(`INSERT INTO logs(account_id,ts,line) VALUES($1,$2,$3)`, [id, Date.now(), line]);
}

export async function listLogs(id) {
    const { rows } = await query(`SELECT id,ts,line FROM logs WHERE account_id=$1 ORDER BY id`, [id]);
    return rows;
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

