// @ts-nocheck
/**
 * Gmail 取件开通：在已登录的 page 上开 IMAP + 生成应用专用密码。
 * 买来的老号做不了官方 Gmail OAuth（要 Cloud 项目 + 验证应用），
 * 开了 2FA 之后官方允许的取件方式就是「应用专用密码 + IMAP」。
 */
import {googleReauthPassword, googleSslDead, recoverSslOrSlowPage, isVerifyItsYouText} from "./google-auth.js";
import {ImapFlow} from "imapflow";

const IMAP_SETTINGS = "https://mail.google.com/mail/u/0/#settings/fwdandpop";
const APP_PASSWORD_URL = "https://myaccount.google.com/apppasswords?hl=en";

async function clickFirst(page, selectors, timeout = 2500) {
    for (const sel of selectors) {
        try {
            const loc = typeof sel === "string" ? page.locator(sel).first() : sel;
            if (await loc.isVisible({timeout: Math.min(timeout, 1500)}).catch(() => false)) {
                await loc.click({timeout});
                return true;
            }
        } catch { /* next */ }
    }
    return false;
}

const APP_PW_NOISE = /next|more|ways|code|pass|word|mail|goog|account|create|gener|appli|name|help|save|done|back|continue|sign|login|security/i;

function extractAppPassword(text) {
    const src = String(text || "");
    const grouped = src.match(/\b([a-z]{4}\s+[a-z]{4}\s+[a-z]{4}\s+[a-z]{4})\b/i);
    if (grouped && !APP_PW_NOISE.test(grouped[1].replace(/\s+/g, ""))) {
        return grouped[1].replace(/\s+/g, "").toLowerCase();
    }
    return "";
}

/** 打开 Gmail 设置里的 IMAP（默认很多号已开，失败不阻断）。 */
export async function enableGmailImap(page, log = () => {}) {
    log("[取件] 打开 Gmail IMAP 设置");
    try {
        await page.goto(IMAP_SETTINGS, {waitUntil: "domcontentloaded", timeout: 60000});
    } catch { /* ignore */ }
    await page.waitForTimeout(4000);

    const frames = [page, ...page.frames()];
    for (const frame of frames) {
        const enable = frame.getByText(/Enable IMAP|启用 IMAP|Aktifkan IMAP|Ativar IMAP/i).first();
        if (await enable.isVisible({timeout: 1500}).catch(() => false)) {
            await enable.click().catch(() => {});
            log("[取件] 已点 Enable IMAP");
            const save = frame.getByRole("button", {name: /Save Changes|保存更改|Simpan/i}).first();
            if (await save.isVisible({timeout: 1500}).catch(() => false)) {
                await save.click().catch(() => {});
                log("[取件] 已保存 IMAP 设置");
            }
            await page.waitForTimeout(1500);
            return true;
        }
    }
    log("[取件] 未见 IMAP 开关(可能已开启)");
    return false;
}

async function dumpAppPwFail(page) {
    try {
        const {mkdirSync} = await import("node:fs");
        const path = await import("node:path");
        const dir = path.resolve(process.cwd(), "captures", "screenshots");
        mkdirSync(dir, {recursive: true});
        await page.screenshot({path: path.join(dir, `apppw_fail_${Date.now()}.png`)});
    } catch { /* ignore */ }
}

async function readAppPassword(page) {
    let secret = extractAppPassword(await page.innerText("body").catch(() => ""));
    if (secret) return secret;
    for (const frame of page.frames()) {
        secret = extractAppPassword(await frame.innerText("body").catch(() => ""));
        if (secret) return secret;
    }
    return "";
}

async function clickCreateAppPassword(page, log) {
    const named = page.getByRole("button", {name: /^(create|generate|创建|生成|buat|criar)$/i})
        .or(page.getByRole("button", {name: /create|generate|创建|生成/i}));
    if (await named.first().isVisible({timeout: 800}).catch(() => false)) {
        await named.first().scrollIntoViewIfNeeded().catch(() => {});
        await named.first().click({timeout: 2500}).catch(() => named.first().click({force: true}));
        log("[取件] 点了 Create");
        return true;
    }
    const hit = await clickFirst(page, [
        'button:has-text("Create")',
        'button:has-text("Generate")',
        'button:has-text("创建")',
        'button:has-text("生成")',
    ], 2000);
    if (hit) log("[取件] 点了 Create");
    return hit;
}

/** 生成一枚应用专用密码，返回 16 位（无空格）。 */
export async function createGmailAppPassword(page, {
    password = "", totpSecret = "", totpFallback = "", appName = "mail-fetch", log = () => {},
} = {}) {
    log("[取件] 打开应用专用密码页");
    try {
        await page.goto(APP_PASSWORD_URL, {waitUntil: "domcontentloaded", timeout: 60000});
    } catch { /* ignore */ }
    await page.waitForTimeout(1500);
    if (await googleSslDead(page)) {
        const dest = APP_PASSWORD_URL;
        const recovered = await recoverSslOrSlowPage(page, log, dest, 3);
        if (!recovered && await googleSslDead(page)) {
            throw new Error("代理中断 应用专用密码页 SSL，换 session 重开窗");
        }
    }

    for (let gate = 0; gate < 4; gate++) {
        const body = String(await page.innerText("body").catch(() => ""));
        if (await googleSslDead(page)) {
            throw new Error("代理中断 应用专用密码页 SSL，换 session 重开窗");
        }
        if (isVerifyItsYouText(body) || /accounts\.google\.com\/(signin|challenge|v3)/i.test(page.url())) {
            log("[取件] 应用专用密码页要二次验证");
            await googleReauthPassword(page, {password, totpSecret, totpFallback, log});
            await page.waitForTimeout(800);
            if (!/apppasswords/i.test(page.url()) && !isVerifyItsYouText(String(await page.innerText("body").catch(() => "")))) {
                try { await page.goto(APP_PASSWORD_URL, {waitUntil: "domcontentloaded", timeout: 60000}); } catch { /* */ }
            }
            continue;
        }
        break;
    }

    const blocked = await page.innerText("body").catch(() => "");
    if (/turn on 2-step|enable 2-step|两步验证|2-Step Verification is off/i.test(blocked)
        && /app password/i.test(blocked)) {
        throw new Error("未开 Google 2FA，无法创建应用专用密码");
    }
    if (isVerifyItsYouText(blocked) || /accounts\.google\.com\/(signin|challenge|v3)/i.test(page.url())) {
        await dumpAppPwFail(page);
        throw new Error("应用专用密码页二次验证未过");
    }

    const nameBox = () => page.locator(
        'input[type="text"]:visible, input[aria-label*="App name" i], input[aria-label*="应用" i], input[name*="name" i]',
    ).first();

    const fillAppName = async () => {
        const nameInput = nameBox();
        if (!await nameInput.isVisible({timeout: 4000}).catch(() => false)) return "";
        const label = `${appName}-${Date.now().toString(36).slice(-4)}`;
        await nameInput.click().catch(() => {});
        await nameInput.fill("");
        await nameInput.fill(label);
        await page.waitForTimeout(300);
        await nameInput.press("Tab").catch(() => {});
        log(`[取件] 已填应用名 ${label}`);
        return label;
    };

    await fillAppName();
    await page.waitForTimeout(800);

    let secret = "";
    for (let tryCreate = 0; tryCreate < 5 && !secret; tryCreate++) {
        if (tryCreate > 0) {
            const body = String(await page.innerText("body").catch(() => ""));
            if (/error generating your app password|生成.*应用.*密码|无法生成应用/i.test(body)) {
                log(`[取件] Google 拒绝生成应用密码，等一会再试 ${tryCreate}/5`);
                await page.waitForTimeout(6000);
                try { await page.goto(APP_PASSWORD_URL, {waitUntil: "domcontentloaded", timeout: 60000}); } catch { /* */ }
                await page.waitForTimeout(1500);
                if (isVerifyItsYouText(String(await page.innerText("body").catch(() => "")))) {
                    await googleReauthPassword(page, {password, totpSecret, totpFallback, log});
                }
                await fillAppName();
            }
        }
        const created = await clickCreateAppPassword(page, log);
        if (!created && tryCreate === 0) {
            const nb = nameBox();
            if (await nb.isVisible({timeout: 400}).catch(() => false)) {
                await nb.press("Enter").catch(() => {});
                log("[取件] Create 没点到，应用名框回车");
            } else {
                log("[取件] 未点到创建按钮，尝试从页面直接抽密码");
            }
        }
        let genErr = false;
        for (let w = 0; w < 12 && !secret; w++) {
            await page.waitForTimeout(500);
            secret = await readAppPassword(page);
            const body = String(await page.innerText("body").catch(() => ""));
            if (/error generating your app password|生成.*应用.*密码|无法生成应用/i.test(body)) {
                genErr = true;
                break;
            }
        }
        if (secret) break;
        if (genErr) continue;
        if (isVerifyItsYouText(String(await page.innerText("body").catch(() => "")))) {
            log("[取件] 点 Create 后又要二次验证");
            await googleReauthPassword(page, {password, totpSecret, totpFallback, log});
            await fillAppName();
        }
    }
    if (!secret) {
        await dumpAppPwFail(page);
        throw new Error("未能提取应用专用密码(未点到创建或页面无 4 组密码)");
    }
    log(`[取件] 应用专用密码已生成: ${secret.slice(0, 4)}****`);
    await clickFirst(page, [
        page.getByRole("button", {name: /Done|完成|OK|Got it|知道了/i}).first(),
        'button:has-text("Done")',
        'button:has-text("完成")',
    ], 2000);
    return secret;
}

function attachImapErrorSink(client) {
    // ImapFlow 的 TLS 错误走 EventEmitter；不 listen 会 Unhandled 'error' 把整进程打死。
    client.on("error", () => {});
    return client;
}

async function probeImapOnce(email, imapPassword, via = "") {
    const client = attachImapErrorSink(new ImapFlow({
        host: "imap.gmail.com", port: 993, secure: true,
        auth: {user: email, pass: imapPassword},
        logger: false,
        emitLogs: false,
        connectionTimeout: 12_000,
        greetingTimeout: 10_000,
        socketTimeout: 15_000,
        ...(via ? {proxy: via} : {}),
    }));
    try {
        await client.connect();
        const lock = await client.getMailboxLock("INBOX");
        const status = await client.status("INBOX", {messages: true});
        lock.release();
        await client.logout().catch(() => {});
        return {ok: true, messages: status?.messages ?? 0};
    } catch (e) {
        try { client.close(); } catch { /* */ }
        try { await client.logout(); } catch { /* */ }
        return {ok: false, error: String(e?.message || e).replace(/\s+/g, " ").slice(0, 160)};
    }
}

export async function testGmailImap(email, imapPassword, {proxy = "", log = (m) => {}} = {}) {
    const {getMailProxyJump} = await import("./proxy-pool.js");
    const jump = String(proxy || getMailProxyJump() || "").trim();
    log(`[imap] ${email} 直连探活（最多约 12s）`);
    const direct = await probeImapOnce(email, imapPassword, "");
    if (direct.ok) {
        log(`[imap] 直连通，收件箱 ${direct.messages ?? 0} 封`);
        return direct;
    }
    if (!jump) {
        log(`[imap] 直连失败 ${direct.error}`);
        return direct;
    }
    if (/ERR_SSL|bad record mac|decryption failed|ECONNREFUSED/i.test(direct.error || "")) {
        // 直连 TLS 已经烂了，再套跳板更容易坏 MAC；应用密码照样保留。
        log(`[imap] 直连 TLS 失败，不再走跳板: ${direct.error}`);
        return direct;
    }
    log(`[imap] 直连失败 ${direct.error}，改跳板再探`);
    const via = await probeImapOnce(email, imapPassword, jump);
    log(via.ok ? `[imap] 跳板通，收件箱 ${via.messages ?? 0} 封` : `[imap] 跳板也失败 ${via.error}`);
    return via;
}

// ---- 邮箱管理「收件箱」：Gmail 用应用专用密码走 IMAP 列表/正文 ----
const gmailImapBodyCache = new Map(); // email -> {at, byId: Map<id, text>}

function normalizeGmailKey(email) {
    return String(email || "").trim().toLowerCase();
}

function addrListToStr(list) {
    if (!Array.isArray(list) || !list.length) return "";
    return list.map((a) => {
        const name = String(a?.name || "").trim();
        const addr = String(a?.address || "").trim();
        if (name && addr) return `${name} <${addr}>`;
        return addr || name;
    }).filter(Boolean).join(", ");
}

function sourceToReadable(raw) {
    let s = Buffer.isBuffer(raw) ? raw.toString("utf8") : String(raw || "");
    // 粗拆 MIME：优先 text/plain，再 text/html
    const plain = s.match(/Content-Type:\s*text\/plain[\s\S]*?\r?\n\r?\n([\s\S]*?)(?=\r?\n--|\r?\nContent-Type:|$)/i);
    const html = s.match(/Content-Type:\s*text\/html[\s\S]*?\r?\n\r?\n([\s\S]*?)(?=\r?\n--|\r?\nContent-Type:|$)/i);
    let body = (plain?.[1] || html?.[1] || s).trim();
    // 去 base64 块（简单场景）
    if (/^[A-Za-z0-9+/=\r\n]+$/.test(body.slice(0, 200)) && body.length > 80) {
        try {
            const b64 = body.replace(/\s+/g, "");
            if (b64.length > 40 && b64.length % 4 === 0) body = Buffer.from(b64, "base64").toString("utf8");
        } catch { /* keep */ }
    }
    body = body
        .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, " ")
        .replace(/<a\b[^>]*\bhref\s*=\s*["']?([^"'\s>]+)["']?[^>]*>([\s\S]*?)<\/a>/gi, (_m, href, txt) => {
            const text = String(txt).replace(/<[^>]+>/g, "").replace(/&nbsp;/gi, " ").trim();
            return text && !text.includes(href) ? `${text} (${href})` : (text || href);
        })
        .replace(/<\/(p|div|tr|li|h[1-6]|table)>/gi, "\n")
        .replace(/<br\s*\/?>/gi, "\n")
        .replace(/<[^>]+>/g, " ")
        .replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&").replace(/&lt;/gi, "<").replace(/&gt;/gi, ">")
        .replace(/&quot;/gi, '"').replace(/&#39;/gi, "'");
    return body.split("\n").map((l) => l.replace(/[ \t]+/g, " ").trim()).join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

async function withGmailImap(email, imapPassword, fn, {proxy = ""} = {}) {
    const pass = String(imapPassword || "").replace(/\s+/g, "");
    if (!pass) throw new Error("Gmail 没有 IMAP 应用专用密码，请先整备开通");
    const {getMailProxyJump} = await import("./proxy-pool.js");
    const jump = String(proxy || getMailProxyJump() || "").trim();
    const attempts = jump ? ["", jump] : [""];
    let lastErr;
    for (const via of attempts) {
        const client = attachImapErrorSink(new ImapFlow({
            host: "imap.gmail.com", port: 993, secure: true,
            auth: {user: email, pass},
            logger: false,
            emitLogs: false,
            connectionTimeout: 15_000,
            greetingTimeout: 12_000,
            socketTimeout: 25_000,
            ...(via ? {proxy: via} : {}),
        }));
        try {
            await client.connect();
            const out = await fn(client);
            await client.logout().catch(() => {});
            return out;
        } catch (e) {
            lastErr = e;
            try { client.close(); } catch { /* */ }
            try { await client.logout(); } catch { /* */ }
            if (via || !jump) break;
            if (/ERR_SSL|bad record mac|decryption failed|authentication|Invalid credentials|LOGIN failed/i.test(String(e?.message || e))) break;
        }
    }
    throw new Error(String(lastErr?.message || lastErr || "IMAP 失败").replace(/\s+/g, " ").slice(0, 160));
}

/** 拉 Gmail INBOX 最近 amount 封（头信息），供邮箱管理收件箱。 */
export async function fetchGmailImapInbox(email, imapPassword, amount = 30, {proxy = ""} = {}) {
    const key = normalizeGmailKey(email);
    const n = Math.max(1, Math.min(100, Number(amount) || 30));
    return withGmailImap(email, imapPassword, async (client) => {
        const lock = await client.getMailboxLock("INBOX");
        try {
            const status = await client.status("INBOX", {messages: true});
            const total = Number(status?.messages || 0);
            if (!total) {
                gmailImapBodyCache.set(key, {at: Date.now(), byId: new Map()});
                return [];
            }
            const start = Math.max(1, total - n + 1);
            const mails = [];
            const byId = new Map();
            for await (const msg of client.fetch(`${start}:*`, {
                uid: true,
                envelope: true,
                source: true,
            })) {
                const env = msg.envelope || {};
                const ts = env.date ? new Date(env.date).getTime() : 0;
                const id = String(msg.uid);
                const head = {
                    id,
                    from: addrListToStr(env.from),
                    subject: String(env.subject || ""),
                    timestamp: ts,
                    date: ts ? new Date(ts).toISOString().replace("T", " ").slice(0, 16) : "",
                };
                mails.push(head);
                try { byId.set(id, sourceToReadable(msg.source)); } catch { byId.set(id, ""); }
            }
            // 新→旧
            mails.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
            gmailImapBodyCache.set(key, {at: Date.now(), byId});
            return mails;
        } finally {
            try { lock.release(); } catch { /* */ }
        }
    }, {proxy});
}

/** 按 UID 取正文（优先列表缓存）。 */
export async function fetchGmailImapBody(email, mailId, imapPassword, {proxy = ""} = {}) {
    const key = normalizeGmailKey(email);
    const id = String(mailId || "");
    const cached = gmailImapBodyCache.get(key);
    if (cached?.byId?.has(id) && Date.now() - (cached.at || 0) < 10 * 60_000) {
        return cached.byId.get(id) || "(无正文)";
    }
    return withGmailImap(email, imapPassword, async (client) => {
        const lock = await client.getMailboxLock("INBOX");
        try {
            let text = "";
            for await (const msg of client.fetch(String(id), {uid: true, source: true}, {uid: true})) {
                text = sourceToReadable(msg.source);
                break;
            }
            if (!gmailImapBodyCache.has(key)) gmailImapBodyCache.set(key, {at: Date.now(), byId: new Map()});
            const bag = gmailImapBodyCache.get(key);
            bag.at = Date.now();
            bag.byId.set(id, text || "(无正文)");
            return text || "(无正文)";
        } finally {
            try { lock.release(); } catch { /* */ }
        }
    }, {proxy});
}

/** 开 IMAP + 生成应用专用密码，并立刻用 IMAP 探活。 */
export async function enableGmailFetch(page, {
    email, password = "", totpSecret = "", totpFallback = "", log = () => {},
} = {}) {
    await enableGmailImap(page, log).catch((e) => log(`[取件] IMAP 设置跳过: ${e?.message || e}`));
    const imapPassword = await createGmailAppPassword(page, {password, totpSecret, totpFallback, log});
    const probe = await testGmailImap(email, imapPassword);
    if (!probe.ok) {
        // 本机直连/探活失败不否掉已生成的应用密码，否则会空等 90 秒再整单失败。
        log(`[取件] 应用密码已保存，本机探活未通: ${probe.error}`);
        return {ok: true, imapPassword, probeOk: false, error: probe.error};
    }
    log(`[取件] IMAP 已通(收件箱 ${probe.messages} 封)`);
    return {ok: true, imapPassword, messages: probe.messages, probeOk: true};
}
