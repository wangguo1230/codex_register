// 用已验证的 Gmail 老号走 ChatGPT「使用 Google 账户继续」
// 用法: npx tsx scripts/test-gpt-google-sso.ts <email> [proxy]
import pg from "pg";
import {chromium} from "playwright-core";
import {googleLogin, isOnGoogleLoginPage} from "../src/mail/google-auth.js";

const DATABASE_URL = process.env.DATABASE_URL || "postgresql://postgres:123456@192.168.1.126:5432/all_register";
const email = (process.argv[2] || "").trim().toLowerCase();
const proxyUrl = (process.argv[3] || process.env.PROXY_URL || "").trim();
if (!email) {
    console.error("用法: npx tsx scripts/test-gpt-google-sso.ts <email> [proxy]");
    process.exit(1);
}

function parseProxy(url: string) {
    if (!url) return undefined;
    try {
        const u = new URL(url);
        const opt: any = {server: `${u.protocol}//${u.host}`};
        if (u.username) opt.username = decodeURIComponent(u.username);
        if (u.password) opt.password = decodeURIComponent(u.password);
        return opt;
    } catch {
        return {server: url};
    }
}

async function loadAcc(em: string) {
    const pool = new pg.Pool({connectionString: DATABASE_URL});
    const {rows} = await pool.query(
        `SELECT email, password, totp_secret, recovery_email FROM mailboxes WHERE email=$1 AND deleted_at=0`,
        [em],
    );
    await pool.end();
    if (!rows[0]) throw new Error("库中没有该邮箱");
    return rows[0];
}

async function clickGoogleContinue(page) {
    const tries = [
        page.getByRole("button", {name: /使用 Google 账户继续|Continue with Google/i}).first(),
        page.locator("button, a").filter({hasText: /使用 Google 账户继续|Continue with Google/i}).first(),
    ];
    for (const loc of tries) {
        if (await loc.isVisible({timeout: 4000}).catch(() => false)) {
            await loc.click();
            return true;
        }
    }
    return false;
}

async function main() {
    const acc = await loadAcc(email);
    console.log("account", acc.email, "proxy", proxyUrl || "(direct)");
    const launchOpts: any = {
        channel: "chrome",
        headless: false,
        args: ["--disable-blink-features=AutomationControlled"],
    };
    const po = parseProxy(proxyUrl);
    if (po) launchOpts.proxy = po;
    const browser = await chromium.launch(launchOpts);
    try {
        const ctx = await browser.newContext({locale: "zh-CN", viewport: {width: 1280, height: 900}});
        const page = await ctx.newPage();
        page.setDefaultTimeout(30000);
        console.log("open chatgpt login");
        await page.goto("https://chatgpt.com/auth/login", {waitUntil: "domcontentloaded", timeout: 60000});
        await page.waitForTimeout(4000);
        console.log("url", page.url());
        const popupPromise = page.waitForEvent("popup", {timeout: 8000}).catch(() => null);
        const clicked = await clickGoogleContinue(page);
        console.log("clicked google continue", clicked);
        const popup = await popupPromise;
        const authPage = popup || page;
        if (popup) console.log("google popup", popup.url());
        await authPage.waitForTimeout(2000);
        if (await isOnGoogleLoginPage(authPage)) {
            const ok = await googleLogin(authPage, {
                email: acc.email,
                password: acc.password,
                totpSecret: acc.totp_secret,
                recoveryEmail: acc.recovery_email,
                log: (m) => console.log("[google]", m),
            });
            console.log("googleLogin", ok, authPage.url());
            if (!ok) {
                await authPage.screenshot({path: `captures/screenshots/gpt_sso_fail_${acc.email.split("@")[0]}.png`}).catch(() => {});
                throw new Error("Google SSO 登录失败");
            }
        } else {
            console.log("not on google login, url=", authPage.url());
        }
        // 等回到 chatgpt
        for (let i = 0; i < 20; i++) {
            await page.waitForTimeout(2000);
            const u = page.url();
            console.log(`wait ${i} url=${u.slice(0, 80)}`);
            if (/chatgpt\.com/i.test(u) && !/auth\/login/i.test(u)) break;
        }
        const cookies = await ctx.cookies();
        const sess = cookies.find((c) => /__Secure-next-auth\.session-token|__Secure-next-auth.session-token/i.test(c.name) || c.name.includes("session-token"));
        const body = (await page.innerText("body").catch(() => "")).replace(/\s+/g, " ").slice(0, 220);
        console.log("FINAL url", page.url());
        console.log("sessionCookie", sess ? "yes" : "no", sess?.name || "");
        console.log("body", body);
        await page.screenshot({path: `captures/screenshots/gpt_sso_${acc.email.split("@")[0]}.png`}).catch(() => {});
    } finally {
        await browser.close().catch(() => {});
    }
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
