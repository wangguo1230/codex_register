import pg from "pg";
const email = process.argv[2] || "lumellloo4@gmail.com";
const c = new pg.Client({connectionString: "postgresql://postgres:123456@192.168.1.126:5432/all_register"});
await c.connect();
const {rows: [mb]} = await c.query(`SELECT id, email, google_stage, pw_status, recovery_email,
  length(coalesce(totp_secret,'')) totp_len, (imap_password is not null and imap_password<>'') imap,
  proxy_ip, google_state FROM mailboxes WHERE email=$1`, [email]);
console.log("MB", JSON.stringify(mb, null, 2));
if (mb) {
    const jobs = await c.query(
        `SELECT id, status, instance_id, left(coalesce(last_line,error,''), 220) line, created_at, claimed_at, finished_at
         FROM mail_jobs WHERE mailbox_id=$1 ORDER BY id DESC LIMIT 5`,
        [mb.id],
    );
    console.log("JOBS", JSON.stringify(jobs.rows, null, 2));
    const logs = await c.query(
        `SELECT ts, left(line, 200) line FROM mailbox_logs WHERE mailbox_id=$1 ORDER BY id DESC LIMIT 35`,
        [mb.id],
    );
    console.log("LOGS");
    for (const r of logs.rows) {
        const t = new Date(Number(r.ts)).toISOString().slice(11, 19);
        console.log(t, r.line);
    }
}
const live = await c.query(
    `SELECT email, instance_id, left(coalesce(last_line,''), 180) line, claimed_at, heartbeat_at
     FROM mail_jobs WHERE status='running' AND kind='harden' ORDER BY claimed_at`,
);
console.log("\nRUNNING", live.rows.length);
for (const r of live.rows) {
    const age = Math.round((Date.now() - Number(r.claimed_at || 0)) / 1000);
    console.log(`${age}s ${r.instance_id} ${r.email}\n  ${r.line}`);
}
await c.end();
