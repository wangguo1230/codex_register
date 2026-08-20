// @ts-nocheck
import os from "node:os";
import {query, withAdvisoryLock, withTransaction} from "../pg.js";

export function resolveInstanceId({configured = process.env.INSTANCE_ID, hostname = os.hostname(), port = process.env.PORT || "3100"} = {}) {
    const explicit = String(configured || "").trim();
    if (explicit) return explicit;
    return `${String(hostname || "unknown").trim()}:${String(port || "3100").trim()}`;
}

// 同机实例按监听端口隔离；同一端口重启后标识稳定，可回收上次中断的工作。
export const instanceId = resolveInstanceId();

export {query, withAdvisoryLock, withTransaction};

// 兼容 JOIN：gpt_accounts + mailboxes 拼回原 accounts 形状。
export const ACC_COLS_LIST = `
  g.id AS id, m.email AS email, m.password AS password, g.status AS status,
  g.plan AS plan, g.auth_file AS auth_file, g.error AS error,
  (COALESCE(g.token, '') <> '') AS has_token,
  g.started_at AS started_at, g.finished_at AS finished_at, g.created_at AS created_at,
  g.phone AS phone, g.card AS card, g.at_status AS at_status, g.rt_status AS rt_status,
  g.chat_status AS chat_status, g.rt_file AS rt_file, g.dead_at AS dead_at, g.sold_at AS sold_at,
  m.pw_status AS pw_status, m.provider AS provider, g.batch AS batch, g.mailbox_id AS mailbox_id,
  m.recovery_email AS recovery_email, m.totp_secret AS mailbox_totp, m.imap_password AS mailbox_imap,
  g.gpt_password AS gpt_password, g.totp_secret AS totp_secret, g.mfa_status AS mfa_status,
  GREATEST(g.deleted_at, m.deleted_at) AS deleted_at`;

export const ACC_COLS_FULL = `
  g.id AS id, m.email AS email, m.password AS password, g.status AS status,
  g.plan AS plan, g.token AS token, g.auth_file AS auth_file, g.error AS error,
  (COALESCE(g.token, '') <> '') AS has_token,
  g.started_at AS started_at, g.finished_at AS finished_at, g.created_at AS created_at,
  g.phone AS phone, g.card AS card, g.at_status AS at_status, g.rt_status AS rt_status,
  g.chat_status AS chat_status, g.rt_file AS rt_file, g.dead_at AS dead_at, g.sold_at AS sold_at,
  m.pw_status AS pw_status, m.provider AS provider, g.batch AS batch, g.mailbox_id AS mailbox_id,
  m.recovery_email AS recovery_email, m.totp_secret AS mailbox_totp, m.imap_password AS mailbox_imap,
  g.gpt_password AS gpt_password, g.totp_secret AS totp_secret, g.mfa_status AS mfa_status,
  GREATEST(g.deleted_at, m.deleted_at) AS deleted_at,
  g.auth_data, g.rt_data`;

export const ACC_FROM = `FROM gpt_accounts g JOIN mailboxes m ON g.mailbox_id = m.id`;
export const ACC_ALIVE = `g.deleted_at=0 AND m.deleted_at=0`;
export const ACC_DELETED = `(g.deleted_at>0 OR m.deleted_at>0)`;

export const CLAUDE_COLS_LIST = `c.id, c.mailbox_id, c.status, c.session_key, c.org_id, c.auth_file, c.plan, c.claude_code, c.engine,
           c.batch, c.error, c.dead_at, c.sold_at, c.started_at, c.finished_at, c.created_at,
           m.email, m.password, m.provider, m.pw_status, m.grp`;
export const CLAUDE_COLS_FULL = `${CLAUDE_COLS_LIST}, c.auth_data`;

export const MAILBOX_FIELDS = ["email", "password", "pw_status", "recovery_email", "totp_secret", "totp_secret_orig", "imap_password"];
export const GPT_FIELDS = ["status", "plan", "phone", "card", "at_status", "rt_status", "chat_status", "error", "dead_at", "sold_at", "finished_at", "batch", "auth_file", "token", "rt_file", "engine", "auth_data", "rt_data", "gpt_password", "totp_secret", "mfa_status"];

export async function softDeleteMailbox(client, mailboxId) {
    if (!mailboxId) return;
    await client.query(`UPDATE mailboxes SET deleted_at=$1, usage='deleted' WHERE id=$2 AND deleted_at=0`, [Date.now(), mailboxId]);
}

export async function softDeleteGpt(client, gptId) {
    const {rows: [row]} = await client.query(`SELECT mailbox_id FROM gpt_accounts WHERE id=$1`, [gptId]);
    if (!row) return false;
    await client.query(`UPDATE gpt_accounts SET deleted_at=$1, instance_id='' WHERE id=$2 AND deleted_at=0`, [Date.now(), gptId]);
    await softDeleteMailbox(client, row.mailbox_id);
    return true;
}

export async function insertOrReviveGpt(client, mailboxId, batch, now) {
    await client.query(
        `INSERT INTO gpt_accounts(mailbox_id,status,batch,created_at) VALUES($1,'pending',$2,$3)
         ON CONFLICT(mailbox_id) DO UPDATE SET
            deleted_at=0, status='pending', batch=EXCLUDED.batch, created_at=EXCLUDED.created_at,
            token='', auth_file='', rt_file='', plan='', phone='', card='', engine='',
            at_status='', rt_status='', chat_status='', mfa_status='', error='',
            dead_at=0, sold_at=0, started_at=NULL, finished_at=NULL, instance_id='',
            auth_data=NULL, rt_data=NULL, gpt_password='', totp_secret=''
         WHERE gpt_accounts.deleted_at>0`,
        [mailboxId, batch, now],
    );
}
