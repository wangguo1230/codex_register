import pg from "pg";
import {planHardenSkip, needsHardenRetry} from "../src/mail/google-state.ts";

const pool = new pg.Pool({connectionString: "postgresql://postgres:123456@192.168.1.126:5432/all_register"});
const {rows} = await pool.query(
    `SELECT id, email, google_stage, google_state, totp_secret, imap_password, recovery_email, pw_status, provider
     FROM mailboxes WHERE deleted_at=0 AND grp=$1`,
    ["8 月 15 日 200"],
);
const ids = rows.map((m) => m.id);
const {rows: latest} = await pool.query(
    `SELECT DISTINCT ON (mailbox_id) mailbox_id, status, last_line
     FROM mail_jobs WHERE mailbox_id = ANY($1) AND kind='harden'
     ORDER BY mailbox_id, created_at DESC`,
    [ids],
);
const {rows: ever} = await pool.query(
    `SELECT mailbox_id,
            COUNT(*) FILTER (WHERE last_line ILIKE '%缺IMAP%' OR last_line ILIKE '%应用专用密码%' OR last_line ILIKE '%拒绝生成%')::int apppw,
            COUNT(*) FILTER (WHERE last_line ILIKE '%已停止%')::int stopped,
            COUNT(*) FILTER (WHERE last_line ILIKE '%换 session%' OR last_line ILIKE '%拒绝页%')::int rotate
     FROM mail_jobs WHERE mailbox_id = ANY($1) AND kind='harden'
     GROUP BY 1`,
    [ids],
);
const byL = Object.fromEntries(latest.map((j) => [j.mailbox_id, j]));
const byE = Object.fromEntries(ever.map((j) => [j.mailbox_id, j]));

let totpNoImap = 0;
let totpNoImapRetry = 0;
let lastApppw = 0;
let lastStopped = 0;
let everApppw = 0;
let everStopped = 0;
let ready = 0;
let loginDead = 0;
const totpNoImapEmails = [];
const lastApppwEmails = [];

for (const m of rows) {
    const st = m.google_state && typeof m.google_state === "object" ? m.google_state : {};
    const skip = planHardenSkip(m);
    if (skip.usable) ready += 1;
    if (st.login === "fail" || m.google_stage === "blocked" || m.google_stage === "login_fail") loginDead += 1;
    const logged = st.login === "ok" || st.totp_rotated || m.google_stage === "partial" || m.google_stage === "ready";
    const onlyImap = logged && st.totp_rotated && !String(m.imap_password || "").trim();
    if (onlyImap) {
        totpNoImap += 1;
        if (needsHardenRetry(m)) {
            totpNoImapRetry += 1;
            if (totpNoImapEmails.length < 12) totpNoImapEmails.push(m.email);
        }
    }
    const line = String(byL[m.id]?.last_line || "");
    if (/缺IMAP|应用专用密码|拒绝生成/i.test(line)) {
        lastApppw += 1;
        if (lastApppwEmails.length < 10) lastApppwEmails.push(m.email);
    }
    if (/已停止/.test(line)) lastStopped += 1;
    if ((byE[m.id]?.apppw || 0) > 0) everApppw += 1;
    if ((byE[m.id]?.stopped || 0) > 0) everStopped += 1;
}

console.log(JSON.stringify({
    total: rows.length,
    ready_2fa_imap: ready,
    login_dead: loginDead,
    totp_ok_no_imap: totpNoImap,
    totp_ok_no_imap_still_retry: totpNoImapRetry,
    last_job_apppw: lastApppw,
    last_job_stopped: lastStopped,
    ever_hit_apppw: everApppw,
    ever_hit_stopped: everStopped,
    totpNoImapEmails,
    lastApppwEmails,
}, null, 2));
await pool.end();
