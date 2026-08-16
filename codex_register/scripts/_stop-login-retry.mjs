import pg from "pg";
import {
    needsHardenRetry, isHardenIpError, isHardenLoginDead, classifyHardenLoginError, deriveGoogleState,
} from "../src/mail/google-state.ts";

const pool = new pg.Pool({connectionString: "postgresql://postgres:123456@192.168.1.126:5432/all_register"});
const q = async (sql, p = []) => (await pool.query(sql, p)).rows;

const rows = await q(
    `SELECT id, email, google_stage, google_state, totp_secret, imap_password, recovery_email, pw_status, provider
     FROM mailboxes WHERE deleted_at=0 AND grp=$1`,
    ["8 月 15 日 200"],
);
const ids = rows.map((m) => m.id);
const hist = await q(
    `SELECT DISTINCT ON (mailbox_id) mailbox_id, last_line, status
     FROM mail_jobs WHERE mailbox_id = ANY($1) AND kind='harden' AND status='error'
     ORDER BY mailbox_id, created_at DESC`,
    [ids],
);
const byH = Object.fromEntries(hist.map((j) => [j.mailbox_id, j]));

let dead = 0;
let rotate = 0;
const deadIds = [];
for (const m of rows) {
    if (!needsHardenRetry(m) && m.google_stage !== "imported" && m.google_stage !== "partial") continue;
    const line = String(byH[m.id]?.last_line || "");
    const st = m.google_state && typeof m.google_state === "object" ? m.google_state : {};
    if (isHardenLoginDead(line) || /^登录失败$/.test(line)) {
        const overlay = {
            login: "fail",
            login_error: classifyHardenLoginError(line || "登录失败"),
            last_error: (line || "登录失败").slice(0, 160),
        };
        const next = deriveGoogleState(m, overlay);
        await pool.query(`UPDATE mailboxes SET google_state=$1::jsonb, google_stage=$2 WHERE id=$3`, [next, next.stage, m.id]);
        dead += 1;
        deadIds.push(m.id);
        continue;
    }
    if (isHardenIpError(line)) {
        await pool.query(`UPDATE mailboxes SET proxy_url='', proxy_ip='' WHERE id=$1`, [m.id]);
        const overlay = {login: st.login && st.login !== "fail" ? st.login : "unknown", proxy_rotates: 0, last_error: line.slice(0, 160)};
        const next = deriveGoogleState({...m, google_state: {...st, login: overlay.login}}, overlay);
        next.login = overlay.login;
        next.stage = next.totp_rotated && next.imap === "ok" ? "ready" : (next.login === "ok" ? "partial" : "imported");
        await pool.query(`UPDATE mailboxes SET google_state=$1::jsonb, google_stage=$2 WHERE id=$3`, [next, next.stage, m.id]);
        rotate += 1;
    }
}

const now = Date.now();
let canceled = 0;
if (deadIds.length) {
    const r = await pool.query(
        `UPDATE mail_jobs SET status='canceled', finished_at=$1, last_line='登录失败已判定，不再重试'
         WHERE kind='harden' AND status='pending' AND mailbox_id = ANY($2)`,
        [now, deadIds],
    );
    canceled = r.rowCount || 0;
}

const left = await q(
    `SELECT COUNT(*)::int n FROM mailboxes m
     WHERE m.deleted_at=0 AND m.grp=$1`,
    ["8 月 15 日 200"],
);
const after = await q(
    `SELECT id, email, password, pw_status, google_state, google_stage, totp_secret, imap_password, recovery_email, provider
     FROM mailboxes WHERE deleted_at=0 AND grp=$1`,
    ["8 月 15 日 200"],
);
const still = after.filter((m) => needsHardenRetry(m) && m.google_stage !== "blocked");
console.log(JSON.stringify({
    dead, rotate, canceled, still_retry: still.length,
    still_sample: still.slice(0, 8).map((m) => m.email),
}));
await pool.end();
