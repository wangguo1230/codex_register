import pg from "pg";
import {needsHardenRetry, planHardenSkip} from "../src/mail/google-state.ts";

const pool = new pg.Pool({connectionString: "postgresql://postgres:123456@192.168.1.126:5432/all_register"});
const q = async (sql, p = []) => (await pool.query(sql, p)).rows;

const rows = await q(
  `SELECT id, email, google_stage, google_state, totp_secret, imap_password
   FROM mailboxes WHERE deleted_at=0 AND grp=$1`,
  ["8 月 15 日 200"],
);
const gaps = rows.filter((m) => needsHardenRetry(m) && m.google_stage !== "blocked");
const ids = gaps.map((m) => m.id);

const stats = await q(
  `SELECT mailbox_id, email,
          COUNT(*) FILTER (WHERE status='error')::int errs,
          COUNT(*) FILTER (WHERE status='done')::int dones,
          COUNT(*) FILTER (WHERE status IN ('pending','running'))::int live
   FROM mail_jobs WHERE mailbox_id = ANY($1) AND kind='harden'
   GROUP BY 1,2`,
  [ids],
);
const latest = await q(
  `SELECT DISTINCT ON (mailbox_id) mailbox_id, status, last_line, instance_id, finished_at
   FROM mail_jobs WHERE mailbox_id = ANY($1) AND kind='harden'
   ORDER BY mailbox_id, created_at DESC`,
  [ids],
);
const byId = Object.fromEntries(latest.map((j) => [j.mailbox_id, j]));
const stBy = Object.fromEntries(stats.map((s) => [s.mailbox_id, s]));

const reasonOf = (line, stage, skip) => {
  const s = String(line || "");
  if (/rejected|拒绝页/i.test(s)) return "Google拒绝页(IP风控)";
  if (/邮箱页卡住|仍在邮箱页|identifier/i.test(s)) return "邮箱页点Next不走";
  if (/登录失败|Wrong password|密码不对/i.test(s)) return "登录失败";
  if (/应用专用密码|取件|IMAP|未能提取/i.test(s)) return "应用密码生成被拒";
  if (/比特窗口|上限/i.test(s)) return "比特并发上限";
  if (/代理|SSL|ECONN|timeout|超时/i.test(s)) return "代理/超时";
  if (stage === "partial" && skip.requiredLeft?.includes("imap")) return "已换2FA只差IMAP";
  if (stage === "partial" && skip.requiredLeft?.includes("totp")) return "只差换2FA";
  return "其它/还在跑";
};

const buckets = {};
let errSum = 0;
for (const m of gaps) {
  const skip = planHardenSkip(m);
  const j = byId[m.id] || {};
  const st = stBy[m.id] || {};
  errSum += st.errs || 0;
  const r = reasonOf(j.last_line, m.google_stage, skip);
  buckets[r] = buckets[r] || {n: 0, tries: 0, emails: []};
  buckets[r].n += 1;
  buckets[r].tries += st.errs || 0;
  if (buckets[r].emails.length < 4) buckets[r].emails.push(`${m.email} x${st.errs || 0}`);
}
console.log(JSON.stringify({
  gaps: gaps.length,
  total_error_jobs: errSum,
  avg_errors: +(errSum / Math.max(1, gaps.length)).toFixed(1),
  buckets,
}, null, 2));
await pool.end();
