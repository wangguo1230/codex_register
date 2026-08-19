import pg from "pg";
import {planHardenSkip, formatHardenListReason} from "../src/mail/google-state.ts";
const BATCH = process.env.BATCH || "msvlkcxv";
const c = new pg.Client({connectionString: "postgresql://postgres:123456@192.168.1.126:5432/all_register"});
await c.connect();
const {rows: jobs} = await c.query(
    `SELECT mailbox_id, email, status, ok, last_line, error FROM mail_jobs WHERE batch_id=$1`,
    [BATCH],
);
const {rows: mbs} = await c.query(`SELECT * FROM mailboxes WHERE id = ANY($1)`, [jobs.map((j) => j.mailbox_id)]);
const byId = Object.fromEntries(mbs.map((m) => [m.id, m]));
const pending = jobs.filter((j) => j.status === "pending" || j.status === "running").length;
const ok = [];
const fail = [];
for (const j of jobs) {
    if (j.status === "pending" || j.status === "running") continue;
    const mb = byId[j.mailbox_id];
    const skip = mb ? planHardenSkip(mb) : {usable: false, totp: false, imap: false};
    const rec = {
        email: j.email,
        usable: !!skip.usable,
        totp: !!skip.totp,
        imap: !!skip.imap,
        reason: mb ? formatHardenListReason(mb) : "",
        line: String(j.last_line || j.error || "").slice(0, 160),
    };
    if (j.ok || rec.usable) ok.push(rec);
    else fail.push(rec);
}
console.log(JSON.stringify({total: jobs.length, pending, success: ok.length, fail: fail.length, ok, fail}, null, 2));
if (pending === 0 && jobs.length >= 21) {
    await c.query("UPDATE mail_control SET claim_paused=true, updated_at=$1 WHERE id=1", [Date.now()]);
    console.log("PAUSED");
}
await c.end();
process.exit(pending === 0 && jobs.length >= 21 ? 0 : 2);
