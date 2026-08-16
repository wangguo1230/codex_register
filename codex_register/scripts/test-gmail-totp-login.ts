// 只测 Google 登录 TOTP，不整备。默认用库里 ready 的号。
//   npx tsx scripts/test-gmail-totp-login.ts [email]
import pg from "pg";
import {readFileSync} from "node:fs";
import {withGoogleBitSession} from "../src/mail/google-secure.ts";
import {ensureGoogleLoggedIn} from "../src/mail/google-auth.ts";

const DATABASE_URL = process.env.DATABASE_URL || "postgresql://postgres:123456@192.168.1.126:5432/all_register";
const want = String(process.argv[2] || "").trim().toLowerCase();

function loadPoolLines() {
    try {
        const s = JSON.parse(readFileSync(new URL("../data/settings.json", import.meta.url), "utf8"));
        return Array.isArray(s.mailProxyPool) ? s.mailProxyPool.filter(Boolean) : [];
    } catch { return []; }
}

const pool = new pg.Pool({connectionString: DATABASE_URL});
const {rows} = await pool.query(
    want
        ? `SELECT * FROM mailboxes WHERE email=$1 AND deleted_at=0`
        : `SELECT * FROM mailboxes
           WHERE deleted_at=0 AND provider='google' AND COALESCE(sold_at,0)=0
             AND COALESCE(password,'')<>'' AND COALESCE(totp_secret,'')<>''
             AND google_stage IN ('ready','gpt_ok')
           ORDER BY id DESC LIMIT 1`,
    want ? [want] : [],
);
const mb = rows[0];
if (!mb) {
    console.log("NO_ACCOUNT");
    await pool.end();
    process.exit(2);
}
await pool.end();

const proxyUrl = loadPoolLines()[2] || loadPoolLines()[0] || "";
console.log("TEST", mb.email, "stage=", mb.google_stage, "totp_len=", String(mb.totp_secret || "").length);
const ok = await withGoogleBitSession({
    proxyUrl, name: "totp-test", remark: "totp-login-test",
    log: (m) => console.log(m),
}, async (page) => {
    const r = await ensureGoogleLoggedIn(page, "https://myaccount.google.com/security?hl=en", {
        email: mb.email,
        password: mb.password,
        totpSecret: mb.totp_secret,
        recoveryEmail: mb.recovery_email || "",
        requireInbox: false,
    }, (m) => console.log(m));
    console.log("URL", String(page.url()).slice(0, 120));
    console.log("BODY", String(await page.innerText("body").catch(() => "")).replace(/\s+/g, " ").slice(0, 220));
    return r;
});
console.log(ok ? "PASS 已进账号中心" : "FAIL 登录未过");
process.exit(ok ? 0 : 1);
