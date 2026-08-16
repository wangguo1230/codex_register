// 停在换 2FA 确认框，截图后窗口留 3 分钟方便看。
import {mkdirSync} from "node:fs";
import path from "node:path";
import pg from "pg";
import {clearMailboxJobStop} from "../src/mail/mailbox-job-stop.ts";
import {withGoogleBitSession} from "../src/mail/google-secure.ts";
import {ensureGoogleLoggedIn} from "../src/mail/google-auth.ts";
import {googleReauthPassword} from "../src/mail/google-auth.ts";
import {setMailProxyJump, pickLiveMailProxy} from "../src/mail/proxy-pool.ts";

const OUT = path.resolve(process.cwd(), "captures", "probe-2fa");
mkdirSync(OUT, {recursive: true});
const email = process.argv[2] || "hamedmeshao@gmail.com";

const {readFileSync} = await import("node:fs");
const s = JSON.parse(readFileSync(new URL("../data/settings.json", import.meta.url), "utf8"));
if (s.mailProxyJump) setMailProxyJump(String(s.mailProxyJump));
const poolLine = (s.mailProxyPool || [])[0] || "";

const pool = new pg.Pool({connectionString: "postgresql://postgres:123456@192.168.1.126:5432/all_register"});
const {rows} = await pool.query(`SELECT * FROM mailboxes WHERE email=$1`, [email]);
const mb = rows[0];
if (!mb) {
    console.log("no account", email);
    process.exit(1);
}
clearMailboxJobStop();
const picked = await pickLiveMailProxy(poolLine, {tries: 2, log: (m) => console.log("[代理]", m)});
console.log("SHOW", email, "proxy", picked.ok);

await withGoogleBitSession({
    proxyUrl: picked.ok ? picked.url : poolLine,
    name: `show-2fa-${email.split("@")[0].slice(0, 10)}`,
    remark: "gmail-harden",
    log: (m) => console.log(m),
}, async (page) => {
    const ok = await ensureGoogleLoggedIn(page, "https://myaccount.google.com/two-step-verification/authenticator?hl=en", {
        email: mb.email, password: mb.password, totpSecret: mb.totp_secret,
        recoveryEmail: mb.recovery_email || "", requireInbox: false,
    }, (m) => console.log(m));
    console.log("login", ok, page.url());
    await googleReauthPassword(page, {password: mb.password, totpSecret: mb.totp_secret, log: (m) => console.log(m)});
    try {
        await page.goto("https://myaccount.google.com/two-step-verification/authenticator?hl=en", {waitUntil: "domcontentloaded", timeout: 30000});
    } catch { /* */ }
    await googleReauthPassword(page, {password: mb.password, totpSecret: mb.totp_secret, log: (m) => console.log(m)});
    await page.waitForTimeout(2000);
    const btn = page.getByRole("button", {name: /change authenticator app/i}).first();
    if (await btn.isVisible({timeout: 8000}).catch(() => false)) {
        await btn.click();
        console.log("clicked Change authenticator app");
    } else {
        console.log("NO change button", String(await page.innerText("body").catch(() => "")).slice(0, 200));
    }
    await page.waitForTimeout(1500);
    const shot = path.join(OUT, `stuck_dialog_${Date.now()}.png`);
    await page.screenshot({path: shot, fullPage: true}).catch(() => {});
    const dlg = String(await page.locator('[role="dialog"], [role="alertdialog"]').first().innerText().catch(() => "")).slice(0, 400);
    console.log("DIALOG", dlg.replace(/\s+/g, " "));
    console.log("SHOT", shot);
    console.log("窗口停 180 秒，看比特里的确认框");
    await page.waitForTimeout(180000);
});
await pool.end();
