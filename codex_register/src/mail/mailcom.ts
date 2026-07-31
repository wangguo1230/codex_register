// @ts-nocheck
/**
 * mail.com 邮箱 provider —— 用 Playwright 登录 mail.com、截获 maillist 的 Bearer，
 * 再用同一浏览器会话(context.request 带全部 cookie)主动调 maillist/正文接口取验证码。
 *
 * 这条链路已在 Python(mailcom_client.py)完整验证：
 *   登录(复刻录制) → 截获 mail_mailbox Bearer → POST maillist.mail.com/Mailbox/Mail 列表
 *   → POST mailcom.mailbody-ui.de/Mail/<id>/Body/html(form access_token) 取正文 → 提 6 位码
 *
 * 邮箱池文件(每行 `email----password`)：
 *   优先 MAILCOM_TOKENS_FILE 环境变量；否则 codex_register/mailcom/tokens.txt
 */
import {existsSync, readFileSync} from "node:fs";
import path from "node:path";
import {chromium} from "playwright-core";
import {findLatestVerificationMail} from "./verification-matcher.js";

const POOL_FILE = process.env.MAILCOM_TOKENS_FILE
    ? path.resolve(process.env.MAILCOM_TOKENS_FILE)
    : path.resolve(process.cwd(), "mailcom", "tokens.txt");

const HEADLESS = process.env.MAILCOM_HEADLESS === "1";

// 邮箱登录代理(默认空=直连)；env 初始 + setMailProxy 运行时覆盖(server 用)
let mailProxy = (process.env.MAILCOM_PROXY || "").trim();
export function setMailProxy(url) { mailProxy = (url || "").trim(); }
export function getMailProxy() { return mailProxy; }
function parseProxyOpt(url) {
    if (!url) return undefined;
    try {
        const u = new URL(url);
        const opt: any = {server: `${u.protocol}//${u.host}`};
        if (u.username) opt.username = decodeURIComponent(u.username);
        if (u.password) opt.password = decodeURIComponent(u.password);
        return opt;
    } catch { return {server: url}; }
}
const POLL_ATTEMPTS = Number(process.env.MAILCOM_POLL_ATTEMPTS || 24);
const POLL_INTERVAL_MS = Number(process.env.MAILCOM_POLL_INTERVAL_MS || 5000);

const MAILLIST_BASE = "https://maillist.mail.com/Mailbox/Mail";
const COMMON_HDR = {
    origin: "https://webmailer.mail.com",
    referer: "https://webmailer.mail.com/",
    "x-ui-app": "mailcom.webmailer.mail-list/6.0.0",
};
const LIST_HDR = {
    ...COMMON_HDR,
    accept: "application/vnd.1and1.mms.unified-maillist-v1+json; charset=utf-8",
    "content-type": "application/vnd.1and1.mms.inboxadrequest-v1+json; charset=utf-8",
};
const LIST_BODY = {
    aditionContext: {brand: "mailcom", category: "mail", section: "3c/folder",
        tagid: "inline_united_srq", layoutclass: "b"},
    deviceContext: {app: {name: "browser"}, deviceclass: "b"},
    adBlocker: true,
    mailboxContext: {currentPage: 1, visibleMessages: 9},
};

const passwordByEmail = new Map();
const sessions = new Map(); // email -> { browser, context, page, bearer }
let pool = null;
let poolCursor = 0;

function normalizeEmail(value) {
    return String(value ?? "").trim().toLowerCase();
}

function loadPool() {
    if (pool) return pool;
    if (!existsSync(POOL_FILE)) {
        throw new Error(`未找到 mail.com 邮箱池文件: ${POOL_FILE}（每行格式 email----password）`);
    }
    pool = readFileSync(POOL_FILE, "utf8")
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => {
            const [email, password] = line.split("----");
            return {email: normalizeEmail(email), password: String(password ?? "").trim()};
        })
        .filter((item) => item.email && item.password);
    if (!pool.length) {
        throw new Error(`mail.com 邮箱池为空: ${POOL_FILE}`);
    }
    for (const item of pool) passwordByEmail.set(item.email, item.password);
    return pool;
}

function resolvePassword(email) {
    const key = normalizeEmail(email);
    if (passwordByEmail.has(key)) return passwordByEmail.get(key);
    loadPool();
    if (passwordByEmail.has(key)) return passwordByEmail.get(key);
    throw new Error(`mail.com 邮箱池中找不到密码: ${email}`);
}

function htmlToText(s) {
    return String(s ?? "")
        .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, " ")
        .replace(/<[^>]+>/g, " ")
        .replace(/&nbsp;/gi, " ")
        .replace(/\s+/g, " ")
        .trim();
}

// 正文显示专用:保留 <a> 链接的真实 URL(否则 href 被丢,邮件里的链接看不到)+ 保留换行结构。
// 与 htmlToText(取验证码用,只要可见文本)分开,互不影响。
function htmlToReadable(s) {
    let t = String(s ?? "")
        .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, " ")
        // <a href="URL">文字</a> → 文字 (URL);无文字则只留 URL
        .replace(/<a\b[^>]*\bhref\s*=\s*["']?([^"'\s>]+)["']?[^>]*>([\s\S]*?)<\/a>/gi, (_m, href, txt) => {
            const text = String(txt).replace(/<[^>]+>/g, "").replace(/&nbsp;/gi, " ").trim();
            return text && !text.includes(href) ? `${text} (${href})` : (text || href);
        })
        .replace(/<\/(p|div|tr|li|h[1-6]|table)>/gi, "\n") // 块级结束 → 换行
        .replace(/<br\s*\/?>/gi, "\n")
        .replace(/<[^>]+>/g, " ");                          // 去掉剩余标签
    t = t.replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&").replace(/&lt;/gi, "<").replace(/&gt;/gi, ">")
        .replace(/&quot;/gi, '"').replace(/&#39;/gi, "'").replace(/&#(\d+);/g, (_m, n) => String.fromCharCode(+n));
    return t.split("\n").map((l) => l.replace(/[ \t]+/g, " ").trim()).join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

async function dismissPopups(page) {
    // 通用弹窗关闭：推广/升级/安全提醒/引导等遮罩层
    for (const sel of [
        'button[aria-label="Close"]', 'button[aria-label="close"]',
        '[data-testid="close-button"]', '[data-testid="modal-close"]',
        '.modal-close', '.dialog-close', '.overlay-close',
        'button.close', '[class*="dismiss"]', '[class*="Close"]',
        // mail.com 常见弹窗关闭按钮
        'a.pos-button--ghost', 'button.pos-button--ghost',
        '[id*="closeButton"]', '[id*="dismissButton"]',
        'button[title="Close"]', 'button[title="Dismiss"]',
    ]) {
        try {
            const el = page.locator(sel).first();
            if (await el.isVisible({timeout: 300}).catch(() => false)) {
                await el.click({timeout: 2000}).catch(() => {});
                await page.waitForTimeout(500);
            }
        } catch { /* ignore */ }
    }
    // "Not now" / "Later" / "Skip" / "No thanks" 文字按钮
    for (const name of [/Not now/i, /Later/i, /Skip/i, /No thanks/i, /Maybe later/i, /Remind me later/i]) {
        try {
            const btn = page.getByRole("button", {name});
            if (await btn.count()) { await btn.first().click({timeout: 2000}).catch(() => {}); await page.waitForTimeout(500); break; }
        } catch { /* ignore */ }
    }
}

async function loginMailcom(email, password, opts = {}) {
    const launchOpts: any = {
        channel: "chrome",
        headless: opts.headless ?? HEADLESS,
        args: ["--disable-blink-features=AutomationControlled"],
    };
    const proxyOpt = parseProxyOpt(mailProxy);
    if (proxyOpt) launchOpts.proxy = proxyOpt;
    const browser = await chromium.launch(launchOpts);
    try {
        const context = await browser.newContext({
            viewport: {width: 1139, height: 974},
            locale: "en-US",
            timezoneId: "America/New_York",
        });
        const session = {browser, context, page: null, bearer: null};
        const page = await context.newPage();
        session.page = page;
        page.on("request", (req) => {
            if (session.bearer) return;
            if (req.url().includes("maillist.mail.com/Mailbox/Mail")) {
                const a = req.headers()["authorization"];
                if (a && a.toLowerCase().startsWith("bearer ")) {
                    session.bearer = a;
                    console.log(`[mailcom] 截获 Bearer: ${a.slice(0, 32)}...`);
                }
            }
        });
        page.setDefaultTimeout(20000);

        console.log(`[mailcom] 登录 ${email} ...`);
        await page.goto("https://www.mail.com/", {waitUntil: "commit", timeout: 90000});
        await page.waitForTimeout(4000);

        // consent
        for (const name of [/Continue to Mail/i, /Accept All/i, /Accept/i, /Agree/i]) {
            try {
                const btn = page.getByRole("button", {name});
                if (await btn.count()) {
                    await btn.first().click({timeout: 4000});
                    await page.waitForTimeout(1500);
                    break;
                }
            } catch { /* ignore */ }
        }
        await dismissPopups(page);

        // 登录表单(复刻录制)
        if (!page.url().includes("navigator-lxa")) {
            try {
                await page.click("#login-button", {timeout: 10000});
                await page.waitForTimeout(1000);
            } catch { /* 已展开/无需 */ }
            await page.fill("#login-email", email, {timeout: 15000});
            await page.fill("#login-password", password);
            let submitted = false;
            for (const sel of ["#header-login-box span", "#header-login-box button"]) {
                try {
                    await page.click(sel, {timeout: 5000});
                    submitted = true;
                    break;
                } catch { /* try next */ }
            }
            if (!submitted && (await page.locator("#login-password").count())) {
                try { await page.press("#login-password", "Enter"); } catch { /* ignore */ }
            }
        }
        try {
            await page.waitForURL("**navigator-lxa.mail.com**", {timeout: 45000, waitUntil: "commit"});
        } catch { /* 用下方判定成败 */ }

        // 账密无效会跳 logout 页，提前识别、快速失败
        if (!session.bearer && /\/logout/i.test(page.url())) {
            throw new Error(`mail.com 账密无效或账号已停用(登录被拒, 跳转 logout): ${email}`);
        }

        // 等收件箱自动加载、截获 Bearer(风控页面提前跳出,不白等 30s)
        for (let i = 0; i < 30 && !session.bearer; i += 1) {
            await page.waitForTimeout(1000);
            if (i === 3 || i === 10) await dismissPopups(page);
            if (i === 5 || i === 15) {
                const body = await page.innerText("body").catch(() => "");
                if (/blocked your account|irregular activity|contact.*support/i.test(body)) break;
            }
        }
        if (!session.bearer) {
            let reason = "登录后未截获 Bearer(账号可能需二次验证或网络异常)";
            try {
                const body = await page.innerText("body").catch(() => "");
                if (/blocked your account|irregular activity|contact.*support|precautionary measure/i.test(body)) {
                    reason = "mail.com 账号被风控封禁(irregular activity blocked)";
                } else if (/invalid email address|password combination|try again/i.test(body)) {
                    reason = "mail.com 账密无效(邮箱/密码组合错误)";
                } else if (/\/logout/i.test(page.url())) {
                    reason = "mail.com 账密无效或账号已停用(登录被拒)";
                }
            } catch { /* ignore */ }
            throw new Error(`${reason}: ${email}`);
        }
        return session;
    } catch (e) {
        await browser.close().catch(() => {});
        throw e;
    }
}

async function ensureSession(email) {
    const key = normalizeEmail(email);
    const cached = sessions.get(key);
    if (cached) return cached;
    const session = await loginMailcom(key, resolvePassword(key));
    sessions.set(key, session);
    return session;
}

/**
 * 改 mail.com 邮箱密码(Playwright 操作 Wicket 改密表单)。用旧密码登录 → 打开改密页 → 填 当前/新/确认 → 提交。
 * 选择器初值来自 HAR(Wicket 组件 name),入口/提交/成功判定待真号实测微调。成功后返回 {ok,newPassword}。
 */
export async function changeMailcomPassword(email, oldPassword, newPassword, log = (m) => console.log(m)) {
    const key = normalizeEmail(email);
    // 改密流程含多层 SSO 跳转 + Wicket,headless 下浏览器易崩("Target page/browser closed");强制 headed(可 env 覆盖)。
    const headless = process.env.CHANGE_PW_HEADLESS === "1";
    // 候选当前密码:依次试登录(自愈——之前"疑似失败但实为成功"的号,库密码已失效,可用记录过的新密码登录)
    const candidates = (Array.isArray(oldPassword) ? oldPassword : [oldPassword]).filter(Boolean);
    let session, usedPw = candidates[0];
    for (const pw of candidates) {
        try { session = await loginMailcom(key, pw, {headless}); usedPw = pw; if (candidates.length > 1) log(`用密码 ${pw} 登录成功`); break; }
        catch (e) { if (pw !== candidates[candidates.length - 1]) log(`密码 ${pw} 登录失败,试下一个候选…`); else throw e; }
    }
    const page = session.page;
    try {
        const ctx = session.context;
        // 1) 提取 navigator sid(96位十六进制)。SSO 跳转端点需要它。
        let navsid = (page.url().match(/[?&]sid=([0-9a-f]{96})/i) || [])[1] || "";
        if (!navsid) {
            // 从网络请求截取(登录后前端持续用 sid 拉数据)
            await new Promise((resolve) => {
                const grab = (u) => { const m = (u || "").match(/[?&]sid=([0-9a-f]{96})/i); if (m && !navsid) { navsid = m[1]; resolve(); } };
                ctx.on("request", (r) => grab(r.url()));
                page.evaluate(() => { try { fetch("/int-mailnav/v1/session/refresh", {method: "POST"}); } catch { /* */ } }).catch(() => {});
                setTimeout(resolve, 4000);
            });
        }
        if (!navsid) {
            navsid = await page.evaluate(() => {
                const m = document.documentElement.innerHTML.match(/[0-9a-f]{96}/i);
                return m ? m[0] : "";
            }).catch(() => "");
        }
        if (!navsid) throw new Error("未取到 navigator sid(96位)");
        log(`navigator sid(len=${navsid.length}) 已取，进入 SSO…`);

        // 2) SSO 入口(HAR 逆向):navigator/jump/to/ciss?sid= → 服务端 302 链 → account-lxa/ciss/myAccountOverview(建立 account 会话)。
        //    直接拼 account-lxa/myAccountOverview?navsid= 会 OOOPS,必须走 jump 端点让服务端种 account-lxa cookie。
        await page.goto(`https://navigator-lxa.mail.com/navigator/jump/to/ciss?sid=${navsid}`,
            {waitUntil: "domcontentloaded", timeout: 60000}).catch(() => {});
        await page.waitForURL(/account-lxa\.mail\.com/i, {timeout: 25000}).catch(() => {});
        await page.waitForTimeout(4000);
        await dismissPopups(page);
        const acct = page;
        acct.setDefaultTimeout(20000);
        const acctBody = (await acct.evaluate(() => document.body ? document.body.innerText : "").catch(() => "")).replace(/\s+/g, " ").slice(0, 120);
        log(`账户中心已加载(${acct.url().includes("account-lxa") ? "SSO成功" : "异常:" + acct.url().slice(0, 50)})`);
        console.log(`[mailcom改密] 账户中心 url=${acct.url().slice(0, 90)} | 内容=${acctBody}`);

        const hasForm = async () => (await acct.locator('input[name*="currentPasswordPanel"]').first().count()) > 0;

        // 3) 概览页 → 点"Change password"链接(→302→ security/edit/passwordChange?srttkn=)
        await dismissPopups(acct);
        const cpLink = acct.locator('a[href*="changePasswordLink"]').first();
        try { await cpLink.waitFor({state: "visible", timeout: 15000}); } catch { /* */ }
        if (await cpLink.count()) {
            try { await cpLink.click({timeout: 6000}); await acct.waitForURL(/passwordChange|security\/edit/i, {timeout: 20000}).catch(() => {}); } catch { /* */ }
            await acct.waitForTimeout(4000);
        }
        log(`改密表单${await hasForm() ? "已出现，填写中…" : "未出现"}`);
        console.log(`[mailcom改密] 点改密后 url=${acct.url().slice(0, 85)} 表单=${await hasForm()}`);

        // 3) 填改密表单(字段 name 确认自前端源码)
        const cur = acct.locator('input[name*="currentPasswordPanel"]').first();
        try { await cur.waitFor({state: "visible", timeout: 15000}); }
        catch {
            await dismissPopups(acct);
            try { await cur.waitFor({state: "visible", timeout: 8000}); }
            catch {
                const b = (await acct.evaluate(() => document.body ? document.body.innerText : "").catch(() => "")).replace(/\s+/g, " ").slice(0, 160);
                throw new Error(`改密表单未出现(url=${acct.url().slice(0, 60)} 内容=${b})`);
            }
        }
        // Wicket 每字段挂 change AJAX 校验:必须逐字符输入 + Tab 触发 blur,否则后端 model 收不到值 → 提交 OOOPS
        const fillField = async (sel, val) => {
            const el = acct.locator(sel).first();
            await el.click();
            await el.fill("");
            await el.pressSequentially(val, {delay: 45});
            await el.press("Tab");
            await acct.waitForTimeout(1800); // 等该字段 AJAX 校验回包
        };
        await fillField('input[name*="currentPasswordPanel"]', usedPw);
        await fillField('input[name*="newPasswordFieldPanel"]', newPassword);
        await fillField('input[name*="retypeNewPasswordFieldPanel"]', newPassword);
        await acct.waitForTimeout(800);

        // 4) 提交:真实 submit(name=saveChanges)隐藏在视口外(tabindex=-1),其 onclick 转发到可见 CTA #id6。
        //    优先点可见 CTA;兜底对 saveChanges force 点击。
        const cta = acct.locator('#id6, button.pos-button--cta, a.pos-button--cta').first();
        if (await cta.count()) {
            await cta.click({timeout: 8000, force: true});
        } else {
            const submit = acct.locator('input[name="saveChanges"]').first();
            if (!await submit.count()) throw new Error("未找到改密提交按钮");
            await submit.click({timeout: 8000, force: true});
        }
        await acct.waitForTimeout(6000);
        const body = (await acct.innerText("body").catch(() => "")).replace(/\s+/g, " ");
        const stillForm = (await acct.locator('input[name*="currentPasswordPanel"]').first().count()) > 0;
        const successText = /password\s*success|successfully\s*changed|erfolgreich|密码.{0,6}(修改|更改|变更).{0,4}成功/i.test(body);

        // ★ 唯一可靠判据:【改完总是用新密码登录验证】(改密成功 ⇔ 新密码能登录),页面文案只作兜底。
        // 先关改密浏览器,避免与验证登录的浏览器抢资源(同号两个浏览器→page.fill timeout 误判)。
        try { await session.browser.close(); } catch { /* ignore */ }
        log(`改密已提交，用新密码登录验证结果…`);
        let v = await verifyMailcomLogin(key, newPassword);
        if (!v.ok && !v.wrongPassword) { // 验证登录本身异常(page.fill timeout/网络,非密码错)=瞬时问题 → 重试一次
            log(`验证登录受阻(${(v.reason || "").slice(0, 30)})，重试一次…`);
            await new Promise((r) => setTimeout(r, 2500));
            v = await verifyMailcomLogin(key, newPassword);
        }
        let ok = false, verified = false;
        if (v.ok) {
            ok = true; verified = true;
            log("✅ 新密码可登录，改密成功(已验证)");
        } else if (v.wrongPassword) {
            ok = false;
            log(`❌ 新密码登录被拒(账密无效)，改密未成功`);
        } else {
            // 验证登录两次都受阻(页面/网络),无法登录确认 → 退回页面文案:有成功文案=疑似成功、否则失败
            ok = successText && !stillForm;
            log(`⚠️ 验证登录受阻、无法登录确认，按页面结果判:${ok ? "疑似成功(未验证,请核对)" : "疑似失败"}`);
        }
        log(`结果: ${ok ? (verified ? "✅成功(登录已验证)" : "✅疑似成功(未验证)") : "❌失败"} | ${body.slice(0, 50)}`);
        console.log(`[mailcom改密] ${key} 结果: ${ok ? "成功" : "失败"}${verified ? "(验证)" : ""} | ${body.slice(0, 130)}`);
        return {ok, newPassword, verified, detail: body.slice(0, 200)};
    } finally {
        try { await session.browser.close(); } catch { /* ignore */ }
        sessions.delete(key); inboxSessions.delete(key); // 密码已变,清缓存会话
    }
}

/**
 * 校验 mail.com 邮箱密码是否正确:用该密码登录(截获 Bearer=成功)。返回 {ok, reason?}。
 * 独立小工具用,不改任何状态;验证用无头(快、不弹窗)。
 */
export async function verifyMailcomLogin(email, password, log = (m) => {}) {
    const key = normalizeEmail(email);
    let session;
    try {
        session = await loginMailcom(key, password, {headless: true});
        log(`${key} 登录成功(密码正确)`);
        return {ok: true};
    } catch (e) {
        const msg = String(e?.message || e);
        // 区分:明确"账密无效/跳 logout"=密码确实错;其它(page.fill timeout/网络/浏览器崩)=页面异常,不能当密码错
        const wrongPassword = /账密无效|账号已停用|登录被拒|跳转.*logout|invalid.*(email|password)|wrong.*password/i.test(msg);
        return {ok: false, reason: msg.slice(0, 120), wrongPassword};
    } finally {
        if (session) { try { await session.browser.close(); } catch { /* ignore */ } }
    }
}

async function fetchList(session, folder = "INBOX", offset = 0, amount = 50) {
    const res = await session.context.request.post(MAILLIST_BASE, {
        params: {folderTypeOrId: folder, offset: String(offset),
            amount: String(amount), orderBy: "INTERNALDATE DESC"},
        headers: {...LIST_HDR, authorization: session.bearer},
        data: JSON.stringify(LIST_BODY),
    });
    if (res.status() === 401) return "EXPIRED";
    if (!res.ok()) {
        console.warn(`[mailcom] maillist HTTP ${res.status()}`);
        return null;
    }
    const data = await res.json();
    return (data.mailListElements || []).map((el) => {
        const raw = el.rawData || el;
        const mh = raw.mailHeader || {};
        const at = raw.attribute || {};
        return {
            id: at.mailIdentifier,
            from: mh.from || "",
            subject: mh.subject || "",
            to: mh.to || [],
            timestamp: mh.date || at.internalDate || 0,
        };
    });
}

async function fetchBody(session, mailId) {
    const token = session.bearer.replace(/^bearer\s+/i, "");
    const res = await session.context.request.post(
        `https://mailcom.mailbody-ui.de/Mail/${mailId}/Body/html`,
        {
            params: {target_origin: "https://webmailer.mail.com"},
            headers: {
                origin: "https://webmailer.mail.com",
                referer: "https://webmailer.mail.com/",
                accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*",
            },
            form: {access_token: token},
        },
    );
    if (!res.ok()) return "";
    return res.text();
}

const isOpenAIMail = (mail) =>
    /(OpenAI|ChatGPT)/i.test(`${mail.subject ?? ""}\n${mail.content ?? ""}\n${mail.from ?? ""}`);

export function createMailcomProvider() {
    return {
        async getEmailAddress() {
            const accounts = loadPool();
            const account = accounts[poolCursor % accounts.length];
            poolCursor += 1;
            passwordByEmail.set(account.email, account.password);
            return account.email;
        },
        async getEmailVerificationCode(email, options) {
            const minTimestampMs = options?.minTimestampMs || 0;
            const excludeCode = options?.excludeCode || ""; // 排除的旧码(重复注册/上次验证失败的残留码),跳过等新邮件
            const session = await ensureSession(email);

            for (let attempt = 1; attempt <= POLL_ATTEMPTS; attempt += 1) {
                console.log(`[mailcom] pollOtp attempt=${attempt}/${POLL_ATTEMPTS} email=${email}`);
                try {
                    let list = await fetchList(session);
                    if (list === "EXPIRED") {
                        console.log("[mailcom] Bearer 过期，刷新页面重新截获 ...");
                        session.bearer = null;
                        await session.page.reload({waitUntil: "commit"});
                        for (let i = 0; i < 30 && !session.bearer; i += 1) {
                            await session.page.waitForTimeout(1000);
                        }
                        list = session.bearer ? await fetchList(session) : null;
                    }
                    if (Array.isArray(list) && list.length) {
                        // 时间过滤 + 只看 OpenAI 邮件, 倒序取最新几封拉正文
                        const fresh = (minTimestampMs > 0
                            ? list.filter((m) => Number(m.timestamp || 0) >= minTimestampMs - 60000)
                            : list)
                            .filter(isOpenAIMail)
                            .sort((a, b) => Number(b.timestamp || 0) - Number(a.timestamp || 0))
                            .slice(0, 3);

                        const candidates = [];
                        for (const m of fresh) {
                            const body = htmlToText(await fetchBody(session, m.id));
                            candidates.push({...m, content: body, recipient: m.to,
                                extraTexts: [m.subject]});
                        }
                        const found = findLatestVerificationMail(candidates, {
                            targetEmail: email,
                            candidateMatcher: isOpenAIMail,
                        });
                        if (found?.verificationCode) {
                            if (excludeCode && found.verificationCode === excludeCode) {
                                console.log(`[mailcom] pollOtp attempt=${attempt}: 仍是旧码 ${found.verificationCode}，等新邮件…`);
                            } else {
                                console.log(`[mailcom] OTP=${found.verificationCode} subject="${(found.subject || "").slice(0, 60)}"`);
                                return found.verificationCode;
                            }
                        }
                    }
                } catch (err) {
                    console.warn(`[mailcom] pollOtp attempt=${attempt} 失败: ${err?.message ?? err}`);
                }
                if (attempt < POLL_ATTEMPTS) {
                    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
                }
            }
            throw new Error(`mail.com 未找到验证码: ${email}`);
        },
    };
}

/** 调试用：登录并读取收件箱列表 + 首封正文预览，验证收信链路是否打通。 */
export async function probeMailcomInbox(email) {
    const session = await ensureSession(email);
    const list = await fetchList(session);
    const mails = Array.isArray(list) ? list : [];
    let bodyPreview = "";
    if (mails.length) bodyPreview = htmlToText(await fetchBody(session, mails[0].id)).slice(0, 200);
    return {bearerCaptured: !!session.bearer, count: mails.length, mails: mails.slice(0, 10), bodyPreview};
}

// ---- 收件箱会话缓存：登录一次保持 5 分钟，刷新/再开同号秒级(免重登)；空闲自动关浏览器 ----
const inboxSessions = new Map(); // email -> {session, lastUsed}
const INBOX_TTL_MS = 5 * 60 * 1000;

async function getInboxSession(email, password, forceNew = false) {
    const key = normalizeEmail(email);
    const cached = inboxSessions.get(key);
    if (!forceNew && cached?.session?.bearer) {
        cached.lastUsed = Date.now();
        return cached.session;
    }
    if (cached) {
        try { await cached.session.browser.close(); } catch { /* ignore */ }
        inboxSessions.delete(key);
    }
    const session = await loginMailcom(key, password); // 成功保持浏览器开着供复用；失败会自行关闭并抛错
    inboxSessions.set(key, {session, lastUsed: Date.now()});
    return session;
}

const inboxCleaner = setInterval(() => {
    const now = Date.now();
    for (const [key, v] of inboxSessions) {
        if (now - v.lastUsed > INBOX_TTL_MS) {
            try { v.session.browser.close(); } catch { /* ignore */ }
            inboxSessions.delete(key);
        }
    }
}, 60000);
inboxCleaner.unref?.(); // 不阻塞进程退出

function mapMailHead(m) {
    return {
        id: m.id,
        from: m.from,
        subject: m.subject,
        timestamp: m.timestamp,
        date: m.timestamp ? new Date(Number(m.timestamp)).toISOString().replace("T", " ").slice(0, 16) : "",
    };
}

/** 拉收件箱【列表】(不含正文，快；复用缓存会话；bearer 过期自动重登) */
export async function fetchInboxList(email, password, amount = 20) {
    let session = await getInboxSession(email, password);
    let list = await fetchList(session, "INBOX", 0, amount);
    if (list === "EXPIRED") {
        session = await getInboxSession(email, password, true);
        list = await fetchList(session, "INBOX", 0, amount);
    }
    return (Array.isArray(list) ? list : []).map(mapMailHead);
}

/** 按需拉【单封正文】(复用缓存会话，秒级) */
export async function fetchMailBodyFor(email, mailId) {
    const cached = inboxSessions.get(normalizeEmail(email));
    if (!cached?.session?.bearer) {
        throw new Error("收件箱会话已过期，请重新打开或点刷新");
    }
    cached.lastUsed = Date.now();
    return htmlToReadable(await fetchBody(cached.session, mailId)); // 显示用:保留链接 URL + 换行
}

/**
 * 轮询收件箱,提取 Claude 注册/登录的 magic link(https://claude.ai/magic-link#...)。
 * 用于 Claude 注册:提交邮箱后 Claude 发一封含 magic link 的邮件,取出来打开完成注册。
 * @param sinceMs 只认此时间戳之后到达的 Anthropic 邮件(避免拿到旧链接)
 */
export async function findLatestClaudeMagicLink(email, password, {attempts = 20, intervalMs = 6000, sinceMs = 0, log = () => {}} = {}) {
    const LINK_RE = /https?:\/\/claude\.ai\/magic-link#[^\s"'()<>]+/i;
    for (let i = 0; i < attempts; i++) {
        let mails = [];
        try { mails = await fetchInboxList(email, password); } catch (e: any) { log(`[magic] 收信失败(${i + 1}/${attempts}): ${e?.message || e}`); }
        // Anthropic/Claude 来信,且(若给了 sinceMs)时间新
        const cand = mails.filter((m: any) => /anthropic|claude/i.test(`${m.from} ${m.subject}`) && (!sinceMs || (m.timestamp || 0) >= sinceMs - 120000));
        for (const m of cand) {
            try {
                const body = await fetchMailBodyFor(email, m.id);
                const match = String(body).match(LINK_RE);
                if (match) { log(`[magic] 命中 magic link(subject: ${m.subject})`); return match[0]; }
            } catch { /* 该封取正文失败,试下一封 */ }
        }
        log(`[magic] 第 ${i + 1}/${attempts} 轮未见 Claude magic link,${intervalMs}ms 后重试…`);
        await new Promise((r) => setTimeout(r, intervalMs));
    }
    return null;
}

export async function closeMailcomSessions() {
    for (const session of sessions.values()) {
        try { await session.browser.close(); } catch { /* ignore */ }
    }
    sessions.clear();
}
