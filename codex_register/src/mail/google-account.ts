// @ts-nocheck
// Gmail 老号 provider:用邮箱+密码(+TOTP/辅助邮箱)收 ChatGPT 验证码。
// 默认/GPT 注册：只走 IMAP（必须有应用专用密码）；无 IMAP 直接报错。
// allowWebFallback=true 时才允许 Playwright 登录 mail.google.com 扒信。
// 凭证来自 MAILCOM_TOKENS_FILE,扩展列: email----password----totp----recovery----imap
import {readFileSync, existsSync} from "node:fs";
import path from "node:path";
import {chromium} from "playwright-core";
import {ImapFlow} from "imapflow";
import {findLatestVerificationMail} from "./verification-matcher.js";
import {ensureGoogleLoggedIn} from "./google-auth.js";

const POOL_FILE = process.env.MAILCOM_TOKENS_FILE
    || process.env.GOOGLE_TOKENS_FILE
    || path.resolve(process.cwd(), "google", "tokens.txt");

const POLL_ATTEMPTS = 4;
const POLL_INTERVAL_MS = 3000;
const passwordByEmail = new Map();
let pool = null;

function normalizeEmail(v) { return String(v || "").trim().toLowerCase(); }

export function parseGoogleCredLine(line) {
    const raw = String(line || "").trim();
    if (!raw) return null;
    const parts = raw.includes("----") ? raw.split("----").map((s) => s.trim()) : raw.split(/[\s,;|\t]+/).filter(Boolean);
    const email = normalizeEmail(parts[0]);
    if (!email.includes("@")) return null;
    return {
        email,
        password: parts[1] || "",
        totpSecret: parts[2] || "",
        recoveryEmail: parts[3] || "",
        imapPassword: parts[4] || "",
    };
}

function loadPool() {
    if (pool) return pool;
    if (!existsSync(POOL_FILE)) throw new Error(`未找到 Gmail 老号池文件: ${POOL_FILE}(每行 email----password----totp----recovery)`);
    pool = readFileSync(POOL_FILE, "utf8").split(/\r?\n/).map(parseGoogleCredLine).filter((x) => x?.email && x.password);
    if (!pool.length) throw new Error("Gmail 老号池为空");
    for (const it of pool) passwordByEmail.set(it.email, it);
    return pool;
}

export function resolveGoogleCred(email) {
    const key = normalizeEmail(email);
    if (passwordByEmail.has(key)) return passwordByEmail.get(key);
    loadPool();
    if (passwordByEmail.has(key)) return passwordByEmail.get(key);
    throw new Error(`Gmail 老号池中找不到: ${email}`);
}

/** 把库里的 Gmail 凭证记进内存，IMAP 取码不必再读 tokens 文件。 */
export function rememberGoogleCred(partial) {
    const key = normalizeEmail(partial?.email);
    if (!key) return null;
    const cred = passwordByEmail.get(key) || {email: key, password: "", totpSecret: "", recoveryEmail: "", imapPassword: ""};
    if (partial.password != null) cred.password = String(partial.password || "");
    if (partial.totpSecret != null || partial.totp_secret != null) cred.totpSecret = String(partial.totpSecret || partial.totp_secret || "");
    if (partial.recoveryEmail != null || partial.recovery_email != null) cred.recoveryEmail = String(partial.recoveryEmail || partial.recovery_email || "");
    if (partial.imapPassword != null || partial.imap_password != null) cred.imapPassword = String(partial.imapPassword || partial.imap_password || "");
    passwordByEmail.set(key, cred);
    return cred;
}

/** 注册过程中把刚生成的应用专用密码记进内存，后续 IMAP 取码不用再读文件。 */
export function rememberGoogleImapPassword(email, imapPassword) {
    const key = normalizeEmail(email);
    const cred = passwordByEmail.get(key) || {email: key, password: "", totpSecret: "", recoveryEmail: ""};
    cred.imapPassword = String(imapPassword || "");
    passwordByEmail.set(key, cred);
}

/** 只走 IMAP 轮询 ChatGPT 验证码（换绑/注册都可复用）。 */
/** deadlineMs：绝对截止时间戳。换绑用它保证 verify 还落在 pwd_auth 窗口内。 */
export async function waitGoogleImapOtp(cred, {minTimestampMs = 0, excludeCode = "", attempts = 16, intervalMs = 5000, deadlineMs = 0} = {}) {
    const c = rememberGoogleCred(cred) || cred;
    let lastErr = "";
    const n = Math.max(1, Number(attempts) || 16);
    const overBudget = () => deadlineMs > 0 && Date.now() >= deadlineMs;
    for (let i = 0; i < n; i++) {
        if (overBudget()) break;
        console.log(`[google] IMAP 收码 ${i + 1}/${n} ${c.email}`);
        try {
            const code = await tryImapOtp(c, {minTimestampMs, excludeCode, deadlineMs});
            if (code) {
                console.log(`[google] IMAP 拿到验证码 ${code}`);
                return code;
            }
        } catch (e) {
            lastErr = String(e?.message || e);
            console.log(`[google] IMAP 不可用(${lastErr.slice(0, 80)})`);
        }
        if (i < n - 1 && !overBudget()) await new Promise((r) => setTimeout(r, intervalMs));
    }
    if (overBudget()) {
        throw new Error(`IMAP 取码超预算，未拿到 ChatGPT 验证码${lastErr ? `(${lastErr.slice(0, 80)})` : ""}: ${c.email}`);
    }
    throw new Error(`IMAP 未拿到 ChatGPT 验证码${lastErr ? `(${lastErr.slice(0, 80)})` : ""}: ${c.email}`);
}

let livePage = null;
/** 把当前比特窗口的 page 绑上，OTP 优先在同一会话扒信，避免再开一个 Chrome。 */
export function bindGoogleLivePage(page) { livePage = page; }
export function unbindGoogleLivePage() { livePage = null; }

function parseProxyOpt(url) {
    if (!url) return undefined;
    try {
        const u = new URL(url);
        const opt = {server: `${u.protocol}//${u.host}`};
        if (u.username) opt.username = decodeURIComponent(u.username);
        if (u.password) opt.password = decodeURIComponent(u.password);
        return opt;
    } catch { return {server: url}; }
}

function imapViaList() {
    const out = [];
    const push = (u) => {
        const s = String(u || "").trim();
        if (s && !out.includes(s)) out.push(s);
    };
    push(process.env.IMAP_PROXY || "");
    push("socks5://127.0.0.1:10808");
    push("socks5://127.0.0.1:10811");
    return ["", ...out];
}

async function collectMailboxCandidates(client, box, limit, minTimestampMs) {
    try {
        const lock = await client.getMailboxLock(box);
        try {
            const status = await client.status(box, {messages: true});
            const total = Number(status?.messages || 0);
            if (!total) return [];
            const start = Math.max(1, total - Math.max(8, limit) + 1);
            const out = [];
            const since = (minTimestampMs || Date.now()) - 30 * 60 * 1000;
            for await (const msg of client.fetch(`${start}:*`, {envelope: true, source: true})) {
                const ts = msg?.envelope?.date?.getTime?.() || 0;
                if (ts && ts < since) continue;
                const src = msg?.source ? msg.source.toString("utf8") : "";
                const subject = msg?.envelope?.subject || "";
                const from = (msg?.envelope?.from || []).map((x) => x.address || "").join(" ");
                out.push({subject, from, content: src, timestamp: ts});
            }
            return out;
        } finally {
            try { lock.release(); } catch { /* */ }
        }
    } catch {
        return [];
    }
}

async function tryImapOtpOnce(cred, {minTimestampMs = 0, excludeCode = "", proxy = ""} = {}) {
    const client = new ImapFlow({
        host: "imap.gmail.com",
        port: 993,
        secure: true,
        auth: {user: cred.email, pass: cred.imapPassword || cred.password},
        logger: false,
        emitLogs: false,
        connectionTimeout: 16_000,
        greetingTimeout: 12_000,
        socketTimeout: 20_000,
        ...(proxy ? {proxy} : {}),
    });
    client.on("error", () => {});
    try {
        await client.connect();
        const boxes = ["INBOX", "[Gmail]/Spam", "[Gmail]/All Mail", "Junk"];
        const candidates = [];
        for (const box of boxes) {
            const part = await collectMailboxCandidates(client, box, box === "INBOX" ? 20 : 10, minTimestampMs);
            candidates.push(...part);
        }
        await client.logout().catch(() => {});
        const found = findLatestVerificationMail(candidates, {targetEmail: cred.email, excludeCode});
        if (found?.verificationCode) return found.verificationCode;
    } catch (e) {
        try { await client.logout(); } catch { /* */ }
        throw e;
    }
    return "";
}

async function tryImapOtp(cred, {minTimestampMs = 0, excludeCode = "", deadlineMs = 0} = {}) {
    let lastErr = "";
    for (const via of imapViaList()) {
        // 一轮要试 4 个出口、每个 connectionTimeout 16s，不在出口之间看截止时间的话
        // 单轮就能冲过整个取码预算（换绑那边靠这个预算保证 verify 落在 pwd_auth 窗口内）
        if (deadlineMs && Date.now() >= deadlineMs) break;
        try {
            return await tryImapOtpOnce(cred, {minTimestampMs, excludeCode, proxy: via});
        } catch (e) {
            lastErr = String(e?.message || e);
            if (!/Unexpected close|ECONNRESET|ETIMEDOUT|timeout|Socket timeout|closed|EPIPE|proxy/i.test(lastErr)) {
                throw e;
            }
        }
    }
    if (lastErr) throw new Error(lastErr);
    return "";
}

async function scrapeGmailWebOtp(page, email, excludeCode = "") {
    const searches = [
        "https://mail.google.com/mail/u/0/#search/openai",
        "https://mail.google.com/mail/u/0/#inbox",
    ];
    const candidates = [];
    for (const url of searches) {
        await page.goto(url, {waitUntil: "domcontentloaded", timeout: 45000}).catch(() => {});
        await page.waitForTimeout(1500);
        if (/workspace\.google\.com/i.test(page.url())) {
            console.log("[google] scrape landed on workspace marketing page, skip");
            continue;
        }
        const rows = page.locator("tr.zA");
        const n = Math.min(await rows.count(), 8);
        console.log(`[google] scrape ${url.split("#")[1] || "inbox"} rows=${n} url=${page.url().slice(0, 80)}`);
        for (let i = 0; i < n; i++) {
            try {
                await rows.nth(i).click({timeout: 3000});
                await page.waitForTimeout(1200);
                const body = await page.locator(".a3s, [data-message-id] .a3s").first().innerText({timeout: 4000}).catch(() => "");
                const subject = await page.locator("h2.hP, h2[data-legacy-thread-id]").first().innerText().catch(() => "");
                candidates.push({subject, from: "openai", content: body, timestamp: Date.now() - i * 1000});
                if (i === 0) console.log(`[google] first mail subject=${String(subject).slice(0, 60)} body=${String(body).replace(/\s+/g, " ").slice(0, 120)}`);
                await page.keyboard.press("Escape").catch(() => {});
                await page.waitForTimeout(300);
            } catch { /* next */ }
        }
        if (!n) {
            const text = String(await page.innerText("body").catch(() => ""));
            candidates.push({subject: "page", from: "openai", content: text, timestamp: Date.now()});
        }
        const found = findLatestVerificationMail(candidates, {targetEmail: email, excludeCode});
        if (found?.verificationCode) return found.verificationCode;
    }
    return "";
}

export async function launchGoogleBrowser({proxyUrl = "", headless} = {}) {
    const launchOpts = {
        channel: "chrome",
        // 显式 headless 优先；否则沿用环境变量（默认 headed 方便人工看窗）
        headless: headless !== undefined
            ? !!headless
            : (process.env.MAILCOM_HEADLESS === "1" && process.env.GOOGLE_HEADED !== "1"),
        args: ["--disable-blink-features=AutomationControlled"],
    };
    const po = parseProxyOpt(proxyUrl || process.env.MAILCOM_PROXY || process.env.PROXY_URL || "");
    if (po) launchOpts.proxy = po;
    return chromium.launch(launchOpts);
}

export async function getGoogleEmailVerificationCode(email, options = {}) {
    const cred = resolveGoogleCred(email);
    const excludeCode = options.excludeCode || "";
    const minTimestampMs = options.minTimestampMs || 0;
    // GPT 注册 / 默认：必须 IMAP；无应用密码直接报错，禁止悄悄改走网页收件箱
    const allowWebFallback = options.allowWebFallback === true;
    const hasImap = !!(cred.imapPassword && String(cred.imapPassword).trim());

    if (!hasImap) {
        throw new Error(`Gmail 没有 IMAP 应用密码，不能收验证码（GPT 注册必须走 IMAP）: ${email}`);
    }

    let imapErr = "";
    for (let i = 0; i < 16; i++) {
        console.log(`[google] IMAP 收码 ${i + 1}/16 ${email}`);
        try {
            const imapCode = await tryImapOtp(cred, {minTimestampMs, excludeCode});
            if (imapCode) {
                console.log(`[google] IMAP 拿到验证码 ${imapCode}`);
                return imapCode;
            }
        } catch (e) {
            imapErr = String(e?.message || e);
            console.log(`[google] IMAP 不可用(${imapErr.slice(0, 80)})，稍后重试`);
        }
        if (i < 15) await new Promise((r) => setTimeout(r, 5000));
    }
    if (!allowWebFallback) {
        throw new Error(`IMAP 未拿到 ChatGPT 验证码${imapErr ? `(${imapErr.slice(0, 80)})` : ""}: ${email}`);
    }
    console.log(`[google] IMAP 失败，allowWebFallback 改走网页收件箱`);

    const reuse = livePage;
    let browser = null;
    let page = null;
    let openedTab = false;
    try {
        if (reuse) {
            // 必须新开标签：ChatGPT 验证码页还在原 tab，不能把同一页跳去 Gmail
            page = await reuse.context().newPage();
            page.setDefaultTimeout(30000);
            openedTab = true;
            console.log("[google] 在已登录的比特窗口新开标签收件箱");
            await page.goto("https://mail.google.com/mail/u/0/", {waitUntil: "domcontentloaded", timeout: 60000}).catch(() => {});
            await page.waitForTimeout(2500);
        } else {
            browser = await launchGoogleBrowser();
            const ctx = await browser.newContext({locale: "en-US", viewport: {width: 1280, height: 860}});
            page = await ctx.newPage();
            page.setDefaultTimeout(30000);
            const ok = await ensureGoogleLoggedIn(
                page,
                "https://mail.google.com/mail/u/0/",
                {
                    email: cred.email, password: cred.password,
                    totpSecret: cred.totpSecret, recoveryEmail: cred.recoveryEmail,
                },
                (m) => console.log(`[google] ${m}`),
            );
            if (!ok) throw new Error("Google 登录失败,无法收 ChatGPT 验证码");
        }
        for (let attempt = 1; attempt <= POLL_ATTEMPTS; attempt++) {
            console.log(`[google] pollOtp attempt=${attempt}/${POLL_ATTEMPTS} email=${email}`);
            const code = await scrapeGmailWebOtp(page, email, excludeCode);
            if (code) { console.log(`[google] 网页收件箱拿到验证码 ${code}`); return code; }
            await page.waitForTimeout(POLL_INTERVAL_MS);
        }
        throw new Error(`Gmail 中未找到 ChatGPT 验证码: ${email}`);
    } finally {
        if (openedTab && page) await page.close().catch(() => {});
        if (browser) await browser.close().catch(() => {});
    }
}

export function createGoogleAccountProvider() {
    return {
        async getEmailAddress() {
            const accounts = loadPool();
            return accounts[0].email;
        },
        async getEmailVerificationCode(email, options) {
            return getGoogleEmailVerificationCode(email, options);
        },
        async getMailboxCredential(email) {
            const c = resolveGoogleCred(email);
            return {email: c.email, password: c.password};
        },
    };
}
