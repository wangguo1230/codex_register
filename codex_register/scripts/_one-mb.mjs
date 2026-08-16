import pg from "pg";
const pool = new pg.Pool({connectionString: "postgresql://postgres:123456@192.168.1.126:5432/all_register"});
const email = "aayush30511@gmail.com";
const {rows: [mb]} = await pool.query(
    `SELECT id,email,google_stage,google_state,proxy_ip,pw_status,imap_password,totp_secret FROM mailboxes WHERE email=$1`,
    [email],
);
console.log("MB", JSON.stringify(mb, null, 2));
const {rows: jobs} = await pool.query(
    `SELECT status, instance_id, left(coalesce(last_line, error, ''), 220) AS line, created_at, finished_at
     FROM mail_jobs WHERE email=$1 AND kind='harden' ORDER BY created_at DESC LIMIT 15`,
    [email],
);
console.log("JOBS", JSON.stringify(jobs, null, 2));
await pool.end();
