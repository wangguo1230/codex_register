import pg from "pg";
const pool = new pg.Pool({
  connectionString: "postgresql://postgres:123456@192.168.1.126:5432/all_register",
});
const started = Date.now();
let sawOk = 0;
let sawErr = 0;
let lastReport = 0;

async function tick() {
  const {rows} = await pool.query(
    `SELECT email, status, ok, last_line, instance_id
     FROM mail_jobs
     WHERE finished_at >= $1 AND status IN ('done','error')
     ORDER BY finished_at DESC`,
    [started]
  );
  const oks = rows.filter((r) => r.status === "done" && r.ok);
  const errs = rows.filter((r) => r.status === "error" || (r.status === "done" && !r.ok));
  if (oks.length > sawOk) {
    const neu = oks.slice(0, oks.length - sawOk);
    sawOk = oks.length;
    console.log(`DONE ${oks.length} ${neu.map((r) => r.email).join(",")}`);
  }
  if (errs.length >= sawErr + 6 && Date.now() - lastReport > 180000) {
    const top = {};
    for (const r of errs) {
      const k = String(r.last_line || "").split("\n")[0].slice(0, 80);
      top[k] = (top[k] || 0) + 1;
    }
    const head = Object.entries(top).sort((a, b) => b[1] - a[1])[0];
    sawErr = errs.length;
    lastReport = Date.now();
    console.log(`FAILED ${errs.length} top=${head ? head[0] : "?"}`);
  }
}

async function loop() {
  try { await tick(); } catch (e) { /* keep watching */ }
}
await loop();
setInterval(loop, 45000);
