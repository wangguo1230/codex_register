import pg from "pg";
const c = new pg.Client({connectionString: "postgresql://postgres:123456@192.168.1.126:5432/all_register"});
await c.connect();
const ctrl = await c.query("SELECT * FROM mail_control");
console.log("CONTROL", JSON.stringify(ctrl.rows, null, 2));
const g = await c.query(`SELECT google_stage, COUNT(*)::int n,
  COUNT(*) FILTER (WHERE COALESCE(imap_password,'')<>'')::int imap,
  COUNT(*) FILTER (WHERE (google_state->>'totp_rotated')='true')::int rotated,
  COUNT(*) FILTER (WHERE pw_status LIKE '✅%')::int pwok
 FROM mailboxes WHERE deleted_at=0 AND grp=$1 GROUP BY 1 ORDER BY n DESC`, ["8 月 16 日 100"]);
console.log("STAGES", g.rows);
const tot = await c.query(`SELECT COUNT(*)::int n FROM mailboxes WHERE deleted_at=0 AND grp=$1`, ["8 月 16 日 100"]);
console.log("TOTAL", tot.rows[0]);
const live = await c.query(`SELECT status, kind, COUNT(*)::int n FROM mail_jobs WHERE status IN ('pending','running') GROUP BY 1,2`);
console.log("LIVE", live.rows);
const recent = await c.query(`SELECT status, kind, COUNT(*)::int n FROM mail_jobs
 WHERE mailbox_id IN (SELECT id FROM mailboxes WHERE grp=$1)
 GROUP BY 1,2 ORDER BY 2,1`, ["8 月 16 日 100"]);
console.log("GRP16_JOBS", recent.rows);
const sample = await c.query(`SELECT id, email, google_stage, pw_status,
  google_state->>'login' AS login,
  google_state->>'last_error' AS last_error,
  google_state->>'totp_rotated' AS totp_rotated,
  length(coalesce(totp_secret,'')) AS totp_len,
  (imap_password IS NOT NULL AND imap_password<>'') AS has_imap,
  length(coalesce(password,'')) AS pw_len,
  proxy_ip
 FROM mailboxes WHERE deleted_at=0 AND grp=$1 ORDER BY id LIMIT 25`, ["8 月 16 日 100"]);
console.log("SAMPLE", JSON.stringify(sample.rows, null, 2));
await c.end();
