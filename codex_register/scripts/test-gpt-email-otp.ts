// 在降级登录页：填 Gmail → 点「继续」→ 用网页收件箱取 ChatGPT 验证码
import pg from "pg";
import {chromium} from "playwright-core";
import {getGoogleEmailVerificationCode} from "../src/mail/google-account.js";

const DATABASE_URL = process.env.DATABASE_URL || "postgresql://postgres:123456@192.168.1.126:5432/all_register";
const email = (process.argv[2] || "").trim().toLowerCase();
const proxyUrl = (process.argv[3] || process.env.PROXY_URL || "").trim();
if (!email) process.exit(1);

function parseProxy(url: string) {
    if (!url) return undefined;
    try {
        const u = new URL(url);
        const opt: any = {server: `${u.protocol}//${u.host}`};
        if (u.username) opt.username = decodeURIComponent(u.username);
        if (u.password) opt.password = decodeURIComponent(u.password);
        return opt;
    } catch { return {server: url}; }
}

async function main() {
    const pool = new pg.Pool({connectionString: DATABASE_URL});
    const {rows} = await pool.query(`SELECT email FROM mailboxes WHERE email=$1`, [email]);
    await pool.end();
    if (!rows[0]) throw new Error("库中无此邮箱");

    const launchOpts: any = {channel: "chrome", headless: false, args: ["--disable-blink-features=AutomationControlled"]};
    const po = parseProxy(proxyUrl);
    if (po) launchOpts.proxy = po;
    const browser = await chromium.launch(launchOpts);
    try {
        const ctx = await browser.newContext({locale: "zh-CN", viewport: {width: 1280, height: 900}});
        const page = await ctx.newPage();
        page.setDefaultTimeout(30000);
        await page.goto("https://chatgpt.com/auth/login", {waitUntil: "domcontentloaded", timeout: 60000});
        await page.waitForTimeout(5000);
        console.log("start url", page.url());

        const emailEl = page.locator("#email, input[type='email'], input[name='email'], input[placeholder*='Email' i]").first();
        await emailEl.waitFor({state: "visible", timeout: 20000});
        await emailEl.click();
        await emailEl.fill("");
        await emailEl.pressSequentially(email, {delay: 40});
        await page.waitForTimeout(800);
        console.log("email value", await emailEl.inputValue());

        const btn = page.getByRole("button", {name: /^\s*(继续|Continue)\s*$/i}).first();
        console.log("continue visible", await btn.isVisible().catch(() => false), "enabled", await btn.isEnabled().catch(() => false));
        if (await btn.isEnabled().catch(() => false)) await btn.click();
        else await emailEl.press("Enter");
        await page.waitForTimeout(6000);
        console.log("after submit", page.url());
        const body = (await page.innerText("body").catch(() => "")).replace(/\s+/g, " ").slice(0, 280);
        console.log("body", body);
        await page.screenshot({path: `captures/screenshots/gpt_otp_${email.split("@")[0]}.png`}).catch(() => {});

        const gptPassword = process.env.GPT_PASSWORD || "Gpt@Gmail1fAreed";
        let codeVisible = await page.locator('input[autocomplete="one-time-code"], input[inputmode="numeric"], input[name*="code" i]').first().isVisible().catch(() => false);
        let pwVisible = await page.locator('input[type="password"]').first().isVisible().catch(() => false);
        console.log("codeVisible", codeVisible, "pwVisible", pwVisible);
        if (!codeVisible && !pwVisible && !/email-verification|create-account|password/i.test(page.url())) {
            throw new Error("提交后未进入验证码/密码页");
        }
        if (pwVisible || /create-account\/password|password/i.test(page.url())) {
            const pwEl = page.locator('input[type="password"]').first();
            await pwEl.click();
            await pwEl.fill("");
            await pwEl.pressSequentially(gptPassword, {delay: 40});
            console.log("filled gpt password");
            const next = page.getByRole("button", {name: /^\s*(继续|Continue)\s*$/i}).first();
            if (await next.isVisible().catch(() => false)) await next.click();
            else await pwEl.press("Enter");
            await page.waitForTimeout(8000);
            console.log("after password", page.url());
            await page.screenshot({path: `captures/screenshots/gpt_after_pw_${email.split("@")[0]}.png`}).catch(() => {});
            codeVisible = await page.locator('input[autocomplete="one-time-code"], input[inputmode="numeric"], input[name*="code" i]').first().isVisible().catch(() => false);
        }
        if (codeVisible || /email-verification/i.test(page.url())) {
            console.log("fetching gmail otp…");
            const code = await getGoogleEmailVerificationCode(email);
            console.log("otp", code);
            const inp = page.locator('input[autocomplete="one-time-code"], input[inputmode="numeric"], input[name*="code" i]').first();
            await inp.fill(code);
            await page.waitForTimeout(800);
            const next = page.getByRole("button", {name: /^\s*(继续|Continue|验证|Verify)\s*$/i}).first();
            if (await next.isVisible().catch(() => false)) await next.click();
            else await inp.press("Enter");
            for (let i = 0; i < 12; i++) {
                await page.waitForTimeout(2500);
                console.log("after otp", i, page.url());
                if (!/email-verification|create-account|auth\.openai/i.test(page.url()) || /chatgpt\.com\/($|\?|#)/.test(page.url())) break;
            }
            const body2 = (await page.innerText("body").catch(() => "")).replace(/\s+/g, " ").slice(0, 240);
            console.log("final body", body2);
            await page.screenshot({path: `captures/screenshots/gpt_after_otp_${email.split("@")[0]}.png`}).catch(() => {});
        }
    } finally {
        await browser.close().catch(() => {});
    }
}

main().catch((e) => { console.error(e); process.exit(1); });
