import pg from "pg";
import {deriveGoogleState, formatHardenListReason} from "../src/mail/google-state.ts";

const c = new pg.Client({connectionString: "postgresql://postgres:123456@192.168.1.126:5432/all_register"});
await c.connect();

const wiped = {
    email: "paxmofit@gmail.com",
    pw_status: "✅改密(已验证) 08-15 22:02",
    totp_secret: "HDXPKKZKZOFCIEZTTMW5V54TE3WJXXAM",
    imap_password: "",
    recovery_email: "",
    google_stage: "imported",
    google_state: {stage: "imported", last_error: "登录失败", proxy_rotates: 0, totp_rotated: true, login: "fail"},
};
const sim = deriveGoogleState(wiped, {login: "fail", last_error: "登录失败"});
console.log("wipe-sim", {
    stage: sim.stage,
    login: sim.login,
    last_error: sim.last_error,
    reason: formatHardenListReason({...wiped, google_state: sim, google_stage: sim.stage}),
});

const {rows} = await c.query(`SELECT * FROM mailboxes WHERE deleted_at=0 AND provider='google'`);
let n = 0;
const changed = [];
for (const mb of rows) {
    const next = deriveGoogleState(mb, {});
    const prev = mb.google_state && typeof mb.google_state === "object" ? mb.google_state : {};
    if (next.stage === mb.google_stage && next.login === prev.login && (next.last_error || "") === (prev.last_error || "")) continue;
    await c.query("UPDATE mailboxes SET google_state=$1::jsonb, google_stage=$2 WHERE id=$3", [JSON.stringify(next), next.stage, mb.id]);
    n += 1;
    changed.push({
        email: mb.email,
        grp: mb.grp,
        from: `${mb.google_stage}/${prev.login}/${String(prev.last_error || "").slice(0, 48)}`,
        to: `${next.stage}/${next.login}/${String(next.last_error || "").slice(0, 48)}`,
        reason: formatHardenListReason({...mb, google_state: next, google_stage: next.stage}),
    });
}
console.log("rewrote", n);
console.log(JSON.stringify(changed, null, 2));
const {rows: [pax]} = await c.query("SELECT * FROM mailboxes WHERE email=$1", ["paxmofit@gmail.com"]);
console.log("pax now", JSON.stringify({
    stage: pax.google_stage,
    st: pax.google_state,
    reason: formatHardenListReason(pax),
}, null, 2));
await c.end();
