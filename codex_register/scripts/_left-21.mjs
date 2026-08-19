import pg from "pg";
import {planHardenSkip, formatHardenListReason, needsHardenRetry} from "../src/mail/google-state.ts";
const c = new pg.Client({connectionString: "postgresql://postgres:123456@192.168.1.126:5432/all_register"});
await c.connect();
const {rows: jobs} = await c.query(`SELECT DISTINCT mailbox_id FROM mail_jobs WHERE batch_id='msv8ni16'`);
const {rows: mbs} = await c.query(`SELECT * FROM mailboxes WHERE id = ANY($1) ORDER BY email`, [jobs.map((j) => j.mailbox_id)]);
const left = [];
for (const mb of mbs) {
    const skip = planHardenSkip(mb);
    if (skip.usable) continue;
    const st = mb.google_state || {};
    left.push({
        id: mb.id,
        email: mb.email,
        totp: skip.totp,
        imap: skip.imap,
        login: st.login,
        stage: mb.google_stage,
        attempts: Number(st.harden_attempts || 0),
        rotates: Number(st.proxy_rotates || 0),
        retry: needsHardenRetry(mb),
        reason: formatHardenListReason(mb),
        rec: !!String(mb.recovery_email || "").trim(),
        totpLen: String(mb.totp_secret || "").length,
    });
}
console.log(JSON.stringify(left, null, 2));
console.log("n", left.length, "need2fa", left.filter((x) => !x.totp).length);
await c.end();
