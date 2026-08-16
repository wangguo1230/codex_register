import pg from "pg";
import {needsHardenRetry} from "../src/mail/google-state.ts";

const pool = new pg.Pool({connectionString: "postgresql://postgres:123456@192.168.1.126:5432/all_register"});
const q = async (sql, p = []) => (await pool.query(sql, p)).rows;

try {
  const cols = await q(`SELECT column_name FROM information_schema.columns WHERE table_name='mailboxes' ORDER BY ordinal_position`);
  console.log("cols", cols.map((c) => c.column_name).join(","));
  const kinds = await q(`SELECT kind, status, COUNT(*)::int n FROM mail_jobs GROUP BY 1,2 ORDER BY 1,2`);
  console.log("kinds", JSON.stringify(kinds));
  const controlCols = await q(`SELECT column_name FROM information_schema.columns WHERE table_name='mail_control' ORDER BY ordinal_position`);
  console.log("control_cols", controlCols.map((c) => c.column_name).join(","));
  const control = await q(`SELECT * FROM mail_control`);
  console.log("control", JSON.stringify(control));

  const groups = ["8 月 15 日 200", "8 月 16 日 100"];
  for (const grp of groups) {
    const rows = await q(
      `SELECT id, email, password, pw_status, google_state, google_stage, totp_secret, imap_password, recovery_email, provider, grp
       FROM mailboxes WHERE deleted_at=0 AND grp=$1`,
      [grp],
    );
    const gaps = rows.filter((m) => needsHardenRetry(m) && m.google_stage !== "blocked");
    const usable = rows.filter((m) => !needsHardenRetry(m));
    const stages = {};
    for (const m of rows) {
      const st = m.google_stage || "(null)";
      stages[st] = (stages[st] || 0) + 1;
    }
    const jobs = await q(
      `SELECT j.kind, j.status, COUNT(*)::int n
       FROM mail_jobs j JOIN mailboxes m ON m.id=j.mailbox_id
       WHERE m.grp=$1 AND j.status IN ('pending','running')
       GROUP BY 1,2 ORDER BY 1,2`,
      [grp],
    );
    console.log("GROUP", grp, JSON.stringify({
      total: rows.length,
      usable: usable.length,
      gaps: gaps.length,
      stages,
      jobs,
    }));
  }

  const recent = await q(
    `SELECT status, COUNT(*)::int n FROM mail_jobs
     WHERE kind IN ('harden','harden_gmail') AND updated_at > now() - interval '30 minutes'
     GROUP BY 1 ORDER BY 1`,
  );
  console.log("recent30m", JSON.stringify(recent));

  const lastOk = await q(
    `SELECT email, status, last_line, updated_at
     FROM mail_jobs
     WHERE kind IN ('harden','harden_gmail') AND status='ok'
     ORDER BY updated_at DESC LIMIT 8`,
  );
  console.log("lastOk", JSON.stringify(lastOk, null, 2));

  const lastErr = await q(
    `SELECT email, status, left(coalesce(last_line,''), 160) AS last_line, updated_at
     FROM mail_jobs
     WHERE kind IN ('harden','harden_gmail') AND status IN ('error','canceled')
     ORDER BY updated_at DESC LIMIT 12`,
  );
  console.log("lastErr", JSON.stringify(lastErr, null, 2));

  const inst = await q(
    `SELECT claimed_by, status, COUNT(*)::int n
     FROM mail_jobs
     WHERE kind IN ('harden','harden_gmail') AND status IN ('pending','running')
     GROUP BY 1,2 ORDER BY 1,2`,
  );
  console.log("instances", JSON.stringify(inst));
} catch (e) {
  console.error("SNAP_FAIL", e?.message || e);
  process.exitCode = 1;
} finally {
  await pool.end();
}
