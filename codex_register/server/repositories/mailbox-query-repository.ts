// @ts-nocheck
import {query} from "./database-context.js";

// 列表页不拉 password_prev 和完整 google_state，避免大列表传输冗余 JSON。
const MAILBOX_LIST_COLS = `
    id, email, password, provider, usage, grp, pw_status, google_stage,
    totp_secret, totp_secret_orig, imap_password, recovery_email, sold_at, deleted_at, created_at, note,
    proxy_ip, proxy_fail, proxy_url,
    CASE
      WHEN google_state IS NULL OR google_state = '{}'::jsonb THEN NULL
      ELSE jsonb_build_object(
        'last_error', google_state->>'last_error',
        'login_error', google_state->>'login_error',
        'totp_rotated', google_state->'totp_rotated',
        'imap_gen_fail', google_state->'imap_gen_fail',
        'imap_next_try', google_state->'imap_next_try',
        'login', google_state->>'login',
        'phone', google_state->>'phone',
        'recovery', google_state->>'recovery',
        'totp', google_state->>'totp',
        'password', google_state->>'password',
        'devices', google_state->>'devices',
        'imap', google_state->>'imap',
        'gpt', google_state->>'gpt'
      )
    END AS google_state
`;

export async function listMailboxes(usage?) {
    const {liveGoogleStage} = await import("../../src/mail/google-state.ts");
    let rows;
    if (usage === "deleted") {
        ({rows} = await query(`SELECT ${MAILBOX_LIST_COLS} FROM mailboxes WHERE deleted_at>0 ORDER BY id`));
    } else if (usage) {
        ({rows} = await query(`SELECT ${MAILBOX_LIST_COLS} FROM mailboxes WHERE usage=$1 AND deleted_at=0 ORDER BY id`, [usage]));
    } else {
        ({rows} = await query(`SELECT ${MAILBOX_LIST_COLS} FROM mailboxes WHERE deleted_at=0 ORDER BY id`));
    }
    const {kookeeySessionOf} = await import("../../src/mail/proxy-pool.js");
    return rows.map((r) => {
        const proxy_session = kookeeySessionOf(r.proxy_url || "") || "";
        const {proxy_url: _drop, ...rest} = r;
        const row = {...rest, proxy_session, has_proxy: !!String(r.proxy_url || "").trim()};
        return r.provider === "google" ? {...row, google_stage: liveGoogleStage(r)} : row;
    });
}

export async function mailboxStats() {
    const out = { free: 0, hold: 0, gpt: 0, claude: 0, total: 0, deleted: 0 };
    const { rows } = await query(`SELECT usage, COUNT(*)::int AS n FROM mailboxes WHERE deleted_at=0 GROUP BY usage`);
    for (const row of rows) {
        if (out[row.usage] !== undefined) out[row.usage] = row.n;
        out.total += row.n;
    }
    const { rows: [del] } = await query(`SELECT COUNT(*)::int AS n FROM mailboxes WHERE deleted_at>0`);
    out.deleted = del?.n || 0;
    return out;
}

export async function getMailbox(id) {
    const { rows } = await query(`SELECT * FROM mailboxes WHERE id=$1`, [id]);
    return rows[0] || undefined;
}

export async function getMailboxes(ids) {
    const list = [...new Set((ids || []).map(Number).filter(Number.isInteger))];
    if (!list.length) return [];
    const {rows} = await query(`SELECT * FROM mailboxes WHERE id = ANY($1::int[]) ORDER BY id`, [list]);
    return rows;
}

export async function lookupMailboxesByEmails(emails) {
    const list = [...new Set((emails || []).map((e) => String(e || "").trim().toLowerCase()).filter(Boolean))];
    if (!list.length) return [];
    const { rows } = await query(`SELECT * FROM mailboxes WHERE LOWER(email) = ANY($1) ORDER BY deleted_at ASC, id`, [list]);
    return rows;
}

export async function getMailboxByEmail(email) {
    const { rows } = await query(`SELECT * FROM mailboxes WHERE email=$1 AND deleted_at=0`, [String(email).toLowerCase()]);
    return rows[0] || undefined;
}

/** 发信用：含已软删，优先活号。 */
export async function getMailboxByEmailAny(email) {
    const key = String(email || "").trim().toLowerCase();
    if (!key) return undefined;
    const { rows } = await query(
        `SELECT * FROM mailboxes
         WHERE lower(email)=$1
         ORDER BY CASE WHEN COALESCE(deleted_at,0)=0 THEN 0 ELSE 1 END, id DESC
         LIMIT 1`,
        [key],
    );
    return rows[0] || undefined;
}

export async function freeMailboxGroups() {
    const { rows } = await query(`SELECT grp, COUNT(*)::int AS n FROM mailboxes WHERE usage='free' AND deleted_at=0 GROUP BY grp ORDER BY grp`);
    return rows;
}
