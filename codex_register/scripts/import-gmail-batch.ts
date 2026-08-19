// 导入 Gmail 老号。行格式: email|password|recovery|totp|year|region
import pg from "pg";
import {deriveGoogleState, googleStateSummary} from "../src/mail/google-state.ts";

import {readFileSync} from "node:fs";

const grp = process.env.GPT_BATCH || "gmail-test-30";
const args = process.argv.slice(2);
let raw = "";
if (args[0] === "--file" && args[1]) raw = readFileSync(args[1], "utf8");
else raw = args.join("\n");
const lines = raw.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
if (!lines.length) {
    console.error("usage: tsx scripts/import-gmail-batch.ts --file lines.txt");
    process.exit(1);
}

const pool = new pg.Pool({connectionString: process.env.DATABASE_URL || "postgresql://postgres:123456@192.168.1.126:5432/all_register"});
const now = Date.now();
let inserted = 0, updated = 0;
for (const line of lines) {
    const parts = line.split("|").map((s) => s.trim());
    const email = String(parts[0] || "").toLowerCase();
    const password = parts[1] || "";
    const recovery = parts[2] || "";
    const totp = (parts[3] || "").replace(/\s+/g, "").toUpperCase();
    const year = parts[4] || "";
    const region = parts[5] || "";
    if (!email.includes("@") || !password) {
        console.log("SKIP bad", line.slice(0, 60));
        continue;
    }
    const note = [year && `year=${year}`, region && `region=${region}`].filter(Boolean).join(" ");
    const {rows: [exist]} = await pool.query("SELECT id FROM mailboxes WHERE email=$1", [email]);
    let id = exist?.id;
    if (exist) {
        await pool.query(
            `UPDATE mailboxes SET deleted_at=0, usage=CASE WHEN usage='deleted' THEN 'hold' ELSE usage END,
             password=$1, provider='google', grp=$2, recovery_email=$3, note=$5,
             totp_secret=CASE
               WHEN COALESCE(google_state->>'totp_rotated','')='true' THEN totp_secret
               WHEN COALESCE(totp_secret,'')<>'' THEN totp_secret
               ELSE $4 END,
             totp_secret_orig=CASE WHEN COALESCE(totp_secret_orig,'')<>'' THEN totp_secret_orig WHEN COALESCE(totp_secret,'')<>'' THEN totp_secret ELSE $4 END
             WHERE id=$6`,
            [password, grp, recovery, totp, note, exist.id],
        );
        updated += 1;
    } else {
        const {rows: [ins]} = await pool.query(
            `INSERT INTO mailboxes(email,password,provider,usage,grp,note,created_at,recovery_email,totp_secret,totp_secret_orig)
             VALUES($1,$2,'google','hold',$3,$4,$5,$6,$7,$7) RETURNING id`,
            [email, password, grp, note, now, recovery, totp],
        );
        id = ins.id;
        inserted += 1;
    }
    const {rows: [mb]} = await pool.query(
        `SELECT m.*, g.status AS gpt_status, g.error AS gpt_error
         FROM mailboxes m LEFT JOIN gpt_accounts g ON g.mailbox_id=m.id AND g.deleted_at=0
         WHERE m.id=$1`,
        [id],
    );
    const state = deriveGoogleState(mb, {stage: "imported", totp: totp ? "ok" : "none", recovery: recovery ? "fail" : "ok"});
    state.year = year;
    state.region = region;
    await pool.query(`UPDATE mailboxes SET google_state=$1::jsonb, google_stage=$2 WHERE id=$3`, [JSON.stringify(state), state.stage, id]);
    await pool.query(`INSERT INTO mailbox_logs(mailbox_id,ts,line) VALUES($1,$2,$3)`, [id, Date.now(), `[导入] ${grp} ${googleStateSummary(state)} ${note}`]);
    console.log((exist ? "UPD" : "INS"), email, region, year);
}
console.log("DONE inserted", inserted, "updated", updated);
await pool.end();
