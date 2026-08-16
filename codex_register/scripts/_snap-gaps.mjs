import pg from "pg";
import {needsHardenRetry, planHardenSkip} from "../src/mail/google-state.ts";

const pool = new pg.Pool({connectionString: "postgresql://postgres:123456@192.168.1.126:5432/all_register"});
const q = async (sql, p = []) => (await pool.query(sql, p)).rows;

const jobCols = await q(`SELECT column_name FROM information_schema.columns WHERE table_name='mail_jobs' ORDER BY ordinal_position`);
console.log("job_cols", jobCols.map((c) => c.column_name).join(","));

const rows = await q(
  `SELECT id, email, google_stage, google_state, totp_secret, imap_password, recovery_email, proxy_ip, pw_status
   FROM mailboxes WHERE deleted_at=0 AND grp=$1`,
  ["8 月 15 日 200"],
);
const gaps = rows.filter((m) => needsHardenRetry(m) && m.google_stage !== "blocked");
console.log("gap_n", gaps.length);

const ids = gaps.map((m) => m.id);
const latest = await q(
  `SELECT DISTINCT ON (mailbox_id) mailbox_id, email, status, last_line, instance_id, created_at, finished_at
   FROM mail_jobs
   WHERE mailbox_id = ANY($1) AND kind='harden'
   ORDER BY mailbox_id, created_at DESC`,
  [ids],
);
const byId = Object.fromEntries(latest.map((j) => [j.mailbox_id, j]));

const buckets = {};
for (const m of gaps) {
  const st = m.google_state && typeof m.google_state === "object" ? m.google_state : {};
  const skip = planHardenSkip(m);
  const j = byId[m.id] || {};
  const line = String(j.last_line || st.login_error || m.google_stage || "unknown");
  let b = "other";
  if (/Wrong password|密码不对|couldn't find your google/i.test(line)) b = "wrong_password";
  else if (/rejected|Couldn't sign you in|无法登录|this browser or app/i.test(line)) b = "rejected";
  else if (/登录失败|login fail|Couldn't sign/i.test(line)) b = "login_fail";
  else if (/比特|bit.?window|cap|上限/i.test(line)) b = "bit";
  else if (/proxy|代理|ECONN|timeout|ETIMEDOUT/i.test(line)) b = "proxy";
  else if (m.google_stage === "partial") b = "partial_" + (skip.requiredLeft || []).join("+");
  else if (m.google_stage === "imported") b = "imported_no_job";
  buckets[b] = (buckets[b] || 0) + 1;
}

console.log("buckets", JSON.stringify(buckets, null, 2));

const sample = gaps.slice(0, 20).map((m) => {
  const st = m.google_state && typeof m.google_state === "object" ? m.google_state : {};
  const skip = planHardenSkip(m);
  const j = byId[m.id] || {};
  return {
    email: m.email,
    stage: m.google_stage,
    left: skip.requiredLeft,
    totp: !!m.totp_secret,
    imap: !!m.imap_password,
    login: st.login,
    login_error: st.login_error,
    totp_rotated: st.totp_rotated,
    job: j.status,
    inst: j.instance_id,
    line: String(j.last_line || "").slice(0, 140),
    proxy: m.proxy_ip,
  };
});
console.log("sample", JSON.stringify(sample, null, 2));

const running = await q(
  `SELECT email, instance_id, last_line, created_at FROM mail_jobs WHERE kind='harden' AND status='running' ORDER BY created_at`,
);
console.log("running", JSON.stringify(running, null, 2));

const recentDone = await q(
  `SELECT email, status, last_line, instance_id, finished_at
   FROM mail_jobs WHERE kind='harden' AND status='done'
   ORDER BY finished_at DESC NULLS LAST LIMIT 8`,
);
console.log("recentDone", JSON.stringify(recentDone, null, 2));

const recentErr = await q(
  `SELECT email, status, left(coalesce(last_line,''), 180) AS last_line, instance_id, finished_at
   FROM mail_jobs WHERE kind='harden' AND status='error'
   ORDER BY finished_at DESC NULLS LAST LIMIT 15`,
);
console.log("recentErr", JSON.stringify(recentErr, null, 2));

await pool.end();
