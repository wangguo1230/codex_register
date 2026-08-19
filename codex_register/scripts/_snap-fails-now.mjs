import pg from "pg";
const c = new pg.Client({connectionString: "postgresql://postgres:123456@192.168.1.126:5432/all_register"});
await c.connect();
const pause = await c.query("SELECT claim_paused FROM mail_control WHERE id=1");
console.log("PAUSE", pause.rows[0]);
const live = await c.query(
    `SELECT status, kind, instance_id, count(*)::int n
     FROM mail_jobs WHERE status IN ('pending','running') GROUP BY 1,2,3`,
);
console.log("LIVE", live.rows);
const recent = await c.query(
    `SELECT id, kind, email, status, instance_id, left(coalesce(last_line,error,''), 180) AS line,
            created_at, claimed_at, finished_at
     FROM mail_jobs
     WHERE status IN ('error','canceled') AND created_at > $1
     ORDER BY id DESC LIMIT 25`,
    [Date.now() - 8 * 60 * 60 * 1000],
);
console.log("RECENT_FAIL", JSON.stringify(recent.rows, null, 2));
const byLine = await c.query(
    `SELECT left(coalesce(last_line,error,''), 120) AS line, count(*)::int n
     FROM mail_jobs
     WHERE status='error' AND created_at > $1
     GROUP BY 1 ORDER BY n DESC LIMIT 15`,
    [Date.now() - 8 * 60 * 60 * 1000],
);
console.log("BY_LINE", byLine.rows);
const inst = await c.query(`SELECT * FROM mail_instances ORDER BY last_seen DESC`);
console.log("INST", inst.rows);
await c.end();
