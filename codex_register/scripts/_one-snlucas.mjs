import pg from "pg";
import {planHardenSkip, formatHardenListReason, liveGoogleStage, deriveGoogleState} from "../src/mail/google-state.ts";

const pool = new pg.Pool({connectionString: "postgresql://postgres:123456@192.168.1.126:5432/all_register"});
const email = "snlucasbs@gmail.com";
const {rows: [mb]} = await pool.query(`SELECT * FROM mailboxes WHERE email=$1`, [email]);
if (!mb) { console.log("NOT_FOUND"); await pool.end(); process.exit(1); }
const skip = planHardenSkip(mb);
console.log(JSON.stringify({
    id: mb.id,
    stage: mb.google_stage,
    live: liveGoogleStage(mb),
    derived: deriveGoogleState(mb, {}).stage,
    pw_status: mb.pw_status,
    totp: !!mb.totp_secret,
    totp_len: String(mb.totp_secret || "").length,
    imap: !!mb.imap_password,
    imap_len: String(mb.imap_password || "").length,
    google_state: mb.google_state,
    skip,
    reason: formatHardenListReason(mb),
}, null, 2));
const {rows: jobs} = await pool.query(
    `SELECT status, instance_id, left(coalesce(last_line,error,''), 200) AS line, created_at, finished_at
     FROM mail_jobs WHERE mailbox_id=$1 AND kind='harden' ORDER BY created_at DESC LIMIT 8`,
    [mb.id],
);
console.log("JOBS", JSON.stringify(jobs, null, 2));
await pool.end();
