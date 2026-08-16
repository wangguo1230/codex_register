import pg from "pg";
const emails = [
    "anaknyabubidan@gmail.com",
    "trtrtrtrtrtr90@gmail.com",
    "resklamb123@gmail.com",
    "segundobuslon1965@gmail.com",
    "zeynep35hd35@gmail.com",
];
const c = new pg.Client({connectionString: "postgresql://postgres:123456@192.168.1.126:5432/all_register"});
await c.connect();
const {rows} = await c.query(
    `SELECT id, email, google_stage, pw_status,
      (imap_password IS NOT NULL AND imap_password<>'') AS imap,
      google_state->>'totp_rotated' AS totp_rotated,
      google_state->>'harden_attempts' AS attempts,
      google_state->>'last_error' AS last_error,
      google_state->>'login' AS login,
      proxy_ip
     FROM mailboxes WHERE email = ANY($1)
     ORDER BY array_position($1::text[], email)`,
    [emails],
);
console.log(JSON.stringify(rows, null, 2));
const live = await c.query(`SELECT status, kind, count(*)::int n FROM mail_jobs WHERE status IN ('pending','running') GROUP BY 1,2`);
console.log("LIVE", live.rows);
const pause = await c.query("SELECT claim_paused FROM mail_control WHERE id=1");
console.log("PAUSE", pause.rows[0]);
await c.end();
