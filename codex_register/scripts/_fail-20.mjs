import pg from "pg";
const IDS = [3992, 4000, 4001, 4006, 4008, 4011];
const c = new pg.Client({connectionString: "postgresql://postgres:123456@192.168.1.126:5432/all_register"});
await c.connect();
const jobs = await c.query(
    `SELECT mailbox_id, email, status, ok, last_line, error, result, finished_at
     FROM mail_jobs WHERE batch_id='msv1rzxj' AND mailbox_id = ANY($1)`,
    [IDS],
);
for (const j of jobs.rows) {
    console.log("\n========", j.email, "========");
    console.log("job", j.status, j.last_line);
    console.log("result", String(j.result || "").slice(0, 400));
    const logs = await c.query(
        `SELECT left(line, 200) AS line FROM mailbox_logs WHERE mailbox_id=$1 ORDER BY id DESC LIMIT 18`,
        [j.mailbox_id],
    );
    for (const r of logs.rows) console.log(" ", r.line);
}
await c.end();
