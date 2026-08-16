import pg from "pg";
import {planHardenSkip, needsHardenRetry, formatHardenListReason, liveGoogleStage} from "../src/mail/google-state.ts";

const pool = new pg.Pool({connectionString: "postgresql://postgres:123456@192.168.1.126:5432/all_register"});
const email = "anonymoushacker19790@gmail.com";
const {rows: [mb]} = await pool.query(`SELECT * FROM mailboxes WHERE email=$1`, [email]);
if (!mb) { console.log("NOT_FOUND"); await pool.end(); process.exit(1); }
console.log(JSON.stringify({
    id: mb.id, stage: mb.google_stage, live: liveGoogleStage(mb),
    pw_status: mb.pw_status,
    totp: String(mb.totp_secret || "").length,
    imap: String(mb.imap_password || ""),
    imap_len: String(mb.imap_password || "").length,
    recovery: mb.recovery_email,
    google_state: mb.google_state,
    skip: planHardenSkip(mb),
    retry: needsHardenRetry(mb),
    reason: formatHardenListReason(mb),
}, null, 2));
const {rows: jobs} = await pool.query(
    `SELECT id, status, instance_id, left(coalesce(last_line,error,''), 220) AS line, created_at, claimed_at, finished_at
     FROM mail_jobs WHERE mailbox_id=$1 AND kind='harden' ORDER BY created_at DESC LIMIT 10`,
    [mb.id],
);
console.log("JOBS", JSON.stringify(jobs, null, 2));
const {rows: logs} = await pool.query(
    `SELECT left(coalesce(msg, line, message, detail, ''), 200) AS line, created_at
     FROM mailbox_logs WHERE mailbox_id=$1 OR email=$2 ORDER BY id DESC LIMIT 30`,
    [mb.id, email],
).catch(async () => {
    const cols = await pool.query(`SELECT column_name FROM information_schema.columns WHERE table_name='mailbox_logs'`);
    console.log("log_cols", cols.rows.map((r) => r.column_name));
    return {rows: []};
});
if (logs?.length) console.log("LOGS", JSON.stringify(logs, null, 2));
await pool.end();
