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
        imapLog(`[google] IMAP 收码 ${i + 1}/${n} ${c.email}`);
        try {
            const code = await tryImapOtp(c, {minTimestampMs, excludeCode, deadlineMs});
            if (code) {
                imapLog(`[google] IMAP 拿到验证码 ${code}`);
                return code;
            }
            imapLog(`[google] IMAP 本轮没有新验证码，${Math.round(intervalMs / 1000)}s 后再看`);
        } catch (e) {
            lastErr = String(e?.message || e);
            imapLog(`[google] IMAP 不可用(${lastErr.slice(0, 100)})，${Math.round(intervalMs / 1000)}s 后换出口重试`);
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

function imapLog(msg) {
    console.log(msg);
    try { process.stdout.write(""); } catch { /* */ }
}

function imapViaList() {
    const out = [];
    const push = (u) => {
        const s = String(u || "").trim();
        if (!s || out.includes(s)) return;
        // MAILCOM_PROXY 空串常被拼成 socks5:// ，ImapFlow 会一直挂到超时、中间没日志
        if (/^socks5h?:\/\/:?\d*$/i.test(s) || /^https?:\/\/:?\d*$/i.test(s)) return;
        try {
            const parsed = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s.split("#")[0] : `socks5://${s}`);
            if (!parsed.hostname) return;
        } catch { return; }
        out.push(s);
    };
    push(process.env.IMAP_PROXY || "");
    push(process.env.MAILCOM_PROXY || "");
    push("socks5://127.0.0.1:10808");
    return ["", ...out];
}

function decodeQuotedPrintable(s) {
    return String(s || "")
        .replace(/=\r?\n/g, "")
        .replace(/=([0-9A-Fa-f]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
}

/** 从 RFC822 抽出可读正文。OpenAI 登录码是 quoted-printable HTML，主题里没有 6 位数字。 */
function decodeMimeSource(raw) {
    const s = Buffer.isBuffer(raw) ? raw.toString("utf8") : String(raw || "");
    const blank = s.search(/\r?\n\r?\n/);
    const head = blank >= 0 ? s.slice(0, blank) : s.slice(0, 4000);
    let body = blank >= 0 ? s.slice(blank).replace(/^\s+/, "") : s;
    if (/quoted-printable/i.test(head)) body = decodeQuotedPrintable(body);
    else if (/base64/i.test(head) && !/multipart/i.test(head)) {
        try {
            const b64 = body.replace(/\s+/g, "");
            if (b64.length > 40 && b64.length % 4 === 0) body = Buffer.from(b64, "base64").toString("utf8");
        } catch { /* keep */ }
    }
    return body
        .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, " ")
        .replace(/<br\s*\/?>/gi, "\n")
        .replace(/<\/(p|div|tr|li|h[1-6])>/gi, "\n")
        .replace(/<[^>]+>/g, " ")
        .replace(/&nbsp;/gi, " ")
        .replace(/&#39;/g, "'")
        .replace(/&amp;/gi, "&")
        .replace(/\s+/g, " ")
        .trim();
}

function isChatGptLoginMail(m) {
    return /login code|verification code|temporary code|security code|验证码|临时.*码/i.test(
        `${m?.subject || ""} ${String(m?.content || "").slice(0, 400)}`,
    );
}

async function collectMailboxCandidates(client, box, limit, minTimestampMs) {
    try {
        const lock = await client.getMailboxLock(box);
        try {
            const status = await client.status(box, {messages: true});
            const total = Number(status?.messages || 0);
            if (!total) return [];
            const start = Math.max(1, total - Math.max(8, limit) + 1);
            // 调用方传了 minTimestampMs 就按它（再留 2 分钟时钟偏差），不要再减 30 分钟把套餐/欢迎信捞进来
            const since = minTimestampMs > 0
                ? minTimestampMs - 2 * 60 * 1000
                : Date.now() - 30 * 60 * 1000;
            const metas = [];
            for await (const msg of client.fetch(`${start}:*`, {envelope: true, uid: true})) {
                const ts = msg?.envelope?.date?.getTime?.() || 0;
                if (ts && ts < since) continue;
                const subject = String(msg?.envelope?.subject || "");
                const from = (msg?.envelope?.from || []).map((x) => x.address || "").join(" ");
                const uid = Number(msg.uid || 0);
                if (!uid) continue;
                metas.push({uid, subject, from, timestamp: ts});
            }
            const interesting = metas.filter((m) =>
                /openai|chatgpt|verify|verification|login code|验证码/i.test(`${m.subject} ${m.from}`)
            ).slice(-8);
            if (!interesting.length) {
                imapLog(`[google] IMAP ${box} 近${total}封里没有 OpenAI 登录信`);
                return [];
            }
            const want = new Set(interesting.map((m) => m.uid));
            const byUid = new Map(interesting.map((m) => [m.uid, m]));
            const out = [];
            // ImapFlow：第三参 {uid:true} 才是 UID FETCH。第二参里的 uid 只表示“响应里带 UID”。
            // 以前把 UID 当序号去拉，邮箱有删信缺口时就会空返回，日志却像“连上了但没验证码”。
            for await (const msg of client.fetch(interesting.map((m) => m.uid), {source: true, uid: true}, {uid: true})) {
                const uid = Number(msg.uid || 0);
                if (!want.has(uid)) continue;
                const meta = byUid.get(uid);
                const decoded = decodeMimeSource(msg?.source);
                const content = decoded.length > 20_000 ? decoded.slice(0, 20_000) : decoded;
                out.push({
                    subject: meta?.subject || "",
                    from: meta?.from || "",
                    content: content || meta?.subject || "",
                    extraTexts: [meta?.subject || ""],
                    timestamp: meta?.timestamp || 0,
                });
            }
            imapLog(`[google] IMAP ${box} 候选${interesting.length} 正文${out.length} uid=${interesting.map((m) => m.uid).join(",")}`);
            if (interesting.length && !out.length) {
                imapLog(`[google] IMAP ${box} UID 拉正文为空（先前当序号拉会整批丢掉）`);
            }
            return out;
        } finally {
            try { lock.release(); } catch { /* */ }
        }
    } catch (e) {
        imapLog(`[google] IMAP ${box} 扫信失败: ${String(e?.message || e).slice(0, 120)}`);
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
        const boxes = ["INBOX", "[Gmail]/Spam", "Junk"];
        const candidates = [];
        for (const box of boxes) {
            const part = await collectMailboxCandidates(client, box, box === "INBOX" ? 20 : 8, minTimestampMs);
            candidates.push(...part);
            if (part.some(isChatGptLoginMail)) break;
        }
        await client.logout().catch(() => {});
        const preferLogin = findLatestVerificationMail(candidates, {
            targetEmail: cred.email, excludeCode, candidateMatcher: isChatGptLoginMail,
        });
        if (preferLogin?.verificationCode) return preferLogin.verificationCode;
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
        const viaLabel = via ? via.replace(/\/\/([^/@]+)@/, "//***@") : "直连";
        imapLog(`[google] IMAP 试 ${viaLabel}`);
        try {
            return await tryImapOtpOnce(cred, {minTimestampMs, excludeCode, proxy: via});
        } catch (e) {
            lastErr = String(e?.message || e);
            imapLog(`[google] IMAP ${viaLabel} 失败: ${lastErr.slice(0, 100)}`);
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
        imapLog(`[google] IMAP 收码 ${i + 1}/16 ${email}`);
        try {
            const imapCode = await tryImapOtp(cred, {minTimestampMs, excludeCode});
            if (imapCode) {
                imapLog(`[google] IMAP 拿到验证码 ${imapCode}`);
                return imapCode;
            }
            imapLog(`[google] IMAP 本轮没有新验证码，5s 后再看`);
        } catch (e) {
            imapErr = String(e?.message || e);
            imapLog(`[google] IMAP 不可用(${imapErr.slice(0, 100)})，5s 后重试`);
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
