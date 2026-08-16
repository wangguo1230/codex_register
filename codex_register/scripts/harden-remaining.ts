// 补跑：删辅助邮箱 + 换 Google 2FA（密码已改过的号）
import pg from "pg";
import {chromium} from "playwright-core";
import {createBitWindow, openBitWindow, closeBitWindow, deleteBitWindow, bitHealth} from "../src/bitbrowser.js";
import {ensureGoogleLoggedIn} from "../src/mail/google-auth.js";
import {removeRecoveryEmail} from "../src/mail/google-secure.js";
import {change2faOnPage} from "../src/mail/google-manage.js";

const DATABASE_URL = process.env.DATABASE_URL || "postgresql://postgres:123456@192.168.1.126:5432/all_register";
const email = (process.argv[2] || "").trim().toLowerCase();
if (!email) process.exit(1);

const pool = new pg.Pool({connectionString: DATABASE_URL});
const {rows: [acc]} = await pool.query(
    "SELECT email,password,totp_secret,recovery_email FROM mailboxes WHERE email=$1 AND deleted_at=0",
    [email],
);
if (!acc) throw new Error("库中无此邮箱");
if (!await bitHealth()) throw new Error("比特未启动");

let bitId = "";
try {
    bitId = await createBitWindow({
        proxy: process.env.PROXY_URL || "",
        name: `fix-${email.split("@")[0].slice(0, 10)}`,
        remark: "gmail-harden-fix",
    });
    const {ws} = await openBitWindow(bitId);
    const browser = await chromium.connectOverCDP(ws);
    const page = (browser.contexts()[0] || await browser.newContext()).pages()[0]
        || await (browser.contexts()[0] || await browser.newContext()).newPage();
    page.setDefaultTimeout(30000);
    const cred = {
        email: acc.email, password: acc.password,
        totpSecret: acc.totp_secret, recoveryEmail: acc.recovery_email,
    };
    const ok = await ensureGoogleLoggedIn(page, "https://myaccount.google.com/recovery/email?hl=en", cred, console.log);
    if (!ok) throw new Error("登录失败");
    const rec = await removeRecoveryEmail(page, cred, console.log);
    const t = await change2faOnPage(page, {
        email: cred.email, password: cred.password,
        totpSecret: cred.totpSecret, recoveryEmail: rec?.ok ? "" : cred.recoveryEmail,
        log: console.log,
    });
    await pool.query(
        `UPDATE mailboxes SET totp_secret=COALESCE(NULLIF($1,''), totp_secret), recovery_email=$2 WHERE email=$3`,
        [t?.totpSecret || "", rec?.ok ? "" : acc.recovery_email, email],
    );
    console.log("RESULT", {recoveryCleared: !!rec?.ok, totp: !!(t?.ok && t.totpSecret), err: t?.error || rec?.error || ""});
} finally {
    if (bitId) { await closeBitWindow(bitId); await deleteBitWindow(bitId); }
    await pool.end();
}
