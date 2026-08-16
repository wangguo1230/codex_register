import pg from "pg";
import {isHardenIpError, isHardenLoginDead, deriveGoogleState, needsHardenRetry} from "../src/mail/google-state.ts";

const pool = new pg.Pool({connectionString: "postgresql://postgres:123456@192.168.1.126:5432/all_register"});
const rows = (await pool.query(
    `SELECT m.id, m.email, m.google_state, m.google_stage, m.totp_secret, m.imap_password, m.recovery_email, m.pw_status, m.provider,
            j.last_line
     FROM mailboxes m
     LEFT JOIN LATERAL (
       SELECT last_line FROM mail_jobs
       WHERE mailbox_id=m.id AND kind='harden' AND status='error'
       ORDER BY created_at DESC LIMIT 1
     ) j ON true
     WHERE m.deleted_at=0 AND m.grp=$1`,
    ["8 月 15 日 200"],
)).rows;

let fixed = 0;
for (const m of rows) {
    const st = m.google_state && typeof m.google_state === "object" ? m.google_state : {};
    const line = String(m.last_line || st.last_error || "");
    if (st.login !== "fail") continue;
    if (isHardenLoginDead(line)) continue;
    if (!isHardenIpError(line)) continue;
    const overlay = {login: "unknown", login_error: "", proxy_rotates: 0, last_error: line.slice(0, 160)};
    const next = deriveGoogleState({...m, google_state: {...st, login: "unknown"}}, overlay);
    next.login = "unknown";
    next.login_error = "";
    next.stage = next.totp_rotated && String(m.imap_password || "") ? "partial" : "imported";
    await pool.query(`UPDATE mailboxes SET google_state=$1::jsonb, google_stage=$2, proxy_url='', proxy_ip='' WHERE id=$3`, [next, next.stage, m.id]);
    fixed += 1;
}
const after = (await pool.query(
    `SELECT id, email, google_state, google_stage, totp_secret, imap_password, recovery_email, pw_status, provider
     FROM mailboxes WHERE deleted_at=0 AND grp=$1`,
    ["8 月 15 日 200"],
)).rows;
const retry = after.filter((m) => needsHardenRetry(m));
const dead = after.filter((m) => m.google_state?.login === "fail" || m.google_stage === "login_fail");
console.log(JSON.stringify({
    fixed, retry: retry.length, dead: dead.length,
    retry_emails: retry.map((m) => m.email),
    dead_n: dead.length,
}));
await pool.end();
