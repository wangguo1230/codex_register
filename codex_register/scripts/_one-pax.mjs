import pg from "pg";
import {planHardenSkip, needsHardenRetry, formatHardenListReason, liveGoogleStage} from "../src/mail/google-state.ts";

const pool = new pg.Pool({connectionString: "postgresql://postgres:123456@192.168.1.126:5432/all_register"});
const email = "paxmofit@gmail.com";
const {rows: [mb]} = await pool.query(`SELECT * FROM mailboxes WHERE email=$1`, [email]);
if (!mb) { console.log("NOT_FOUND"); await pool.end(); process.exit(1); }
console.log(JSON.stringify({
    id: mb.id, grp: mb.grp,
    stage: mb.google_stage,
    live: liveGoogleStage(mb),
    pw_status: mb.pw_status,
    totp: String(mb.totp_secret || "").length,
    imap_len: String(mb.imap_password || "").length,
    imap: mb.imap_password ? String(mb.imap_password).slice(0, 4) + "****" : "",
    recovery: mb.recovery_email,
    password_len: String(mb.password || "").length,
    google_state: mb.google_state,
    skip: planHardenSkip(mb),
    retry: needsHardenRetry(mb),
    reason: formatHardenListReason(mb),
}, null, 2));
const {rows: jobs} = await pool.query(
    `SELECT status, instance_id, left(coalesce(last_line,error,''), 220) AS line, created_at, finished_at
     FROM mail_jobs WHERE mailbox_id=$1 AND kind='harden' ORDER BY created_at DESC LIMIT 8`,
    [mb.id],
);
console.log("JOBS", JSON.stringify(jobs, null, 2));
const {rows: logs} = await pool.query(
    `SELECT ts, left(line, 180) AS line FROM mailbox_logs WHERE mailbox_id=$1 ORDER BY id DESC LIMIT 25`,
    [mb.id],
);
console.log("LOGS", JSON.stringify(logs, null, 2));
await pool.end();
