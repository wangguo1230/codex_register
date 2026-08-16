// 实测 Gmail 老号：IMAP + 网页登录 + 打开收件箱
// 用法: npx tsx scripts/test-google-login.ts [email]
import pg from "pg";
import {ImapFlow} from "imapflow";
import {ensureGoogleLoggedIn} from "../src/mail/google-auth.js";
import {launchGoogleBrowser} from "../src/mail/google-account.js";
import {generateTotp} from "../src/mfa.js";

const DATABASE_URL = process.env.DATABASE_URL || "postgresql://postgres:123456@192.168.1.126:5432/all_register";
const ONLY = (process.argv[2] || "").trim().toLowerCase();

async function loadAccounts() {
    const pool = new pg.Pool({connectionString: DATABASE_URL});
    const {rows} = await pool.query(
        `SELECT id, email, password, totp_secret, recovery_email
         FROM mailboxes WHERE grp='gmail-old-test' AND deleted_at=0 ORDER BY id`,
    );
    await pool.end();
    return ONLY ? rows.filter((r) => String(r.email).toLowerCase() === ONLY) : rows;
}

async function tryImap(email: string, password: string) {
    const client = new ImapFlow({
        host: "imap.gmail.com", port: 993, secure: true,
        auth: {user: email, pass: password},
        logger: false,
    });
    try {
        await client.connect();
        const lock = await client.getMailboxLock("INBOX");
        const status = await client.status("INBOX", {messages: true});
        lock.release();
        await client.logout().catch(() => {});
        return {ok: true, messages: status?.messages ?? 0};
    } catch (e: any) {
        try { await client.logout(); } catch { /* */ }
        return {ok: false, error: String(e?.message || e).slice(0, 160)};
    }
}

async function tryWebLogin(acc: {email: string; password: string; totp_secret: string; recovery_email: string}) {
    const logs: string[] = [];
    const browser = await launchGoogleBrowser();
    try {
        const ctx = await browser.newContext({locale: "en-US", viewport: {width: 1280, height: 860}});
        const page = await ctx.newPage();
        page.setDefaultTimeout(30000);
        const ok = await ensureGoogleLoggedIn(
            page,
            "https://mail.google.com/mail/u/0/#inbox",
            {
                email: acc.email,
                password: acc.password,
                totpSecret: acc.totp_secret,
                recoveryEmail: acc.recovery_email,
            },
            (m) => {
                logs.push(m);
                console.log(`[${acc.email}] ${m}`);
            },
        );
        const url = page.url();
        let inboxHint = "";
        try { inboxHint = (await page.innerText("body")).slice(0, 180).replace(/\s+/g, " "); } catch { /* */ }
        if (!ok) {
            await page.screenshot({path: `captures/screenshots/login_fail_${acc.email.split("@")[0]}.png`}).catch(() => {});
        }
        return {ok, url, inboxHint, logs};
    } finally {
        await browser.close().catch(() => {});
    }
}

async function main() {
    const accounts = await loadAccounts();
    if (!accounts.length) {
        console.error("没有可测账号");
        process.exit(1);
    }
    const results = [];
    for (const acc of accounts) {
        console.log("\n==========", acc.email, "==========");
        console.log("totp now =", generateTotp(acc.totp_secret || ""));
        const imap = await tryImap(acc.email, acc.password);
        console.log("IMAP", imap);
        const web = await tryWebLogin(acc);
        console.log("WEB ok=", web.ok, "url=", web.url);
        console.log("WEB hint=", web.inboxHint);
        results.push({email: acc.email, imap, webOk: web.ok, url: web.url, hint: web.inboxHint});
    }
    console.log("\n===== SUMMARY =====");
    console.log(JSON.stringify(results, null, 2));
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
