// @ts-nocheck
/**
 * mail.com 邮箱 provider —— 用 Playwright 登录 mail.com、截获 maillist 的 Bearer，
 * 再用同一浏览器会话(context.request 带全部 cookie)主动调 maillist/正文接口取验证码。
 *
 * 这条链路已在 Python(mailcom_client.py)完整验证：
 *   登录 → 只要 mail_mailbox_r 票(LPS 的 ppc_permission_r 打 maillist 会 403)
 *   → 没有则用 oauthbridge passport 换票 → POST maillist.mail.com/Mailbox/Mail
 *   → POST mailcom.mailbody-ui.de/Mail/<id>/Body/html(form access_token) 取正文 → 提 6 位码
 *
 * 邮箱池文件(每行 `email----password`)：
 *   优先 MAILCOM_TOKENS_FILE 环境变量；否则 codex_register/mailcom/tokens.txt
 */
import {existsSync, readFileSync} from "node:fs";
import path from "node:path";
import {chromium} from "playwright-core";
import {findLatestVerificationMail} from "./verification-matcher.js";
import {formatBeijingDateTime} from "../utils.js";
import {applyMailcomFingerprint, ensureMailcomProfile, playwrightContextOptions} from "./mailcom-fingerprint.js";

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
        // 去掉 hash 段（池 URL 常带 #session）
        const cleaned = String(url).trim().replace(/#.*$/, "");
        const u = new URL(cleaned);
        // Chromium/Playwright：socks5 不支持 user:pass 鉴权；无账密的本地 socks 可直接用
        if (u.protocol.startsWith("socks") && (u.username || u.password)) {
            throw new Error("Browser does not support socks5 proxy authentication（请用无账密的充值代理/本地转发）");
        }
        const opt: any = {server: `${u.protocol}//${u.host}`};
        if (u.username) opt.username = decodeURIComponent(u.username);
        if (u.password) opt.password = decodeURIComponent(u.password);
        return opt;
    } catch (e: any) {
        if (/socks5 proxy authentication/i.test(String(e?.message || e))) throw e;
        return {server: String(url).trim().replace(/#.*$/, "")};
    }
}
const POLL_ATTEMPTS = Number(process.env.MAILCOM_POLL_ATTEMPTS || 24);
const POLL_INTERVAL_MS = Number(process.env.MAILCOM_POLL_INTERVAL_MS || 5000);

const MAILLIST_BASE = "https://maillist.mail.com/Mailbox/Mail";
// HAR 里 secret 被脱敏成 *******；passport+sid 下客户端用 Basic(clientId:secret)。
// 同时试多个 client（list/sidebar/root），任一成功即可。
const MAILBOX_OAUTH = {
    url: "https://oauthbridge.navigator-lxa.mail.com/navigator/oauth2/token",
    grant: "urn:mam:oauth:grant-type:spa",
    scope: "mail_mailbox_r",
    clients: [
        {clientId: "mailcom_webmailermaillist_passport_live", secret: "*******", xUiApp: "mailcom.webmailer.mail-list/6.6.3"},
        {clientId: "mailcom_mailsidebar_passport_live", secret: "*******", xUiApp: "mailcom.webmailer.mail-sidebar/3.24.0"},
        {clientId: "mailcom_webmailermailroot_live", secret: "*******", xUiApp: "mailcom.webmailer.mail-root/2.38.0"},
        {clientId: "mailcom_webmailermaillist_passport_live", secret: "", xUiApp: "mailcom.webmailer.mail-list/6.6.3"},
    ],
};
const COMPOSE_OAUTH = {
    url: MAILBOX_OAUTH.url,
    grant: MAILBOX_OAUTH.grant,
    scope: "mail_mailbox_w",
    clients: [
        {clientId: "mailcom_mailcompose_passport_live", secret: "*******", xUiApp: "mailcom.webmailer.mail-compose/1.43.6"},
        {clientId: "mailcom_mailcompose_passport_live", secret: "", xUiApp: "mailcom.webmailer.mail-compose/1.43.6"},
    ],
};
const COMMON_HDR = {
    origin: "https://webmailer.mail.com",
    referer: "https://webmailer.mail.com/",
    "x-ui-app": "mailcom.webmailer.mail-list/6.6.3",
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

export function rememberMailcomPassword(email, password) {
    const key = normalizeEmail(email);
    if (key && password) passwordByEmail.set(key, String(password));
}

function resolvePassword(email) {
    const key = normalizeEmail(email);
    if (passwordByEmail.has(key)) return passwordByEmail.get(key);
    loadPool();
    if (passwordByEmail.has(key)) return passwordByEmail.get(key);
    throw new Error(`mail.com 邮箱池中找不到密码: ${email}`);
}

function decodeJwtPayload(auth) {
    const token = String(auth || "").replace(/^bearer\s+/i, "").trim();
    const part = token.split(".")[1];
    if (!part) return null;
    try {
        const pad = part.replace(/-/g, "+").replace(/_/g, "/");
        return JSON.parse(Buffer.from(pad, "base64").toString("utf8"));
    } catch { return null; }
}

function authScope(auth) {
    return String(decodeJwtPayload(auth)?.scope || "");
}

function isMailboxAuth(auth) {
    return /mail_mailbox/i.test(authScope(auth));
}

function extractNavsid(page, extra = "") {
    const from = `${page?.url?.() || ""} ${extra}`;
    return (from.match(/[?&](?:sid|navsid)=([0-9a-f]{32,})/i) || [])[1]
        || "";
}

async function readNavsid(page) {
    const urlSid = extractNavsid(page);
    if (urlSid) return urlSid;
    return page.evaluate(() => {
        try { return sessionStorage.getItem("mam.navsid") || ""; } catch { return ""; }
    }).catch(() => "") || "";
}

async function mintMailboxToken(session, navsid) {
    if (!navsid) return "";
    const url = `${MAILBOX_OAUTH.url}?sid=${encodeURIComponent(navsid)}`;
    const body = `grant_type=${encodeURIComponent(MAILBOX_OAUTH.grant)}&scope=${encodeURIComponent(MAILBOX_OAUTH.scope)}`;
    const tryParse = (status, text, tag) => {
        if (status >= 400) {
            console.warn(`[mailcom] mint ${tag} HTTP ${status} ${String(text).slice(0, 100)}`);
            return "";
        }
        try {
            const data = JSON.parse(text);
            // 响应里可能不回 echo scope，有 access_token 即视为该次请求的 scope
            if (data?.access_token) {
                const sc = String(data.scope || MAILBOX_OAUTH.scope);
                if (/mail_mailbox/i.test(sc) || !data.scope) {
                    return `Bearer ${data.access_token}`;
                }
                console.warn(`[mailcom] mint ${tag} scope=${sc.slice(0, 60)}`);
            }
        } catch (e) {
            console.warn(`[mailcom] mint ${tag} 解析失败: ${String(e?.message || e).slice(0, 60)}`);
        }
        return "";
    };

    for (const c of MAILBOX_OAUTH.clients) {
        const basic = Buffer.from(`${c.clientId}:${c.secret || ""}`).toString("base64");
        const headers = {
            "content-type": "application/x-www-form-urlencoded",
            authorization: `Basic ${basic}`,
            "x-ui-app": c.xUiApp || COMMON_HDR["x-ui-app"],
            origin: COMMON_HDR.origin,
            referer: COMMON_HDR.referer,
        };
        const tag = c.clientId.replace(/^mailcom_/, "").slice(0, 28);
        try {
            const res = await session.context.request.post(url, {headers, data: body, timeout: 15000});
            const minted = tryParse(res.status(), await res.text(), tag);
            if (minted) {
                console.log(`[mailcom] mint 成功 client=${tag}`);
                return minted;
            }
        } catch (e) {
            console.warn(`[mailcom] mint ${tag} request: ${String(e?.message || e).slice(0, 80)}`);
        }
        if (session.page) {
            try {
                const inPage = await session.page.evaluate(async ({url, headers, body}) => {
                    const res = await fetch(url, {method: "POST", credentials: "include", headers, body});
                    return {status: res.status, text: await res.text()};
                }, {url, headers, body});
                const minted = tryParse(inPage.status, inPage.text, `${tag}/page`);
                if (minted) {
                    console.log(`[mailcom] mint 成功 client=${tag} (in-page)`);
                    return minted;
                }
            } catch (e) {
                console.warn(`[mailcom] mint ${tag} in-page: ${String(e?.message || e).slice(0, 80)}`);
            }
        }
    }
    return "";
}

async function mintComposeToken(session, navsid) {
    if (!navsid) return "";
    const url = `${COMPOSE_OAUTH.url}?sid=${encodeURIComponent(navsid)}`;
    const body = `grant_type=${encodeURIComponent(COMPOSE_OAUTH.grant)}&scope=${encodeURIComponent(COMPOSE_OAUTH.scope)}`;
    const tryParse = (status, text, tag) => {
        if (status >= 400) {
            console.warn(`[mailcom] compose mint ${tag} HTTP ${status} ${String(text).slice(0, 120)}`);
            return "";
        }
        try {
            const data = JSON.parse(text);
            if (data?.access_token) {
                const sc = String(data.scope || COMPOSE_OAUTH.scope);
                if (/mail_mailbox_w/i.test(sc) || /mail_mailbox/i.test(sc) || !data.scope) {
                    return `Bearer ${data.access_token}`;
                }
                console.warn(`[mailcom] compose mint ${tag} scope=${sc.slice(0, 60)}`);
            }
        } catch (e) {
            console.warn(`[mailcom] compose mint ${tag} 解析失败: ${String(e?.message || e).slice(0, 60)}`);
        }
        return "";
    };
    for (const c of COMPOSE_OAUTH.clients) {
        const basic = Buffer.from(`${c.clientId}:${c.secret || ""}`).toString("base64");
        const headers = {
            "content-type": "application/x-www-form-urlencoded",
            authorization: `Basic ${basic}`,
            "x-ui-app": c.xUiApp,
            origin: "https://webmailer.mail.com",
            referer: "https://webmailer.mail.com/",
        };
        const tag = c.clientId.replace(/^mailcom_/, "").slice(0, 32);
        try {
            const res = await session.context.request.post(url, {headers, data: body, timeout: 15000});
            const minted = tryParse(res.status(), await res.text(), tag);
            if (minted) {
                console.log(`[mailcom] compose mint 成功 client=${tag}`);
                return minted;
            }
        } catch (e) {
            console.warn(`[mailcom] compose mint ${tag} request: ${String(e?.message || e).slice(0, 80)}`);
        }
        if (session.page) {
            try {
                const inPage = await session.page.evaluate(async ({url, headers, body}) => {
                    const res = await fetch(url, {method: "POST", credentials: "include", headers, body});
                    return {status: res.status, text: await res.text()};
                }, {url, headers, body});
                const minted = tryParse(inPage.status, inPage.text, `${tag}/page`);
                if (minted) {
                    console.log(`[mailcom] compose mint 成功 client=${tag} (in-page)`);
                    return minted;
                }
            } catch (e) {
                console.warn(`[mailcom] compose mint ${tag} in-page: ${String(e?.message || e).slice(0, 80)}`);
            }
        }
    }
    return "";
}

function socksHasAuth(url) {
    try {
        const u = new URL(String(url || "").trim());
        return u.protocol.startsWith("socks") && !!(u.username || u.password);
    } catch {
        return false;
    }
}

/** Playwright 不能带 socks 账密：经跳板起本机无账密口。 */
async function openBrowserProxy(exitUrl, jumpUrl = "") {
    const exit = String(exitUrl || "").trim();
    if (!exit || !socksHasAuth(exit)) {
        return {url: exit, close() {}};
    }
    const {openNoAuthSocksToAuthedProxy, timezoneFromExitUrl} = await import("./proxy-chain.js");
    const wrapped = await openNoAuthSocksToAuthedProxy(exit, String(jumpUrl || "").trim());
    return {
        url: wrapped.url,
        timezone: timezoneFromExitUrl(exit) || "",
        localPort: wrapped.localPort,
        close: wrapped.close,
    };
}

/**
 * 登录 mail.com 后按 CATS mailsubmission 协议发一封信。
 * 成功一般为 HTTP 202/204。
 * 出口若带 socks 账密（kookeey），会经跳板起本机无账密 socks 再给 Playwright。
 */
export async function sendMailcomMail(email, password, opts = {}) {
    const key = normalizeEmail(email);
    const toList = (Array.isArray(opts.to) ? opts.to : [opts.to]).map((x) => String(x || "").trim()).filter(Boolean);
    if (!toList.length) throw new Error("sendMailcomMail: 缺少收件人");
    const subject = String(opts.subject || "test");
    const text = opts.text == null ? "" : String(opts.text);
    const html = String(opts.html || `<html><body><p>${text.replace(/[&<>]/g, (ch) => ({"&": "&amp;", "<": "&lt;", ">": "&gt;"}[ch]))}</p></body></html>`);
    const fromName = String(opts.fromName || "").trim();
    const exitUrl = String(opts.proxy || "").trim();
    const jumpUrl = String(opts.jump || "").trim();
    let relayClose = () => {};
    let session = null;
    try {
        const via = await openBrowserProxy(exitUrl, jumpUrl);
        relayClose = via.close;
        if (via.localPort) {
            console.log(`[mailcom] 发信链式 本机:${via.localPort}${jumpUrl ? " ←跳板" : ""} ← 粘性出口`);
        }
        const {kookeeySessionOf} = await import("./proxy-pool.js");
        const profile = ensureMailcomProfile(opts.profile, exitUrl);
        session = await loginMailcom(key, password, {
            headless: opts.headless ?? true,
            proxy: via.url || undefined,
            skipInbox: true,
            timezone: profile.timezoneId,
            profile,
        });
        const navsid = (await readNavsid(session.page)) || extractNavsid(session.page) || "";
        if (!navsid) throw new Error("sendMailcomMail: 登录后没有 sid");
        const token = await mintComposeToken(session, navsid);
        if (!token) throw new Error("sendMailcomMail: 未拿到 mail_mailbox_w token");
        const authId = String(decodeJwtPayload(token)?.auth_id || "").trim();
        const url = `https://webmail-cats-live.mail.com/mailbox/primary/mailsubmission?absoluteURI=false${authId ? `&no_cache=${encodeURIComponent(authId)}` : ""}`;
        const from = fromName ? `"${fromName.replace(/"/g, "")}" <${key}>` : key;
        const payload = {
            mailHeader: {
                messageType: "MAIL",
                from,
                to: toList,
                subject,
                date: Date.now(),
            },
            htmlBody: html,
            plaintextBody: text || null,
            mailClientMeta: {"mail-drop": "[]"},
            transientMailProperties: {},
        };
        const headers = {
            accept: "text/plain",
            authorization: token,
            "content-type": "application/vnd.ui.trinity.minimalmailmessage+json; charset=utf-8",
            origin: "https://webmailer.mail.com",
            referer: "https://webmailer.mail.com/",
            "x-ui-app": "mailcom.webmailer.mail-compose/1.43.6",
            "x-request-id": crypto.randomUUID(),
        };
        const res = await session.context.request.post(url, {
            headers,
            data: JSON.stringify(payload),
            timeout: 20000,
        });
        const status = res.status();
        const location = res.headers().location || res.headers().Location || "";
        const respText = await res.text();
        if (status !== 202 && status !== 204) {
            throw new Error(`sendMailcomMail: HTTP ${status} ${respText.slice(0, 200)}`);
        }
        return {
            ok: true,
            status,
            location,
            from: key,
            to: toList,
            subject,
            proxySession: kookeeySessionOf(exitUrl) || "",
            proxyUrl: exitUrl,
            jumpUrl,
        };
    } finally {
        try { if (session?.browser) await session.browser.close(); } catch { /* ignore */ }
        try { relayClose(); } catch { /* ignore */ }
    }
}

/** 等页面网络里出现 mail_mailbox token（webmailer 列表真正加载时会发）。 */
async function waitForMailboxTokenResponse(page, session, timeoutMs = 25000) {
    if (!page || session.bearer) return !!session.bearer;
    try {
        const resp = await page.waitForResponse((r) => {
            if (!/oauth2\/token/i.test(r.url()) || !r.ok()) return false;
            const post = r.request().postData() || "";
            return /mail_mailbox_r/i.test(post);
        }, {timeout: timeoutMs});
        try {
            const data = await resp.json();
            if (data?.access_token) {
                session.bearer = `Bearer ${data.access_token}`;
                console.log(`[mailcom] 截获 oauth2 响应 mailbox token`);
                return true;
            }
        } catch { /* */ }
    } catch { /* timeout */ }
    return !!session.bearer;
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

async function clickIfVisible(root, sel, timeout = 800) {
    try {
        const el = root.locator(sel).first();
        if (await el.isVisible({timeout}).catch(() => false)) {
            await el.click({force: true, timeout: 2000}).catch(() => {});
            return true;
        }
    } catch { /* ignore */ }
    return false;
}

async function dismissCookieBanners(page) {
    const names = [/Accept all/i, /Accept All/i, /Agree/i, /I agree/i, /Continue to Mail/i, /Allow all/i, /Alle akzeptieren/i];
    const sels = [
        "#onetrust-accept-btn-handler",
        "#accept-all",
        "button#accept",
        '[id*="accept-all" i]',
        '[data-testid*="accept" i]',
        "button[mode='primary']",
    ];
    const roots = [page, ...page.frames()];
    for (const root of roots) {
        for (const sel of sels) {
            if (await clickIfVisible(root, sel, 400)) return;
        }
        for (const name of names) {
            try {
                const btn = root.getByRole("button", {name}).first();
                if (await btn.isVisible({timeout: 400}).catch(() => false)) {
                    await btn.click({force: true, timeout: 2000}).catch(() => {});
                    return;
                }
            } catch { /* ignore */ }
        }
    }
}

async function dismissPopups(page) {
    await dismissCookieBanners(page);
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
                await page.waitForTimeout(400);
            }
        } catch { /* ignore */ }
    }
    // "Not now" / "Later" / "Skip" / "No thanks" 文字按钮
    for (const name of [/Not now/i, /Later/i, /Skip/i, /No thanks/i, /Maybe later/i, /Remind me later/i]) {
        try {
            const btn = page.getByRole("button", {name});
            if (await btn.count()) { await btn.first().click({timeout: 2000}).catch(() => {}); await page.waitForTimeout(400); break; }
        } catch { /* ignore */ }
    }
}

async function forceShowLoginLayer(page) {
    return page.evaluate(() => {
        try { location.hash = "navlogin"; } catch { /* */ }
        // 触发官网 hash 逻辑（部分版本监听 hashchange 才加 open）
        try { window.dispatchEvent(new HashChangeEvent("hashchange")); } catch { /* */ }
        try { window.dispatchEvent(new Event("hashchange")); } catch { /* */ }

        const layers = Array.from(document.querySelectorAll(".login-layer, [data-mod-name='header'] .login-layer"));
        for (const layer of layers) {
            layer.classList.add("open");
            layer.removeAttribute("hidden");
            const s = layer.style;
            s.setProperty("display", "block", "important");
            s.setProperty("top", "96px", "important");
            s.setProperty("left", "0", "important");
            s.setProperty("right", "0", "important");
            s.setProperty("visibility", "visible", "important");
            s.setProperty("opacity", "1", "important");
            s.setProperty("overflow", "visible", "important");
            s.setProperty("z-index", "2147483000", "important");
            s.setProperty("height", "auto", "important");
            s.setProperty("min-height", "240px", "important");
            s.setProperty("position", "fixed", "important");
            s.setProperty("pointer-events", "auto", "important");
        }
        // 输入框本身偶发 display:none / 父级 overflow 裁切
        for (const id of ["login-email", "login-password"]) {
            const el = document.getElementById(id);
            if (!el) continue;
            el.removeAttribute("hidden");
            el.classList.remove("hidden");
            el.style.setProperty("display", "block", "important");
            el.style.setProperty("visibility", "visible", "important");
            el.style.setProperty("opacity", "1", "important");
            let p = el.parentElement;
            for (let i = 0; i < 6 && p; i++, p = p.parentElement) {
                p.style?.setProperty("display", "block", "important");
                p.style?.setProperty("visibility", "visible", "important");
                p.style?.setProperty("overflow", "visible", "important");
            }
        }
        const email = document.getElementById("login-email");
        const pwd = document.getElementById("login-password");
        return {
            layers: layers.length,
            hasEmail: !!email,
            hasPwd: !!pwd,
            emailDisplay: email ? getComputedStyle(email).display : "",
            layerOpen: layers.some((l) => l.classList.contains("open")),
        };
    }).catch(() => ({layers: 0, hasEmail: false, hasPwd: false}));
}

/** DOM 里有表单即可，不依赖 isVisible（.login-layer 默认 display:none）。 */
async function loginFormAttached(page) {
    const n = await page.locator("#login-email").count().catch(() => 0);
    return n > 0;
}

async function inboxAlready(page) {
    const u = page.url() || "";
    // 真正进壳：带 sid/navsid，或 webmailer/3c；纯 /login 中间跳转不算成功
    if (/[?&](?:sid|navsid)=[0-9a-f]{32,}/i.test(u)) return true;
    if (/3c\.mail\.com|webmailer\.mail\.com/i.test(u)) return true;
    return false;
}

function isLoginFailedUrl(url) {
    return /\/logout|loginFailed|ls=wd|ls=te|invalid/i.test(String(url || ""));
}

function isMarketingHome(url) {
    return /^https:\/\/www\.mail\.com\/?(?:\?|#|$)/i.test(String(url || ""));
}

async function waitForFormOrInbox(page, emailBox, seconds, why) {
    console.log(`[mailcom] ${why}，窗口先留着，最多 ${seconds}s（可手点右上角 Login）`);
    const deadline = Date.now() + seconds * 1000;
    let n = 0;
    while (Date.now() < deadline) {
        if (await inboxAlready(page)) return "inbox";
        if (await emailBox.isVisible({timeout: 400}).catch(() => false)) return "form";
        if (await loginFormAttached(page)) {
            await forceShowLoginLayer(page);
            if (await emailBox.isVisible({timeout: 400}).catch(() => false) || await loginFormAttached(page)) return "form";
        }
        await page.waitForTimeout(2000);
        n += 1;
        if (n % 5 === 0) console.log(`[mailcom] 窗口还开着，等手点 Login，已 ${n * 2}s`);
    }
    return "";
}

/** 不依赖可见性：直接写 input 并 submit 首页 loginform。 */
async function forceFillAndSubmitLogin(page, email, password) {
    await forceShowLoginLayer(page);
    const r = await page.evaluate(({email: em, password: pw}) => {
        const emailEl = document.querySelector("#login-email")
            || document.querySelector("input[name='username']")
            || document.querySelector("form[data-mod-name='loginform'] input[type='text']");
        const passEl = document.querySelector("#login-password")
            || document.querySelector("input[name='password']")
            || document.querySelector("form[data-mod-name='loginform'] input[type='password']");
        if (!emailEl || !passEl) {
            return {ok: false, reason: `no fields email=${!!emailEl} pwd=${!!passEl} html=${document.body?.innerText?.slice(0, 40) || ""}`};
        }
        const setVal = (el, v) => {
            el.focus();
            el.value = v;
            el.setAttribute("value", v);
            el.dispatchEvent(new Event("input", {bubbles: true}));
            el.dispatchEvent(new Event("change", {bubbles: true}));
        };
        setVal(emailEl, em);
        setVal(passEl, pw);
        const form = emailEl.closest("form")
            || document.querySelector("form[data-mod-name='loginform']")
            || document.querySelector("form[action*='login.mail.com']");
        if (!form) return {ok: false, reason: "no form"};
        try {
            if (typeof form.requestSubmit === "function") form.requestSubmit();
            else form.submit();
        } catch {
            form.submit();
        }
        return {ok: true, action: form.getAttribute("action") || ""};
    }, {email, password}).catch((e) => ({ok: false, reason: String(e?.message || e)}));
    return r;
}

async function openMailcomLoginForm(page, {headed = false} = {}) {
    const emailBox = page.locator("#login-email").first();
    // 已 attach 即可用（可见性靠 forceShow / force fill）
    if (await loginFormAttached(page)) {
        await forceShowLoginLayer(page);
        return emailBox;
    }
    if (await inboxAlready(page)) return emailBox;

    await dismissPopups(page);
    // 首页右上角 Login 打开 .login-layer，不要进 /login/（该路径是 404 营销壳）
    for (const sel of [
        "a.button.button-login",
        "a.nav-button.nav-login",
        "a[href*='navlogin']",
        "a[title='Login']",
        "[data-mod-name='header'] a.button-login",
        "header a.button-login",
        "text=Login",
    ]) {
        const el = page.locator(sel).first();
        if (await el.count().catch(() => 0)) {
            await el.click({force: true, timeout: 3000}).catch(() => {});
            await page.waitForTimeout(500);
            await forceShowLoginLayer(page);
            if (await loginFormAttached(page)) return emailBox;
            if (await emailBox.isVisible({timeout: 1500}).catch(() => false)) return emailBox;
        }
    }
    console.log("[mailcom] 点击没展开，强制显示 .login-layer + #navlogin");
    // 优先原地 force；失败再带 hash 刷新
    let snap = await forceShowLoginLayer(page);
    console.log(`[mailcom] forceShow layers=${snap.layers} email=${snap.hasEmail} open=${snap.layerOpen}`);
    if (await loginFormAttached(page)) return emailBox;

    await page.goto("https://www.mail.com/#navlogin", {waitUntil: "domcontentloaded", timeout: 45000}).catch(() => {});
    await page.waitForTimeout(1200);
    await dismissPopups(page);
    snap = await forceShowLoginLayer(page);
    console.log(`[mailcom] forceShow#2 layers=${snap.layers} email=${snap.hasEmail} open=${snap.layerOpen}`);
    if (await loginFormAttached(page)) return emailBox;
    if (await emailBox.isVisible({timeout: 3000}).catch(() => false)) return emailBox;
    if (headed) {
        const got = await waitForFormOrInbox(page, emailBox, 180, "自动没点开登录层");
        if (got === "form" || got === "inbox") return emailBox;
    }
    // 最后兜底：看 body 是否整页失败
    const body = String(await page.innerText("body").catch(() => "")).replace(/\s+/g, " ").slice(0, 80);
    throw new Error(`mail.com 首页登录层没展开，#login-email 不可见（不要走 /login/ 404） body=${body}`);
}

async function gotoMailcomHome(page, {retries = 3} = {}) {
    let lastErr = null;
    for (let i = 0; i < retries; i++) {
        try {
            if (i) {
                console.log(`[mailcom] 首页打开失败，重试 ${i + 1}/${retries}: ${String(lastErr || "").slice(0, 80)}`);
                await page.waitForTimeout(800 + i * 700);
            }
            // networkidle 在广告站易超时；domcontentloaded 更稳，再补等表单
            const resp = await page.goto("https://www.mail.com/", {
                waitUntil: "domcontentloaded",
                timeout: 60000,
            });
            const status = resp?.status?.() || 0;
            console.log(`[mailcom] 首页已开 status=${status} url=${page.url().slice(0, 80)}`);
            // 等 loginform 进 DOM（静态 HTML 里就有，失败则多等一会儿）
            await page.waitForSelector("#login-email, form[data-mod-name='loginform'], a.button-login", {
                timeout: 15000,
                state: "attached",
            }).catch(() => {});
            if (await loginFormAttached(page) || await page.locator("a.button-login, a.nav-login").count().catch(() => 0)) {
                return;
            }
            // 可能是中间页/consent，再等一轮
            await page.waitForTimeout(2000);
            if (await loginFormAttached(page)) return;
            lastErr = `首页无登录表单 status=${status}`;
        } catch (e) {
            lastErr = e;
            const msg = String(e?.message || e);
            // 连接被关/重置：换一次空白页再试
            if (/ERR_CONNECTION|ECONN|RESET|TIMED_OUT|NS_ERROR|net::/i.test(msg)) {
                await page.goto("about:blank").catch(() => {});
                continue;
            }
            if (i === retries - 1) throw e;
        }
    }
    if (lastErr) throw (lastErr instanceof Error ? lastErr : new Error(String(lastErr)));
}

async function loginMailcom(email, password, opts = {}) {
    const launchOpts: any = {
        channel: "chrome",
        headless: opts.headless ?? HEADLESS,
        args: [
            "--disable-blink-features=AutomationControlled",
            "--disable-dev-shm-usage",
            "--no-first-run",
            "--no-default-browser-check",
        ],
    };
    const proxyRaw = (opts.proxy != null ? opts.proxy : mailProxy) || "";
    const proxyOpt = parseProxyOpt(proxyRaw);
    if (proxyOpt) launchOpts.proxy = proxyOpt;
    const headed = !(launchOpts.headless);
    const browser = await chromium.launch(launchOpts);
    let page = null;
    try {
        const profile = ensureMailcomProfile(opts.profile, proxyRaw);
        const context = await browser.newContext(playwrightContextOptions(profile));
        const session = {browser, context, page: null, bearer: null, lastList: null, profile};
        page = await context.newPage();
        session.page = page;
        await applyMailcomFingerprint(context, page, profile);
        console.log(`[mailcom] 指纹 ${profile.platform} ${profile.viewportWidth}x${profile.viewportHeight} tz=${profile.timezoneId} ua=${String(profile.userAgent).match(/Chrome\/[\d.]+/)?.[0] || "?"}`);
        const grabBearer = (auth, url = "") => {
            if (!auth || !String(auth).toLowerCase().startsWith("bearer ")) return;
            const mailbox = isMailboxAuth(auth) || /maillist\.mail\.com/i.test(url);
            if (!mailbox) {
                if (!session.ignoredOtherBearer) {
                    session.ignoredOtherBearer = true;
                    console.log(`[mailcom] 忽略非 mailbox Bearer scope=${authScope(auth) || "?"} ${String(url).slice(0, 70)}`);
                }
                return;
            }
            if (session.bearer && isMailboxAuth(session.bearer)) return;
            session.bearer = auth;
            console.log(`[mailcom] 截获 mailbox Bearer scope=${authScope(auth) || "maillist"} ${String(url).slice(0, 70)}`);
        };
        page.on("request", (req) => {
            if (/mail\.com|1and1|webmailer|maillist/i.test(req.url())) {
                grabBearer(req.headers()?.authorization || req.headers()?.Authorization, req.url());
            }
        });
        page.on("response", async (res) => {
            const url = res.url();
            if (/oauth2\/token/i.test(url) && res.ok()) {
                try {
                    const data = await res.json();
                    const post = res.request().postData() || "";
                    // 响应体常不带 scope；靠 POST body 的 scope= 判断
                    if (data?.access_token && (/mail_mailbox/i.test(String(data.scope || "")) || /scope=mail_mailbox/i.test(post))) {
                        grabBearer(`Bearer ${data.access_token}`, url);
                    }
                } catch { /* not json */ }
            }
            if (/maillist\.mail\.com\/Mailbox\/Mail/i.test(url) && res.ok()) {
                try { session.lastList = parseMailListPayload(await res.json()); } catch { /* ignore */ }
            }
        });
        page.setDefaultTimeout(20000);

        console.log(`[mailcom] 登录 ${email} ... 打开首页 ${headed ? "可见 Chrome" : "无头"}${proxyRaw ? " · 经代理" : " · 直连"}`);
        await gotoMailcomHome(page, {retries: 3});
        await page.waitForTimeout(1200);

        // consent / cookie（mail.com 常先落 /consentpage，无登录层）
        for (let c = 0; c < 3; c++) {
            await dismissCookieBanners(page);
            await dismissPopups(page);
            const onConsent = /consent|privacy|cookie/i.test(page.url())
                || /consent|cookie settings|privacy preference/i.test(String(await page.innerText("body").catch(() => "")).slice(0, 400));
            if (!onConsent && await loginFormAttached(page)) break;
            for (const name of [/Continue to Mail/i, /Accept All/i, /Accept all/i, /Accept/i, /Agree/i, /I agree/i, /Allow all/i]) {
                try {
                    const btn = page.getByRole("button", {name}).first();
                    if (await btn.isVisible({timeout: 600}).catch(() => false)) {
                        await btn.click({timeout: 4000}).catch(() => {});
                        await page.waitForTimeout(1200);
                        break;
                    }
                } catch { /* ignore */ }
            }
            if (/consent/i.test(page.url())) {
                // 仍卡 consent：回首页再试
                await page.goto("https://www.mail.com/", {waitUntil: "domcontentloaded", timeout: 30000}).catch(() => {});
                await page.waitForTimeout(1000);
            }
        }
        await dismissPopups(page);

        // 登录表单：先关 cookie/弹窗，再展开首页下拉（#login-email 未展开时 display:none）
        if (!page.url().includes("navigator-lxa")) {
            const pwHint = `${String(password || "").slice(0, 4)}…(${String(password || "").length}位)`;
            console.log(`[mailcom] 填库内当前密码 ${pwHint}（首页下拉，不走 /login/ 404）`);
            if (/\/login\/?(\?|$)/i.test(page.url())) {
                console.log("[mailcom] 当前是 /login/ 404 壳，回到首页再开下拉");
                await gotoMailcomHome(page, {retries: 2});
                await page.waitForTimeout(800);
            }

            let submitted = false;
            try {
                const emailBox = await openMailcomLoginForm(page, {headed});
                if (await inboxAlready(page)) {
                    console.log(`[mailcom] 已在收件箱 url=${page.url().slice(0, 80)}`);
                    submitted = true;
                } else {
                    // 优先可见填写；失败则 DOM 强制提交
                    const visible = await emailBox.isVisible({timeout: 2000}).catch(() => false);
                    if (visible) {
                        await emailBox.click({timeout: 4000}).catch(() => {});
                        await emailBox.fill("");
                        await emailBox.pressSequentially(email, {delay: 35 + Math.floor(Math.random() * 45), timeout: 12000});
                        const pwdBox = page.locator("#login-password").first();
                        await forceShowLoginLayer(page);
                        await pwdBox.waitFor({state: "attached", timeout: 8000});
                        await page.waitForTimeout(180 + Math.floor(Math.random() * 320));
                        await pwdBox.click({force: true, timeout: 4000}).catch(() => {});
                        await pwdBox.fill("").catch(() => {});
                        await pwdBox.pressSequentially(password, {delay: 30 + Math.floor(Math.random() * 40), timeout: 12000}).catch(async () => {
                            await pwdBox.fill(password, {force: true, timeout: 8000}).catch(async () => {
                                await pwdBox.evaluate((el, v) => { el.value = v; el.dispatchEvent(new Event("input", {bubbles: true})); }, password);
                            });
                        });
                        await page.waitForTimeout(220 + Math.floor(Math.random() * 400));
                        for (const sel of [
                            "button.login-submit",
                            "#header-login-box button[type='submit']",
                            "form[action*='login.mail.com'] button[type='submit']",
                            ".login-layer button[type='submit']",
                            "form[data-mod-name='loginform'] button[type='submit']",
                        ]) {
                            if (await clickIfVisible(page, sel, 800)) { submitted = true; break; }
                        }
                        if (!submitted) {
                            submitted = await page.locator("form[action*='login.mail.com'], form[data-mod-name='loginform']").first()
                                .evaluate((f) => { f.requestSubmit(); return true; }).catch(() => false);
                        }
                        if (!submitted) {
                            await pwdBox.press("Enter").catch(() => {});
                            submitted = true;
                        }
                    } else {
                        console.log("[mailcom] 输入框不可见，改用 DOM 强制填提交");
                        const fr = await forceFillAndSubmitLogin(page, email, password);
                        if (!fr?.ok) throw new Error(fr?.reason || "强制提交失败");
                        submitted = true;
                    }
                }
            } catch (uiErr) {
                console.log(`[mailcom] 常规打开登录层失败，DOM 强制提交: ${String(uiErr?.message || uiErr).slice(0, 100)}`);
                const fr = await forceFillAndSubmitLogin(page, email, password);
                if (!fr?.ok) throw uiErr;
                submitted = true;
            }
            console.log(`[mailcom] 已点登录 submitted=${submitted} url=${page.url().slice(0, 80)}`);
            if (/\/login\/?(\?|$)/i.test(page.url()) && !submitted) {
                throw new Error("mail.com 还停在 /login/ 404，表单没提交成功");
            }
        }
        // 等登录结果：真正成功是 sid/webmailer/3c；中间页 /login 不算；logout/首页回落=失败
        console.log(`[mailcom] 等登录结果（最多 40s）`);
        const waitStart = Date.now();
        let sawNavigator = false;
        while (Date.now() - waitStart < 40_000 && !session.bearer) {
            const u = page.url() || "";
            if (isLoginFailedUrl(u)) break;
            if (/navigator-lxa\.mail\.com/i.test(u)) sawNavigator = true;
            if (await inboxAlready(page)) {
                console.log(`[mailcom] 登录壳就绪 url=${u.slice(0, 90)}`);
                break;
            }
            // 提交后几秒仍停在首页且能看见登录框 → 提交没生效或被弹回
            if (Date.now() - waitStart > 10_000 && isMarketingHome(u) && await loginFormAttached(page)) {
                console.log(`[mailcom] 已回首页登录层，判定未登录成功`);
                break;
            }
            await page.waitForTimeout(500);
        }
        console.log(`[mailcom] 当前 url=${page.url().slice(0, 100)} sawNavigator=${sawNavigator}`);

        if (!session.bearer && isLoginFailedUrl(page.url())) {
            throw new Error(`mail.com 账密无效或账号已停用(登录被拒, 跳转 logout): ${email}`);
        }

        // 有 sid 后：先直接 mint mailbox 票；失败再打开 webmailer/3c 等网络拦截
        let navsid = await readNavsid(page);
        if (!navsid) {
            navsid = extractNavsid(page) || "";
        }
        if (navsid && !session.bearer) {
            console.log(`[mailcom] 已有 sid=${navsid.slice(0, 12)}… 直接 mint mailbox 票`);
            const minted = await mintMailboxToken(session, navsid);
            if (minted) session.bearer = minted;
        }

        if (!session.bearer && navsid) {
            // 带 sid 打开 webmailer，等 list 组件自己换票
            const dests = [
                `https://webmailer.mail.com/?navsid=${encodeURIComponent(navsid)}`,
                `https://3c.mail.com/?sid=${encodeURIComponent(navsid)}`,
                `https://navigator-lxa.mail.com/?sid=${encodeURIComponent(navsid)}`,
            ];
            for (const dest of dests) {
                if (session.bearer) break;
                console.log(`[mailcom] 打开 ${dest.slice(0, 60)}… 等 mailbox 票`);
                const waitP = waitForMailboxTokenResponse(page, session, 20000);
                await page.goto(dest, {waitUntil: "domcontentloaded", timeout: 35000}).catch(() => {});
                await dismissPopups(page);
                await waitP;
                if (!session.bearer) {
                    const minted = await mintMailboxToken(session, navsid);
                    if (minted) session.bearer = minted;
                }
                if (!session.bearer) await page.waitForTimeout(2500);
            }
        }

        // 兜底再等一会儿（拦截请求头 Authorization）
        for (let i = 0; i < 12 && !session.bearer; i += 1) {
            const u = page.url() || "";
            if (i === 0 || i === 6) console.log(`[mailcom] 等 mailbox 票 ${i}/12 url=${u.slice(0, 70)}`);
            if (isLoginFailedUrl(u) || (i >= 3 && isMarketingHome(u) && await loginFormAttached(page))) break;
            await page.waitForTimeout(1000);
            if (i === 2 || i === 7) {
                const sid = (await readNavsid(page)) || navsid;
                if (sid) {
                    const minted = await mintMailboxToken(session, sid);
                    if (minted) { session.bearer = minted; break; }
                }
            }
        }
        if (session.bearer) {
            if (opts.skipInbox) {
                console.log(`[mailcom] 验密已拿到 mailbox 票，跳过 3c 收件箱`);
            } else {
                console.log(`[mailcom] 打开 3c 收件箱`);
                if (!/3c\.mail\.com|webmailer/i.test(page.url())) {
                    await page.goto("https://3c.mail.com/", {waitUntil: "domcontentloaded", timeout: 20000}).catch(() => {});
                }
                await page.waitForTimeout(800);
                await dismissPopups(page);
            }
        }
        if (!session.bearer) {
            let reason = "登录后未拿到 mail_mailbox 票(会话未完成或只截到 LPS 票)";
            let body = "";
            try {
                body = await page.innerText("body").catch(() => "");
                const u = page.url() || "";
                if (/blocked your account|irregular activity|contact.*support|precautionary measure/i.test(body)) {
                    reason = "mail.com 账号被风控封禁(irregular activity blocked)";
                } else if (/invalid email address|password combination/i.test(body)) {
                    reason = "mail.com 账密无效(邮箱/密码组合错误)";
                } else if (isLoginFailedUrl(u)) {
                    reason = "mail.com 账密无效或账号已停用(登录被拒)";
                } else if (isMarketingHome(u) && /log in|sign up|sign in/i.test(body)) {
                    reason = "mail.com 登录未成功(已回首页，可能账密错或会话未建立)";
                } else if (/password/i.test(body) && /try again/i.test(body)) {
                    reason = "mail.com 登录失败(页面提示再试，可能账密或验证码)";
                } else if (/navigator-lxa\.mail\.com\/login/i.test(u) && !/[?&](?:sid|navsid)=/i.test(u)) {
                    reason = "mail.com 卡在登录中间页(无 sid)，会话未建立";
                }
            } catch { /* ignore */ }
            console.log(`[mailcom] 登录失败 ${reason} url=${page.url().slice(0, 90)} body=${String(body || "").replace(/\s+/g, " ").slice(0, 160)}`);
            throw new Error(`${reason}: ${email}`);
        }
        return session;
    } catch (e) {
        // 仅手动调试 headed 时留窗；自动化/无头不卡 90s
        const keepOpen = headed && process.env.MAILCOM_KEEP_FAIL_WINDOW === "1" && page && !page.isClosed();
        if (keepOpen) {
            console.log(`[mailcom] 失败，窗口先留 90s 给你看(MAILCOM_KEEP_FAIL_WINDOW=1): ${e?.message || e}`);
            await page.waitForTimeout(90_000).catch(() => {});
        } else if (headed) {
            console.log(`[mailcom] 失败即关窗: ${e?.message || e}`);
        }
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
export async function changeMailcomPassword(email, oldPassword, newPassword, log = (m) => console.log(m), opts = {}) {
    const key = normalizeEmail(email);
    // 改密流程含多层 SSO 跳转 + Wicket,headless 下浏览器易崩("Target page/browser closed");强制 headed(可 env 覆盖)。
    const headless = process.env.CHANGE_PW_HEADLESS === "1";
    const via = await openBrowserProxy(opts.proxy, opts.jump);
    const profile = ensureMailcomProfile(opts.profile, opts.proxy);
    const loginOpts = {headless, proxy: via.url || undefined, timezone: profile.timezoneId, profile};
    // 候选当前密码:依次试登录(自愈——之前"疑似失败但实为成功"的号,库密码已失效,可用记录过的新密码登录)
    const candidates = (Array.isArray(oldPassword) ? oldPassword : [oldPassword]).filter(Boolean);
    let session, usedPw = candidates[0];
    try {
    for (const pw of candidates) {
        try { session = await loginMailcom(key, pw, loginOpts); usedPw = pw; if (candidates.length > 1) log(`用密码 ${pw} 登录成功`); break; }
        catch (e) { if (pw !== candidates[candidates.length - 1]) log(`密码 ${pw} 登录失败,试下一个候选…`); else throw e; }
    }
    const page = session.page;
    {
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
        let v = await verifyMailcomLogin(key, newPassword, log, {proxy: via.url, tries: 2});
        if (!v.ok && !v.wrongPassword) { // 验证登录本身异常(page.fill timeout/网络,非密码错)=瞬时问题 → 重试一次
            log(`验证登录受阻(${(v.reason || "").slice(0, 30)})，重试一次…`);
            await new Promise((r) => setTimeout(r, 2500));
            v = await verifyMailcomLogin(key, newPassword, log, {proxy: via.url, tries: 1});
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
    }
    } finally {
        try { if (session?.browser) await session.browser.close(); } catch { /* ignore */ }
        try { via.close(); } catch { /* ignore */ }
        sessions.delete(key); inboxSessions.delete(key); // 密码已变,清缓存会话
    }
}

/**
 * 校验 mail.com 邮箱密码是否正确:用该密码登录(截获 Bearer=成功)。返回 {ok, reason?}。
 * 独立小工具用,不改任何状态;验证用无头(快、不弹窗)。
 * opts.proxy 可覆盖全局 mailProxy；网络/UI 抖动会自动重试 1 次。
 */
export async function verifyMailcomLogin(email, password, log = (m) => {}, opts = {}) {
    const key = normalizeEmail(email);
    const tries = Math.max(1, Number(opts.tries || 2));
    let last = {ok: false, reason: "未尝试", wrongPassword: false};
    for (let i = 0; i < tries; i++) {
        let session;
        try {
            if (i) log(`${key} 验密重试 ${i + 1}/${tries}…`);
            session = await loginMailcom(key, password, {
                headless: opts.headless ?? true,
                proxy: opts.proxy,
                skipInbox: true,
                profile: opts.profile,
            });
            log(`${key} 登录成功(密码正确)`);
            // 成功/失败必须同形，否则调用方读 pre.wrongPassword 时是 union，
            // 拿不到值就会把"页面异常"当成"账密无效"，好邮箱被标废。
            return {ok: true, reason: "", wrongPassword: false};
        } catch (e) {
            const msg = String(e?.message || e);
            // 区分:明确"账密无效/跳 logout"=密码确实错;其它(page.fill timeout/网络/浏览器崩)=页面异常,不能当密码错
            const wrongPassword = /账密无效|账号已停用|登录被拒|跳转.*logout|invalid.*(email|password)|wrong.*password/i.test(msg);
            const retryable = !wrongPassword && /登录层|不可见|ERR_CONNECTION|ECONN|timeout|Timeout|net::|强制提交|无登录表单|首页/i.test(msg);
            last = {ok: false, reason: msg.slice(0, 160), wrongPassword};
            log(`${key} 验密失败: ${last.reason.slice(0, 100)}${retryable && i + 1 < tries ? "（将重试）" : ""}`);
            if (!retryable) return last;
        } finally {
            if (session?.browser) {
                await Promise.race([
                    session.browser.close().catch(() => {}),
                    new Promise((r) => setTimeout(r, 4000)),
                ]);
                try { session.browser.process()?.kill("SIGKILL"); } catch { /* */ }
            }
        }
    }
    return last;
}

function parseMailListPayload(data) {
    return (data?.mailListElements || []).map((el) => {
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

async function fetchList(session, folder = "INBOX", offset = 0, amount = 50) {
    if (!session.bearer || !isMailboxAuth(session.bearer)) {
        const navsid = session.page ? await readNavsid(session.page) : "";
        if (navsid) {
            const minted = await mintMailboxToken(session, navsid);
            if (minted) session.bearer = minted;
        }
    }
    if (!session.bearer) return session.lastList || null;
    const url = `${MAILLIST_BASE}?folderTypeOrId=${encodeURIComponent(folder)}&offset=${offset}&amount=${amount}&orderBy=${encodeURIComponent("INTERNALDATE DESC")}`;
    const headers = {...LIST_HDR, authorization: session.bearer};
    const payload = JSON.stringify(LIST_BODY);
    const frames = session.page ? session.page.frames().filter((f) => /webmailer\.mail\.com|3c\.mail\.com|navigator-lxa/i.test(f.url())) : [];
    for (const frame of frames) {
        try {
            const inPage = await frame.evaluate(async ({url, headers, body}) => {
                const res = await fetch(url, {method: "POST", headers, body, credentials: "include"});
                return {status: res.status, text: await res.text()};
            }, {url, headers, body: payload});
            if (inPage.status === 401) return "EXPIRED";
            if (inPage.status >= 200 && inPage.status < 300) {
                try { return parseMailListPayload(JSON.parse(inPage.text)); } catch { return null; }
            }
            console.warn(`[mailcom] maillist(in-page ${new URL(frame.url()).host}) HTTP ${inPage.status} ${String(inPage.text).slice(0, 80)}`);
        } catch (e) {
            console.warn(`[mailcom] maillist(in-page) ${String(e?.message || e).slice(0, 80)}`);
        }
    }
    const res = await session.context.request.post(MAILLIST_BASE, {
        params: {folderTypeOrId: folder, offset: String(offset),
            amount: String(amount), orderBy: "INTERNALDATE DESC"},
        headers,
        data: payload,
    });
    if (res.status() === 401) return "EXPIRED";
    if (!res.ok()) {
        const text = await res.text().catch(() => "");
        console.warn(`[mailcom] maillist HTTP ${res.status()} scope=${authScope(session.bearer) || "?"} ${text.slice(0, 160)}`);
        return session.lastList || null;
    }
    return parseMailListPayload(await res.json());
}

async function scrapeInboxOtp(session, email, excludeCode = "") {
    const page = session.page;
    if (!page) return "";
    try {
        if (!/webmailer|3c\.|navigator-lxa/i.test(page.url())) {
            await page.goto("https://3c.mail.com/", {waitUntil: "domcontentloaded", timeout: 30000}).catch(() => {});
            await page.waitForTimeout(2000);
        }
        const text = String(await page.innerText("body").catch(() => ""));
        const found = findLatestVerificationMail(
            [{subject: "inbox", from: "openai", content: text, timestamp: Date.now(), recipient: [email]}],
            {targetEmail: email},
        );
        if (found?.verificationCode && found.verificationCode !== excludeCode) return found.verificationCode;
        const rows = page.locator("[data-test-id], .list-item, tr, [role='row'], [class*='mail']").filter({hasText: /openai|chatgpt|verification|verify/i});
        const n = Math.min(await rows.count().catch(() => 0), 6);
        for (let i = 0; i < n; i++) {
            await rows.nth(i).click({timeout: 2000}).catch(() => {});
            await page.waitForTimeout(800);
            const body = String(await page.innerText("body").catch(() => ""));
            const hit = findLatestVerificationMail(
                [{subject: "opened", from: "openai", content: body, timestamp: Date.now(), recipient: [email]}],
                {targetEmail: email},
            );
            if (hit?.verificationCode && hit.verificationCode !== excludeCode) return hit.verificationCode;
        }
    } catch (e) {
        console.warn(`[mailcom] scrapeInbox ${String(e?.message || e).slice(0, 80)}`);
    }
    return "";
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
            if (session.page && !/3c\.|webmailer/i.test(session.page.url())) {
                await session.page.goto("https://3c.mail.com/", {waitUntil: "domcontentloaded", timeout: 30000}).catch(() => {});
                await session.page.waitForTimeout(2000);
            }

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
                    } else {
                        const scraped = await scrapeInboxOtp(session, email, excludeCode);
                        if (scraped) {
                            console.log(`[mailcom] 网页收件箱 OTP=${scraped}`);
                            return scraped;
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
        date: m.timestamp ? formatBeijingDateTime(Number(m.timestamp)) : "",
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
