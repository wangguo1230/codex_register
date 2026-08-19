import pg from "pg";
import {formatHardenListReason, liveGoogleStage} from "../src/mail/google-state.ts";
const c = new pg.Client({connectionString: "postgresql://postgres:123456@192.168.1.126:5432/all_register"});
await c.connect();
const {rows: jobs} = await c.query(
    `SELECT mailbox_id, email, instance_id, left(coalesce(last_line,error,''), 200) AS line
     FROM mail_jobs WHERE batch_id='msv8ni16' AND status='error'`,
);
const {rows: mbs} = await c.query(`SELECT * FROM mailboxes WHERE id = ANY($1)`, [jobs.map((j) => j.mailbox_id)]);
const byId = Object.fromEntries(mbs.map((m) => [m.id, m]));
const groups = {};
for (const j of jobs) {
    const mb = byId[j.mailbox_id] || {};
    const reason = formatHardenListReason(mb) || mb.google_state?.last_error || j.line;
    const totp = !!mb.google_state?.totp_rotated;
    const imap = !!(mb.imap_password && String(mb.imap_password).trim());
    let k = "其它";
    if (/拒发|error generating/i.test(String(reason) + j.line)) k = "IMAP拒发";
    else if (!totp && imap) k = "已IMAP缺换2FA";
    else if (totp && !imap) k = "已换2FA缺IMAP";
    else if (!totp && !imap && /登录失败|卡住|blocked|空白|rejected|Loading/i.test(String(reason) + j.line + (mb.google_stage || ""))) k = "没登进去";
    else if (!totp && !imap) k = "2FA和IMAP都缺";
    (groups[k] ||= []).push({
        email: j.email,
        stage: liveGoogleStage(mb),
        reason,
        totp, imap,
        pw: mb.pw_status,
        last: j.line.slice(0, 120),
        machine: j.instance_id,
    });
}
for (const [k, arr] of Object.entries(groups)) {
    console.log(`\n## ${k} (${arr.length})`);
    for (const a of arr) {
        console.log(`- ${a.email}  [${a.stage}] ${a.reason || "—"}  totp=${a.totp} imap=${a.imap}`);
        console.log(`    job: ${a.last}`);
    }
}
console.log("\nTOTAL", jobs.length);
await c.end();
