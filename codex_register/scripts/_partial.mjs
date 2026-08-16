import {query, pool} from "../server/pg.ts";

const {rows} = await query(`
  SELECT email, pw_status, google_state,
         COALESCE(imap_password,'')<>'' AS has_imap,
         COALESCE(totp_secret,'')<>'' AS has_totp
  FROM mailboxes
  WHERE (grp LIKE '%8%15%' OR grp LIKE '%月 15%')
    AND (
      google_state->>'stage' = 'partial'
      OR pw_status LIKE '%部分%'
    )
  ORDER BY email
`);
console.log("n", rows.length);

function flags(st) {
    const s = st || {};
    return {
        stage: s.stage,
        totp: s.totp, totp_rot: !!s.totp_rotated,
        pw: s.password, imap: s.imap,
        phone: s.phone, devices: s.devices, recovery: s.recovery,
        login: s.login, err: String(s.last_error || "").slice(0, 140),
    };
}

const miss = new Map();
for (const r of rows) {
    const f = flags(r.google_state);
    const parts = [];
    if (f.totp !== "ok" && !f.totp_rot) parts.push("2FA未换");
    if (f.pw !== "ok") parts.push("密码未改");
    if (f.imap !== "ok" && !r.has_imap) parts.push("无应用密码");
    if (f.recovery === "fail") parts.push("辅助邮箱");
    if (f.phone === "fail") parts.push("手机");
    if (f.devices === "fail") parts.push("踢设备");
    if (f.login === "fail") parts.push("登录");
    const key = parts.join("+") || ("其它:" + (f.err || f.stage));
    const row = miss.get(key) || {n: 0, emails: [], errs: new Map()};
    row.n += 1;
    if (row.emails.length < 6) row.emails.push(r.email);
    const ek = f.err || "(无)";
    row.errs.set(ek, (row.errs.get(ek) || 0) + 1);
    miss.set(key, row);
}
console.log("\n==== missing combo ====");
for (const [k, v] of [...miss.entries()].sort((a, b) => b.n - a.n)) {
    console.log(`\n${v.n}  ${k}`);
    console.log("   ", v.emails.join(", "));
    for (const [e, n] of [...v.errs.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3)) {
        console.log("    err", n, e);
    }
}

console.log("\n==== each ====");
for (const r of rows) {
    const f = flags(r.google_state);
    console.log(r.email, "pwstat="+r.pw_status, "imap="+r.has_imap, "rot="+f.totp_rot,
        "t="+f.totp, "p="+f.pw, "i="+f.imap, "|", f.err);
}
await pool.end();
