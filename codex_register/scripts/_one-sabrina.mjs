import pg from "pg";
const email = "sabrina20111211@gmail.com";
const c = new pg.Client({connectionString: "postgresql://postgres:123456@192.168.1.126:5432/all_register"});
await c.connect();
const {rows: [mb]} = await c.query(`SELECT id, email, google_stage, pw_status, proxy_url, proxy_ip, google_state FROM mailboxes WHERE email=$1`, [email]);
console.log("MB", JSON.stringify({
    id: mb.id, stage: mb.google_stage, pw: mb.pw_status, ip: mb.proxy_ip,
    proxy: String(mb.proxy_url || "").replace(/:[^:@/]+@/, ":***@"),
    st: mb.google_state,
}, null, 2));
const jobs = await c.query(
    `SELECT id, status, last_line, error, instance_id, created_at, claimed_at, heartbeat_at, finished_at
     FROM mail_jobs WHERE mailbox_id=$1 ORDER BY id DESC LIMIT 6`,
    [mb.id],
);
console.log("JOBS", JSON.stringify(jobs.rows, null, 2));
const logs = await c.query(
    `SELECT ts, line FROM mailbox_logs WHERE mailbox_id=$1 ORDER BY id`,
    [mb.id],
);
console.log("LOGS", logs.rows.length);
for (const r of logs.rows) {
    const t = new Date(Number(r.ts)).toISOString().slice(11, 19);
    console.log(t, r.line);
}
await c.end();
