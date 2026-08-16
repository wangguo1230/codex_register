import pg from "pg";
import {needsHardenRetry, planHardenSkip} from "../src/mail/google-state.ts";

const pool = new pg.Pool({connectionString: "postgresql://postgres:123456@192.168.1.126:5432/all_register"});
const q = async (sql, p = []) => (await pool.query(sql, p)).rows;

const rows = await q(
  `SELECT id, email, google_stage, google_state, totp_secret, imap_password, recovery_email, proxy_ip, proxy_url, pw_status
   FROM mailboxes WHERE deleted_at=0 AND grp=$1`,
  ["8 月 15 日 200"],
);
const gaps = rows.filter((m) => needsHardenRetry(m) && m.google_stage !== "blocked");
const ids = gaps.map((m) => m.id);

const latest = await q(
  `SELECT DISTINCT ON (mailbox_id) mailbox_id, status, last_line, instance_id, error
   FROM mail_jobs WHERE mailbox_id = ANY($1) AND kind='harden'
   ORDER BY mailbox_id, created_at DESC`,
  [ids],
);
const hist = await q(
  `SELECT mailbox_id,
          COUNT(*) FILTER (WHERE status='error')::int errs,
          COUNT(*) FILTER (WHERE status='done')::int dones,
          array_agg(left(coalesce(last_line,''), 80) ORDER BY created_at DESC) FILTER (WHERE status='error') AS err_lines
   FROM mail_jobs WHERE mailbox_id = ANY($1) AND kind='harden'
   GROUP BY 1`,
  [ids],
);
const byL = Object.fromEntries(latest.map((j) => [j.mailbox_id, j]));
const byH = Object.fromEntries(hist.map((j) => [j.mailbox_id, j]));

const classify = (lines) => {
  const blob = (lines || []).slice(0, 8).join(" | ");
  if (/rejected|拒绝页/i.test(blob)) return "rejected";
  if (/应用专用密码|未能提取|拒绝生成|取件/i.test(blob)) return "apppw";
  if (/邮箱页卡住|仍在邮箱页/i.test(blob)) return "id_stuck";
  if (/登录失败|Wrong password|密码不对/i.test(blob)) return "login";
  if (/比特窗口|上限/i.test(blob)) return "bitcap";
  if (/代理|SSL|超时|Timeout|CDP/i.test(blob)) return "proxy";
  return "other";
};

const out = gaps.map((m) => {
  const st = m.google_state && typeof m.google_state === "object" ? m.google_state : {};
  const skip = planHardenSkip(m);
  const h = byH[m.id] || {};
  const l = byL[m.id] || {};
  const lines = h.err_lines || [];
  return {
    email: m.email,
    stage: m.google_stage,
    left: skip.requiredLeft,
    totp_rotated: !!st.totp_rotated,
    login: st.login || "",
    login_error: st.login_error || "",
    imap: !!m.imap_password,
    proxy_ip: m.proxy_ip || "",
    errs: h.errs || 0,
    dones: h.dones || 0,
    cls: classify(lines),
    last: String(l.last_line || "").slice(0, 120),
    top: [...new Set((lines || []).slice(0, 5).map((s) => String(s).replace(m.email + ": ", "").slice(0, 70)))],
  };
});

const byCls = {};
for (const r of out) {
  byCls[r.cls] = byCls[r.cls] || {n: 0, errs: 0, totp_ok: 0, emails: []};
  byCls[r.cls].n += 1;
  byCls[r.cls].errs += r.errs;
  if (r.totp_rotated) byCls[r.cls].totp_ok += 1;
  if (byCls[r.cls].emails.length < 6) byCls[r.cls].emails.push(`${r.email}(${r.errs})`);
}

const loginErr = {};
for (const r of out) {
  const k = r.login_error || r.login || "(none)";
  loginErr[k] = (loginErr[k] || 0) + 1;
}

console.log("BY_CLS", JSON.stringify(byCls, null, 2));
console.log("LOGIN_ERR", JSON.stringify(loginErr, null, 2));
console.log("LEFT", JSON.stringify(out.reduce((a, r) => {
  const k = (r.left || []).join("+") || "none";
  a[k] = (a[k] || 0) + 1;
  return a;
}, {})));
console.log("STAGE", JSON.stringify(out.reduce((a, r) => { a[r.stage] = (a[r.stage] || 0) + 1; return a; }, {})));
console.log("SAMPLES", JSON.stringify(out.sort((a, b) => b.errs - a.errs).slice(0, 12), null, 2));
await pool.end();
