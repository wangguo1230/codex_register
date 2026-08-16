/**
 * 对已换 2FA、只差 IMAP 的号做实测：登录后生成应用密码。
 * SSL / 生成被拒时先刷新页面再试（用户说刷新有时能过）。
 * 成功则写回 imap_password。
 *
 *   npx tsx scripts/test-imap-refresh.ts email1 email2 ...
 */
import pg from "pg";
import {readFileSync} from "node:fs";
import {withGoogleBitSession} from "../src/mail/google-secure.ts";
import {ensureGoogleLoggedIn, recoverSslOrSlowPage, googleSslDead} from "../src/mail/google-auth.ts";
import {createGmailAppPassword} from "../src/mail/google-imap.ts";
import {mintStickySession} from "../src/mail/proxy-pool.ts";
import {applyMailboxUpdate, refreshMailboxGoogleState} from "../server/db.ts";

const DATABASE_URL = process.env.DATABASE_URL || "postgresql://postgres:123456@192.168.1.126:5432/all_register";
const APP_PW = "https://myaccount.google.com/apppasswords?hl=en";
const emails = process.argv.slice(2).map((s) => s.trim().toLowerCase()).filter(Boolean);
if (!emails.length) {
    console.log("usage: npx tsx scripts/test-imap-refresh.ts email...");
    process.exit(2);
}

function loadSettings() {
    return JSON.parse(readFileSync(new URL("../data/settings.json", import.meta.url), "utf8"));
}

const settings = loadSettings();
const poolLine = (settings.mailProxyPool || [])[0] || "";
const jumpUrl = String(settings.mailProxyJump || "").trim();
const pgPool = new pg.Pool({connectionString: DATABASE_URL});

async function one(email) {
    const {rows: [mb]} = await pgPool.query(`SELECT * FROM mailboxes WHERE email=$1 AND deleted_at=0`, [email]);
    if (!mb) return {email, ok: false, detail: "库里没有"};
    const proxyUrl = mintStickySession(poolLine);
    const log = (m) => console.log(`[${email.split("@")[0]}] ${m}`);
    log(`测 IMAP 刷新  stage=${mb.google_stage} totp=${!!mb.totp_secret} imap=${!!mb.imap_password}`);
    try {
        const secret = await withGoogleBitSession({
            proxyUrl, jumpUrl, name: `imap-test-${email.split("@")[0].slice(0, 10)}`,
            remark: "imap-refresh-test", log,
        }, async (page, sess) => {
            const ok = await ensureGoogleLoggedIn(page, APP_PW, {
                email: mb.email, password: mb.password, totpSecret: mb.totp_secret,
                recoveryEmail: mb.recovery_email || "", requireInbox: false,
            }, log);
            if (!ok) throw new Error("登录未过");
            sess?.markLoggedIn?.();
            log(`已进账号 url=${String(page.url()).slice(0, 80)}`);
            let last = "";
            for (let i = 0; i < 3; i++) {
                if (i) {
                    log(`刷新应用密码页再试 ${i}/2`);
                    if (await googleSslDead(page)) {
                        await recoverSslOrSlowPage(page, log, APP_PW, 3);
                    } else {
                        try { await page.reload({waitUntil: "domcontentloaded", timeout: 60000}); } catch { /* */ }
                        await page.waitForTimeout(2500);
                        try { await page.goto(APP_PW, {waitUntil: "domcontentloaded", timeout: 60000}); } catch { /* */ }
                        await page.waitForTimeout(2000);
                    }
                }
                try {
                    const pw = await createGmailAppPassword(page, {
                        email: mb.email, password: mb.password,
                        totpSecret: mb.totp_secret, totpFallback: "", log,
                    });
                    if (pw) return pw;
                } catch (e) {
                    last = String(e?.message || e).split("\n")[0];
                    log(`第 ${i + 1} 次未拿到: ${last}`);
                    if (!/拒绝生成|未能提取|SSL|二次验证/i.test(last)) throw e;
                }
            }
            throw new Error(last || "三次刷新仍无应用密码");
        });
        if (secret) {
            await applyMailboxUpdate(mb.email, {imap_password: secret});
            await refreshMailboxGoogleState(mb.id, {login: "ok", imap: "ok", totp_rotated: true}).catch(() => {});
            log(`写回 IMAP ${secret.slice(0, 4)}****`);
            return {email, ok: true, detail: "IMAP 已写入"};
        }
        return {email, ok: false, detail: "空密码"};
    } catch (e) {
        return {email, ok: false, detail: String(e?.message || e).split("\n")[0].slice(0, 180)};
    }
}

const out = [];
for (const em of emails) {
    console.log(`\n======== ${em} ========`);
    const r = await one(em);
    out.push(r);
    console.log("RESULT", JSON.stringify(r));
}
console.log("\nSUMMARY", JSON.stringify(out, null, 2));
await pgPool.end();
process.exit(out.every((r) => r.ok) ? 0 : 1);
