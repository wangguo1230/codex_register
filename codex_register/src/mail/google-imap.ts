// @ts-nocheck
/**
 * Gmail 取件开通：在已登录的 page 上开 IMAP + 生成应用专用密码。
 * 买来的老号做不了官方 Gmail OAuth（要 Cloud 项目 + 验证应用），
 * 开了 2FA 之后官方允许的取件方式就是「应用专用密码 + IMAP」。
 */
import {googleReauthPassword} from "./google-auth.js";
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

/** 生成一枚应用专用密码，返回 16 位（无空格）。 */
export async function createGmailAppPassword(page, {
    password = "", totpSecret = "", appName = "mail-fetch", log = () => {},
} = {}) {
    log("[取件] 打开应用专用密码页");
    try {
        await page.goto(APP_PASSWORD_URL, {waitUntil: "domcontentloaded", timeout: 60000});
    } catch { /* ignore */ }
    await page.waitForTimeout(3000);
    await googleReauthPassword(page, {password, totpSecret, log});
    await page.waitForTimeout(2500);

    const blocked = await page.innerText("body").catch(() => "");
    if (/turn on 2-step|enable 2-step|两步验证|2-Step Verification is off/i.test(blocked)
        && /app password/i.test(blocked)) {
        throw new Error("未开 Google 2FA，无法创建应用专用密码");
    }

    const nameInput = page.locator(
        'input[type="text"]:visible, input[aria-label*="App name" i], input[aria-label*="应用" i], input[name*="name" i]',
    ).first();
    if (await nameInput.isVisible({timeout: 4000}).catch(() => false)) {
        await nameInput.fill("");
        await nameInput.fill(`${appName}-${Date.now().toString(36).slice(-4)}`);
        await page.waitForTimeout(400);
    }

    const created = await clickFirst(page, [
        page.getByRole("button", {name: /Create|Generate|创建|生成|Buat|Criar/i}).first(),
        'button:has-text("Create")',
        'button:has-text("Generate")',
        'button:has-text("创建")',
        'button:has-text("生成")',
    ], 3000);
    if (!created) log("[取件] 未点到创建按钮，尝试从页面直接抽密码");
    await page.waitForTimeout(2500);

    let secret = extractAppPassword(await page.innerText("body").catch(() => ""));
    if (!secret) {
        for (const frame of page.frames()) {
            secret = extractAppPassword(await frame.innerText("body").catch(() => ""));
            if (secret) break;
        }
    }
    if (!secret) {
        try {
            const {mkdirSync} = await import("node:fs");
            const path = await import("node:path");
            const dir = path.resolve(process.cwd(), "captures", "screenshots");
            mkdirSync(dir, {recursive: true});
            await page.screenshot({path: path.join(dir, `apppw_fail_${Date.now()}.png`)});
        } catch { /* ignore */ }
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

export async function testGmailImap(email, imapPassword, {proxy = ""} = {}) {
    const {getMailProxyJump} = await import("./proxy-pool.js");
    const jump = String(proxy || getMailProxyJump() || "").trim();
    const client = new ImapFlow({
        host: "imap.gmail.com", port: 993, secure: true,
        auth: {user: email, pass: imapPassword},
        logger: false,
        connectionTimeout: 12_000,
        greetingTimeout: 10_000,
        socketTimeout: 15_000,
        ...(jump ? {proxy: jump} : {}),
    });
    try {
        await client.connect();
        const lock = await client.getMailboxLock("INBOX");
        const status = await client.status("INBOX", {messages: true});
        lock.release();
        await client.logout().catch(() => {});
        return {ok: true, messages: status?.messages ?? 0};
    } catch (e) {
        try { await client.close(); } catch { /* */ }
        try { await client.logout(); } catch { /* */ }
        return {ok: false, error: String(e?.message || e).replace(/\s+/g, " ").slice(0, 160)};
    }
}

/** 开 IMAP + 生成应用专用密码，并立刻用 IMAP 探活。 */
export async function enableGmailFetch(page, {
    email, password = "", totpSecret = "", log = () => {},
} = {}) {
    await enableGmailImap(page, log).catch((e) => log(`[取件] IMAP 设置跳过: ${e?.message || e}`));
    const imapPassword = await createGmailAppPassword(page, {password, totpSecret, log});
    const probe = await testGmailImap(email, imapPassword);
    if (!probe.ok) {
        // 本机直连/探活失败不否掉已生成的应用密码，否则会空等 90 秒再整单失败。
        log(`[取件] 应用密码已保存，本机探活未通: ${probe.error}`);
        return {ok: true, imapPassword, probeOk: false, error: probe.error};
    }
    log(`[取件] IMAP 已通(收件箱 ${probe.messages} 封)`);
    return {ok: true, imapPassword, messages: probe.messages, probeOk: true};
}
