import pg from "pg";
import {planHardenSkip, liveGoogleStage, formatHardenListReason} from "../src/mail/google-state.ts";
const c = new pg.Client({connectionString: "postgresql://postgres:123456@192.168.1.126:5432/all_register"});
await c.connect();
const {rows: jobs} = await c.query(
    `SELECT DISTINCT mailbox_id FROM mail_jobs WHERE batch_id='msv8ni16'`,
);
const ids = jobs.map((j) => j.mailbox_id);
const {rows: mbs} = await c.query(`SELECT * FROM mailboxes WHERE id = ANY($1)`, [ids]);
let usable = 0, totp = 0, imap = 0, bothMiss = 0, loginDead = 0;
const gaps = {};
for (const mb of mbs) {
    const skip = planHardenSkip(mb);
    const st = mb.google_state || {};
    if (skip.usable) { usable += 1; continue; }
    if (st.login === "fail" || mb.google_stage === "login_fail" || mb.google_stage === "blocked") loginDead += 1;
    if (skip.totp) totp += 1;
    if (skip.imap) imap += 1;
    if (!skip.totp && !skip.imap) bothMiss += 1;
    const r = formatHardenListReason(mb) || liveGoogleStage(mb);
    gaps[r] = (gaps[r] || 0) + 1;
}
console.log(JSON.stringify({
    n: mbs.length,
    usable,
    rate: `${usable}/${mbs.length}`,
    leftover: mbs.length - usable,
    leftoverHasTotpOnly: totp,
    leftoverHasImapOnly: imap,
    leftoverBothMissing: bothMiss,
    leftoverLoginDead: loginDead,
    leftoverReasons: gaps,
}, null, 2));
await c.end();
