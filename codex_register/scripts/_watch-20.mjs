import pg from "pg";
import {classifyHardenIssue, formatHardenListReason, planHardenSkip} from "../src/mail/google-state.ts";

const IDS = [3992, 3993, 3994, 3995, 3997, 3998, 3999, 4000, 4001, 4002, 4003, 4004, 4005, 4006, 4007, 4008, 4009, 4010, 4011, 4012];
const BATCH = process.env.BATCH || "msv1rzxj";
const c = new pg.Client({connectionString: "postgresql://postgres:123456@192.168.1.126:5432/all_register"});
await c.connect();

const jobs = await c.query(
    `SELECT mailbox_id, email, status, ok, last_line, error, instance_id, created_at, finished_at
     FROM mail_jobs WHERE batch_id=$1 AND mailbox_id = ANY($2) ORDER BY mailbox_id, id`,
    [BATCH, IDS],
);
const mbs = await c.query(
    `SELECT id, email, google_stage, pw_status, imap_password, totp_secret, google_state
     FROM mailboxes WHERE id = ANY($1)`,
    [IDS],
);
const byId = Object.fromEntries(mbs.rows.map((r) => [r.id, r]));
const pending = jobs.rows.filter((j) => j.status === "pending" || j.status === "running").length;
const done = jobs.rows.filter((j) => !["pending", "running"].includes(j.status));
const ok = [];
const fail = [];
for (const j of done) {
    const mb = byId[j.mailbox_id];
    const skip = mb ? planHardenSkip(mb) : {usable: false, requiredLeft: []};
    const usable = !!(skip.usable);
    const reason = mb ? (formatHardenListReason(mb) || classifyHardenIssue(j.error || j.last_line || "") || String(j.error || j.last_line || "").slice(0, 160)) : (j.error || j.last_line);
    const rec = {
        email: j.email,
        status: j.status,
        usable,
        stage: mb?.google_stage,
        totp: !!(mb?.google_state && mb.google_state.totp_rotated),
        imap: !!(mb?.imap_password),
        pw: String(mb?.pw_status || ""),
        line: String(j.last_line || j.error || "").slice(0, 180),
        reason,
        instance: j.instance_id,
    };
    if (j.ok || usable) ok.push(rec);
    else fail.push(rec);
}
const byReason = {};
for (const f of fail) {
    const k = f.reason || "未知";
    byReason[k] = (byReason[k] || 0) + 1;
}
console.log(JSON.stringify({
    batch: BATCH,
    total: IDS.length,
    jobs: jobs.rows.length,
    pending,
    finished: done.length,
    success: ok.length,
    fail: fail.length,
    rate: done.length ? `${ok.length}/${done.length}` : "0/0",
    byReason,
    ok, fail,
}, null, 2));
if (pending === 0 && jobs.rows.length >= IDS.length) {
    await c.query("UPDATE mail_control SET claim_paused=true, updated_at=$1 WHERE id=1", [Date.now()]);
    console.log("PAUSED");
}
await c.end();
process.exit(pending === 0 && jobs.rows.length >= IDS.length ? 0 : 2);
