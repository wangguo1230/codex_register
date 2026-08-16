import pg from "pg";
import {planHardenSkip, needsHardenRetry, deriveGoogleState} from "../src/mail/google-state.ts";

const pool = new pg.Pool({connectionString: "postgresql://postgres:123456@192.168.1.126:5432/all_register"});
const email = "akunnimobaru7@gmail.com";
const {rows: [mb]} = await pool.query(`SELECT * FROM mailboxes WHERE email=$1`, [email]);
if (!mb) {
    console.log("NOT_FOUND");
    await pool.end();
    process.exit(1);
}
const skip = planHardenSkip(mb);
const retry = needsHardenRetry(mb);
const derived = deriveGoogleState(mb, {});
console.log("MB", JSON.stringify({
    id: mb.id, grp: mb.grp, stage: mb.google_stage, derived_stage: derived.stage,
    pw_status: mb.pw_status,
    totp: !!mb.totp_secret, totp_len: String(mb.totp_secret || "").length,
    imap: !!mb.imap_password, imap_len: String(mb.imap_password || "").length,
    recovery: mb.recovery_email, proxy_ip: mb.proxy_ip,
    google_state: mb.google_state,
    skip, retry,
}, null, 2));
const {rows: jobs} = await pool.query(
    `SELECT status, instance_id, left(coalesce(last_line,error,''), 220) AS line, created_at, finished_at
     FROM mail_jobs WHERE mailbox_id=$1 AND kind='harden' ORDER BY created_at DESC LIMIT 20`,
    [mb.id],
);
console.log("JOBS", JSON.stringify(jobs, null, 2));
const {rows: logs} = await pool.query(
    `SELECT left(coalesce(line,msg,message,''), 180) AS line, created_at
     FROM mailbox_logs WHERE mailbox_id=$1 ORDER BY id DESC LIMIT 25`,
    [mb.id],
).catch(() => ({rows: []}));
if (logs?.length) console.log("LOGS", JSON.stringify(logs, null, 2));
await pool.end();
