import pg from "pg";
import {needsHardenRetry, planHardenSkip} from "../src/mail/google-state.ts";

const pool = new pg.Pool({connectionString: "postgresql://postgres:123456@192.168.1.126:5432/all_register"});
const {rows} = await pool.query(
    `SELECT id, email, password, totp_secret, imap_password, recovery_email, google_stage, google_state, proxy_url, proxy_ip, pw_status
     FROM mailboxes WHERE deleted_at=0 AND grp=$1`,
    ["8 月 15 日 200"],
);
const {rows: jobs} = await pool.query(
    `SELECT DISTINCT ON (mailbox_id) mailbox_id, status, last_line, instance_id
     FROM mail_jobs WHERE kind='harden' AND mailbox_id = ANY($1)
     ORDER BY mailbox_id, created_at DESC`,
    [rows.map((r) => r.id)],
);
const byJ = Object.fromEntries(jobs.map((j) => [j.mailbox_id, j]));
const cand = [];
for (const m of rows) {
    if (!needsHardenRetry(m)) continue;
    const skip = planHardenSkip(m);
    const st = m.google_state && typeof m.google_state === "object" ? m.google_state : {};
    cand.push({
        id: m.id,
        email: m.email,
        left: skip.requiredLeft,
        totp_rotated: !!st.totp_rotated,
        login: st.login,
        last: String(byJ[m.id]?.last_line || "").slice(0, 120),
        has_pw: !!m.password,
        has_totp: !!m.totp_secret,
        proxy: m.proxy_ip || "",
    });
}
cand.sort((a, b) => Number(b.totp_rotated) - Number(a.totp_rotated));
console.log(JSON.stringify({n: cand.length, list: cand}, null, 2));
await pool.end();
