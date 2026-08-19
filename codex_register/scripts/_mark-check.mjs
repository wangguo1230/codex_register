import pg from "pg";
import {formatHardenListReason, liveGoogleStage} from "../src/mail/google-state.ts";
const c = new pg.Client({connectionString: "postgresql://postgres:123456@192.168.1.126:5432/all_register"});
await c.connect();
const {rows: jobs} = await c.query(
    `SELECT mailbox_id, email, status, ok, left(coalesce(last_line,error,''), 160) AS line
     FROM mail_jobs WHERE batch_id='msv8ni16' AND status='error' ORDER BY email`,
);
const ids = jobs.map((j) => j.mailbox_id);
const {rows: mbs} = await c.query(`SELECT * FROM mailboxes WHERE id = ANY($1)`, [ids]);
const byId = Object.fromEntries(mbs.map((m) => [m.id, m]));
for (const j of jobs) {
    const mb = byId[j.mailbox_id];
    if (!mb) { console.log("MISSING", j.email); continue; }
    console.log(JSON.stringify({
        email: j.email,
        job: j.line,
        stage: mb.google_stage,
        live: liveGoogleStage(mb),
        pw: mb.pw_status,
        reason: formatHardenListReason(mb),
        last_error: mb.google_state?.last_error,
        login: mb.google_state?.login,
        totp: !!mb.google_state?.totp_rotated,
        imap: !!(mb.imap_password && String(mb.imap_password).trim()),
    }));
}
await c.end();
