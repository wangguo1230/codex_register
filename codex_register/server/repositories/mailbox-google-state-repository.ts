// @ts-nocheck
import {instanceId, query} from "./database-context.js";

const MAILBOX_WORK_LOCK_TTL_MS = 20 * 60_000;

export async function claimMailboxWorkLock(mailboxId, instId = instanceId, ttlMs = MAILBOX_WORK_LOCK_TTL_MS) {
    const id = Number(mailboxId);
    if (!Number.isInteger(id) || id <= 0) return false;
    const now = Date.now();
    const {rowCount} = await query(
        `UPDATE mailboxes
         SET job_lock_instance=$2, job_lock_at=$3
         WHERE id=$1 AND (
           COALESCE(job_lock_instance,'')='' OR COALESCE(job_lock_at,0) < $4 OR job_lock_instance=$2
         )`,
        [id, instId, now, now - ttlMs],
    );
    return (rowCount || 0) > 0;
}

export async function touchMailboxWorkLock(mailboxId, instId = instanceId) {
    await query(
        `UPDATE mailboxes SET job_lock_at=$3 WHERE id=$1 AND job_lock_instance=$2`,
        [mailboxId, instId, Date.now()],
    );
}

export async function releaseMailboxWorkLock(mailboxId, instId = instanceId) {
    await query(
        `UPDATE mailboxes SET job_lock_instance='', job_lock_at=0 WHERE id=$1 AND job_lock_instance=$2`,
        [mailboxId, instId],
    );
}

export async function withMailboxWorkLock(mailboxId, fn, instId = instanceId) {
    const got = await claimMailboxWorkLock(mailboxId, instId);
    if (!got) {
        return {ok: false, skipped: true, locked: true, error: "该邮箱正在被其他实例整备，跳过以免覆盖 2FA"};
    }
    const timer = setInterval(() => { touchMailboxWorkLock(mailboxId, instId).catch(() => {}); }, 60_000);
    try {
        return await fn();
    } finally {
        clearInterval(timer);
        await releaseMailboxWorkLock(mailboxId, instId);
    }
}

/** 只有本轮在 Google 上验证过的新密钥才能覆盖 totp_secret。跳过/旧值/并发败者写不进去。 */
export async function commitRotatedTotp(id, nextSecret, previousSecret = "") {
    const {normalizeTotpSecret, looksLikeTotpSecret} = await import("../../src/mfa.js");
    const next = normalizeTotpSecret(nextSecret);
    if (!looksLikeTotpSecret(next)) return {ok: false, reason: "invalid"};
    const prev = normalizeTotpSecret(previousSecret);
    const {rows} = await query(
        `SELECT totp_secret, COALESCE(google_state->>'totp_rotated','') AS rotated FROM mailboxes WHERE id=$1`,
        [id],
    );
    if (!rows[0]) return {ok: false, reason: "missing"};
    const cur = normalizeTotpSecret(rows[0].totp_secret);
    if (cur === next) {
        await refreshMailboxGoogleState(id, {totp: "ok", totp_rotated: true}).catch(() => {});
        return {ok: true, unchanged: true, totp: next};
    }
    const {rowCount} = await query(
        `UPDATE mailboxes SET
            totp_secret_orig=CASE
              WHEN COALESCE(totp_secret_orig,'')<>'' THEN totp_secret_orig
              WHEN COALESCE(totp_secret,'')<>'' AND totp_secret IS DISTINCT FROM $1 THEN totp_secret
              ELSE totp_secret_orig
            END,
            totp_secret=$1
         WHERE id=$2 AND (
           COALESCE(totp_secret,'')=''
           OR totp_secret=$1
           OR totp_secret=$3
           OR COALESCE(google_state->>'totp_rotated','') <> 'true'
         )`,
        [next, id, prev || ""],
    );
    if (!rowCount) return {ok: false, reason: "stale", kept: cur};
    await refreshMailboxGoogleState(id, {totp: "ok", totp_rotated: true}).catch(() => {});
    return {ok: true, totp: next};
}

/** 导入/字段对调：已换过 2FA 或库里已是合法密钥时不覆盖。 */
export async function importMailboxTotp(id, incoming) {
    const {normalizeTotpSecret, looksLikeTotpSecret, looksLikeEmail} = await import("../../src/mfa.js");
    const next = normalizeTotpSecret(incoming);
    const {rows} = await query(
        `SELECT totp_secret, COALESCE(google_state->>'totp_rotated','') AS rotated FROM mailboxes WHERE id=$1`,
        [id],
    );
    if (!rows[0]) return {ok: false, reason: "missing"};
    const curRaw = String(rows[0].totp_secret || "").trim();
    const cur = normalizeTotpSecret(curRaw);
    if (rows[0].rotated === "true" && looksLikeTotpSecret(cur)) {
        return {ok: true, skipped: true, kept: cur};
    }
    if (looksLikeTotpSecret(cur) && looksLikeTotpSecret(next) && cur !== next) {
        return {ok: true, skipped: true, kept: cur};
    }
    if (!next) return {ok: true, skipped: true};
    if (looksLikeTotpSecret(cur) && !looksLikeEmail(curRaw)) {
        return {ok: true, skipped: true, kept: cur};
    }
    await query(
        `UPDATE mailboxes SET
            totp_secret=$1,
            totp_secret_orig=CASE WHEN COALESCE(totp_secret_orig,'')<>'' THEN totp_secret_orig ELSE $1 END
         WHERE id=$2`,
        [next, id],
    );
    return {ok: true, totp: next};
}

export async function setMailboxTotp(id, totpSecret, previousSecret = "") {
    return commitRotatedTotp(id, totpSecret, previousSecret);
}

export async function setMailboxImapPassword(id, imapPassword) {
    await query(`UPDATE mailboxes SET imap_password=$1 WHERE id=$2`, [imapPassword || "", id]);
    await refreshMailboxGoogleState(id).catch(() => {});
}

export async function applyMailboxUpdate(email, patch = {}) {
    const em = String(email || "").trim().toLowerCase();
    if (!em) return {ok: false};
    const sets = [];
    const vals = [];
    if (patch.password != null) { sets.push(`password=$${sets.length + 1}`); vals.push(patch.password); }
    if (patch.totp_secret != null) {
        const {rows: [row]} = await query(`SELECT * FROM mailboxes WHERE email=$1 AND deleted_at=0`, [em]);
        if (row?.id) await importMailboxTotp(row.id, patch.totp_secret);
    }
    if (patch.imap_password != null) { sets.push(`imap_password=$${sets.length + 1}`); vals.push(patch.imap_password); }
    if (patch.recovery_email != null) { sets.push(`recovery_email=$${sets.length + 1}`); vals.push(patch.recovery_email); }
    if (sets.length) {
        vals.push(em);
        await query(`UPDATE mailboxes SET ${sets.join(", ")} WHERE email=$${vals.length} AND deleted_at=0`, vals);
    }
    if (patch.google_overlay || sets.length) {
        await refreshMailboxGoogleState(em, patch.google_overlay || {});
    }
    return {ok: true};
}

export async function refreshMailboxGoogleState(emailOrId, overlay = {}) {
    const {deriveGoogleState} = await import("../../src/mail/google-state.ts");
    const key = emailOrId;
    const {rows} = typeof key === "number"
        ? await query(
            `SELECT m.*, g.status AS gpt_status, g.error AS gpt_error
             FROM mailboxes m LEFT JOIN gpt_accounts g ON g.mailbox_id=m.id AND g.deleted_at=0
             WHERE m.id=$1`,
            [key],
        )
        : await query(
            `SELECT m.*, g.status AS gpt_status, g.error AS gpt_error
             FROM mailboxes m LEFT JOIN gpt_accounts g ON g.mailbox_id=m.id AND g.deleted_at=0
             WHERE m.email=$1 AND m.deleted_at=0`,
            [String(key).trim().toLowerCase()],
        );
    const mb = rows[0];
    if (!mb || mb.provider !== "google") return {ok: false};
    const state = deriveGoogleState(mb, overlay);
    await query(
        `UPDATE mailboxes SET google_state=$1::jsonb, google_stage=$2 WHERE id=$3`,
        [JSON.stringify(state), state.stage, mb.id],
    );
    return {ok: true, state, id: mb.id};
}
