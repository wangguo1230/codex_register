import pg from "pg";
const c = new pg.Client({connectionString: "postgresql://postgres:123456@192.168.1.126:5432/all_register"});
await c.connect();
const mbs = await c.query(`
  SELECT id, email, password, totp_secret, imap_password, recovery_email, google_stage, google_state, pw_status
  FROM mailboxes WHERE deleted_at=0 AND grp=$1 ORDER BY id
`, ["8 月 16 日 100"]);
const jobs = await c.query(`
  SELECT mailbox_id, status, last_line, error, instance_id, created_at, finished_at
  FROM mail_jobs WHERE kind='harden' AND mailbox_id = ANY($1)
  ORDER BY created_at
`, [mbs.rows.map((r) => r.id)]);
const byMb = new Map();
for (const j of jobs.rows) {
    const arr = byMb.get(j.mailbox_id) || [];
    arr.push(j);
    byMb.set(j.mailbox_id, arr);
}
const noTotp = [];
const lines = new Map();
for (const m of mbs.rows) {
    const js = byMb.get(m.id) || [];
    const last = js.filter((j) => j.status === "error").at(-1);
    const line = String(last?.last_line || last?.error || "").slice(0, 160);
    lines.set(line || "(none)", (lines.get(line || "(none)") || 0) + 1);
    if (!m.totp_secret) noTotp.push(m.email);
}
console.log("n", mbs.rows.length, "no_totp", noTotp);
console.log("PREV_ERROR_LINES");
for (const [k, v] of [...lines.entries()].sort((a, b) => b[1] - a[1])) console.log(v, k);
const withTotp = mbs.rows.filter((m) => String(m.totp_secret || "").length >= 16 && String(m.password || "").length >= 6);
const without = mbs.rows.filter((m) => String(m.totp_secret || "").length < 16 && String(m.password || "").length >= 6);
// 18 with seller totp + 2 without, so this round can hit 缺2FA path too
const pick = [...withTotp.slice(0, 18), ...without.slice(0, 2)];
console.log("PICK", pick.map((m) => ({
    id: m.id,
    email: m.email,
    totp: String(m.totp_secret || "").length,
    last: String((byMb.get(m.id) || []).filter((j) => j.status === "error").at(-1)?.last_line || "").slice(0, 100),
})));
await c.end();
