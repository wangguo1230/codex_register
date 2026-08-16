// 比特窗口完整整备：删手机/辅助邮箱 → 换2FA → 改密 → 登出设备 → IMAP
import pg from "pg";
import {chromium} from "playwright-core";
import {createBitWindow, openBitWindow, closeBitWindow, deleteBitWindow, bitHealth} from "../src/bitbrowser.js";
import {ensureGoogleLoggedIn} from "../src/mail/google-auth.js";
import {hardenGoogleAccountOnPage} from "../src/mail/google-secure.js";

const DATABASE_URL = process.env.DATABASE_URL || "postgresql://postgres:123456@192.168.1.126:5432/all_register";
const email = (process.argv[2] || "").trim().toLowerCase();
if (!email) process.exit(1);

const pool = new pg.Pool({connectionString: DATABASE_URL});
const {rows: [acc]} = await pool.query(
    "SELECT email,password,totp_secret,recovery_email FROM mailboxes WHERE email=$1 AND deleted_at=0",
    [email],
);
if (!acc) throw new Error("库中无此邮箱");

if (!await bitHealth()) throw new Error("比特浏览器未启动");
let bitId = "";
try {
    bitId = await createBitWindow({
        proxy: process.env.PROXY_URL || "",
        name: `harden-${email.split("@")[0].slice(0, 10)}`,
        remark: "gmail-harden",
    });
    const {ws} = await openBitWindow(bitId);
    const browser = await chromium.connectOverCDP(ws);
    const ctx = browser.contexts()[0] || await browser.newContext();
    const page = ctx.pages()[0] || await ctx.newPage();
    page.setDefaultTimeout(30000);
    const cred = {
        email: acc.email,
        password: acc.password,
        totpSecret: acc.totp_secret,
        recoveryEmail: acc.recovery_email,
    };
    const ok = await ensureGoogleLoggedIn(page, "https://mail.google.com/mail/u/0/", cred, console.log);
    if (!ok) throw new Error("Gmail 登录失败");
    const h = await hardenGoogleAccountOnPage(page, cred, console.log);
    await pool.query(
        `UPDATE mailboxes SET password=$1, totp_secret=$2, recovery_email=$3, imap_password=COALESCE(NULLIF($4,''), imap_password)
         WHERE email=$5`,
        [h.password, h.totpSecret, h.recoveryCleared ? "" : acc.recovery_email, h.imapPassword || "", email],
    );
    console.log("RESULT", {
        ok: h.ok,
        recoveryCleared: h.recoveryCleared,
        phoneCleared: h.phoneCleared,
        sessions: h.sessionsSignedOut,
        imap: h.imapPassword ? "yes" : "no",
        errors: h.errors,
    });
} finally {
    if (bitId) { await closeBitWindow(bitId); await deleteBitWindow(bitId); }
    await pool.end();
}
