// @ts-nocheck
/**
 * Google 账号改密 / 换 TOTP（Playwright 网页版）
 * 完整移植自 google-automation/web/backend/web_tasks/{change_pwd,change_2fa}.py
 */
import {randomBytes} from "node:crypto";
import {mkdirSync} from "node:fs";
import path from "node:path";
import {generateTotp, waitNextTotpWindow, waitTotpSafeWindow} from "../mfa.js";
import {ensureGoogleLoggedIn, googleReauthPassword, isVerifyItsYouText, submitGoogleTotp, bounceOffSslOrSid, preferEnglishGoogleUi} from "./google-auth.js";
import {launchGoogleBrowser} from "./google-account.js";

const PASSWORD_URL = "https://myaccount.google.com/signinoptions/password?hl=en";
const TWO_STEP_URL = "https://myaccount.google.com/signinoptions/two-step-verification?hl=en";

const CHANGE_PWD_KEYWORDS = [
    "Ubah sandi", "Change password", "更改密码", "Alterar senha",
    "Modifier le mot de passe", "Cambiar contraseña", "Baguhin ang password",
    "पासवर्ड बदलें", "Ganti password",
];
const SUCCESS_KEYWORDS = [
    "Sandi berhasil diubah", "Password changed", "Password changed successfully",
    "密码已更改", "Senha alterada",
    "Mot de passe modifié", "Contraseña cambiada", "Na-update ang password",
    "पासवर्ड बदला गया", "berhasil", "successfully", "已更新",
    "We keep your account protected",
];

const CHANGE_KEYWORDS = [
    "Mudar o app autenticador", "Ubah aplikasi pengautentikasi",
    "Change authenticator app", "更改身份验证器", "Changer l'application",
    "Cambiar la app del autenticador", "प्रमाणक ऐप्लिकेशन बदलें",
    "Baguhin ang authenticator app",
    "Kimlik doğrulayıcı uygulaması değiştir", "Autentimisrakenduse muutmine",
    "Authenticator-App ändern", "Ändra autentiseringsapp", "Wijzig authenticator-app",
    "Cambia app di autenticazione", "Zmień aplikację uwierzytelniającą",
];
const SETUP_KEYWORDS = [
    "Configurar o app autenticador", "Siapkan pengautentikasi",
    "Set up authenticator", "设置身份验证器", "Configurer l'authentificateur",
    "Configurar el autenticador", "Mag-set up ng authenticator",
];
const CHANGE_AUTH_RE = /change authenticator|set up authenticator|authenticator app|kimlik do[gğ]rulay[ıi]c[ıi].*de[gğ]i[sş]tir|autentimisrakenduse muutmine|mudar o app|ubah aplikasi|changer l.?application|cambiar la app|更改身份验证|设置身份验证|authenticator-app [aä]ndern|[aä]ndra autentiser|wijzig authenticator|cambia app di autentic|zmie[nń] aplikacj|de[gğ]i[sş]tir|muutmine|ändern|modifier|cambiar|alterar|ganti|configur|siapkan|set up|change app|^change$|^更改$|^设置$/i;
const CANT_SCAN_KEYWORDS = [
    "Can't scan it", "Can’t scan it", "Can't scan", "Can’t scan",
    "Não consegue ler", "Tidak dapat memindai",
    "无法扫描", "Impossible de scanner", "No se puede escanear",
    "Hindi ma-scan", "Vous ne pouvez pas le scanner",
    "Não é possível lê-lo", "Não consegue lê-lo",
    "nicht scannen", "Sie können ihn nicht scannen",
    "No puedes escanearlo",
];
const NEXT_KEYWORDS = [
    "Weiter", "Seguinte", "Avançar", "Próxima", "Berikutnya", "Next", "下一步",
    "Suivant", "Siguiente", "Susunod", "अगला", "Lanjut",
];
const VERIFY_KEYWORDS = [
    "Bestätigen", "Verificar", "Verifikasi", "Verify", "验证", "Vérifier",
    "Mag-verify", "Xác minh",
];

const COMMON_WORDS = new Set([
    "NEXT", "BACK", "DONE", "HELP", "SIGN", "STEP", "CODE", "SCAN",
    "SKIP", "SAVE", "EDIT", "OPEN", "CLOSE", "CANCEL", "VERIFY",
    "ENGLISH", "PRIVACY", "TERMS", "LEARN", "MORE", "ABOUT",
    "AUTHENTICATOR", "GOOGLE", "ACCOUNT", "SECURITY", "PASSWORD",
]);

/** 与原仓库 _generate_password 一致：大小写 + 数字 + !@#$%&* */
export function generateGooglePassword(length = 16) {
    const alphabet = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!@#$%&*";
    const pick = () => alphabet[randomBytes(1)[0] % alphabet.length];
    for (;;) {
        let pwd = "";
        for (let i = 0; i < length; i++) pwd += pick();
        if (/[a-z]/.test(pwd) && /[A-Z]/.test(pwd) && /\d/.test(pwd)) return pwd;
    }
}

function escapeRegExp(s) {
    return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function clickText(page, keywords, timeout = 3000) {
    for (const kw of keywords) {
        const loc = page.locator(`text="${kw}"`);
        try {
            if (await loc.first().isVisible({timeout: Math.min(timeout, 1500)})) {
                await loc.first().click();
                return kw;
            }
        } catch {
            /* ignore */
        }
    }
    for (const kw of keywords) {
        const pattern = escapeRegExp(kw).replace(/'/g, "['‘’']").replace(/’/g, "['‘’']");
        const loc = page.locator(`text=/${pattern}/i`);
        try {
            if (await loc.first().isVisible({timeout: Math.min(timeout, 1500)})) {
                await loc.first().click();
                return kw;
            }
        } catch {
            /* ignore */
        }
    }
    return "";
}

async function clickVisibleButton(page, keywords) {
    for (const kw of keywords) {
        const btns = page.locator(`button:has-text("${kw}")`);
        const n = await btns.count();
        for (let i = 0; i < n; i++) {
            try {
                if (await btns.nth(i).isVisible()) {
                    await btns.nth(i).click();
                    return true;
                }
            } catch {
                /* ignore */
            }
        }
    }
    return false;
}

async function dumpPage(page, name, log, email = "") {
    try {
        const dir = path.resolve(process.cwd(), "captures", "screenshots");
        mkdirSync(dir, {recursive: true});
        const now = new Date();
        const ts = [now.getHours(), now.getMinutes(), now.getSeconds()]
            .map((n) => String(n).padStart(2, "0")).join("");
        const tag = String(email.split("@")[0] || "").slice(0, 12);
        const file = path.join(dir, `${name}_${tag}_${ts}.png`);
        await page.screenshot({path: file});
        const text = await page.innerText("body");
        log(`  截图: ${file}`);
        log(`  页面: ${String(text).slice(0, 200)}`);
    } catch {
        /* ignore */
    }
}

function isLikelySecret(s) {
    if (!/^[A-Z2-7]+$/.test(s)) return false;
    if (COMMON_WORDS.has(s)) return false;
    const chunks = [];
    for (let i = 0; i < s.length; i += 4) chunks.push(s.slice(i, i + 4));
    if (new Set(chunks).size <= 2) return false;
    return true;
}

/** 8 组 4 字符(32 位)或 4 组 4 字符(16 位)；过滤常见单词。 */
export function extractTotpSecret(text) {
    const src = String(text || "");
    const grouped = src.match(/([a-z2-7]{4}(?:[ ]+[a-z2-7]{4}){3,15})/gi) || [];
    for (const c of grouped) {
        const cleaned = c.replace(/ /g, "").toUpperCase();
        if (cleaned.length >= 16 && isLikelySecret(cleaned)) return cleaned;
    }
    const compact = src.match(/\b([a-z2-7]{32,64})\b/gi) || [];
    for (const m of compact) {
        const up = m.toUpperCase();
        if (isLikelySecret(up)) return up;
    }
    return "";
}

async function withGooglePage(fn) {
    const browser = await launchGoogleBrowser();
    try {
        const ctx = await browser.newContext({locale: "en-US", viewport: {width: 1280, height: 860}});
        const page = await ctx.newPage();
        page.setDefaultTimeout(30000);
        return await fn(page);
    } finally {
        await browser.close().catch(() => {});
    }
}

/**
 * 在已打开的 page 上改密（对应原 change_password）。
 * 登录失败 / 无输入框返回 {ok:false}；提交后返回新密码（verified 看成功文案）。
 */
export async function changePasswordOnPage(page, {
    email, password, totpSecret = "", recoveryEmail = "", newPassword = "", log = () => {},
} = {}) {
    log("[密码] 开始修改密码");
    const ok = await ensureGoogleLoggedIn(
        page, PASSWORD_URL,
        {email, password, totpSecret, recoveryEmail, requireInbox: false},
        log,
    );
    if (!ok) {
        log("[密码] 登录失败");
        return {ok: false, newPassword: newPassword || "", detail: "Google 登录失败"};
    }
    try { await page.goto(PASSWORD_URL, {waitUntil: "domcontentloaded", timeout: 30000}); } catch { /* ignore */ }
    await bounceOffSslOrSid(page, log);
    await page.waitForTimeout(1500);
    await preferEnglishGoogleUi(page, log, PASSWORD_URL);

    await googleReauthPassword(page, {password, totpSecret, log});
    await bounceOffSslOrSid(page, log);
    await page.waitForTimeout(3000);
    await bounceOffSslOrSid(page, log);

    const np = newPassword || generateGooglePassword();
    let pwdInputs = page.locator('input[type="password"]:visible');
    let count = 0;
    for (let i = 0; i < 5; i++) {
        pwdInputs = page.locator('input[type="password"]:visible');
        count = await pwdInputs.count();
        if (count >= 2) break;
        await page.waitForTimeout(3000);
    }

    if (count >= 2) {
        await pwdInputs.nth(0).fill(np);
        await page.waitForTimeout(500);
        await pwdInputs.nth(1).fill(np);
        await page.waitForTimeout(500);
        log(`[密码] 新密码已输入: ${np}`);
    } else if (count === 1) {
        const body = String(await page.innerText("body").catch(() => ""));
        if (/Wrong password|Enter your password|Forgot password/i.test(body)) {
            log("[密码] 仍在二次验证页，未进入改密表单");
            await dumpPage(page, "pwd_still_reauth", log, email);
            return {ok: false, newPassword: "", detail: "二次验证未过，未改密"};
        }
        await pwdInputs.nth(0).fill(np);
        await page.waitForTimeout(500);
        log(`[密码] 新密码已输入(单字段): ${np}`);
    } else {
        const text = await page.innerText("body");
        log(`[密码] 未找到密码输入框, 页面: ${String(text).slice(0, 200)}`);
        await dumpPage(page, "pwd_no_input", log, email);
        return {ok: false, newPassword: np, detail: "未找到密码输入框"};
    }

    let clicked = false;
    const submit = page.locator('form button[type="submit"], #passwordNext button, #passwordNext, c-wiz form button').last();
    if (await submit.isVisible({timeout: 1500}).catch(() => false)) {
        await submit.click().catch(() => submit.click({force: true}));
        clicked = true;
        log("[密码] 点了表单提交按钮");
        await page.waitForTimeout(5000);
    }
    if (!clicked) {
        for (const kw of CHANGE_PWD_KEYWORDS) {
            const btn = page.locator(`button:has-text("${kw}")`);
            if (await btn.first().isVisible({timeout: 1200}).catch(() => false)) {
                await btn.first().click();
                clicked = true;
                log(`[密码] 点击: ${kw}`);
                await page.waitForTimeout(5000);
                break;
            }
        }
    }
    if (!clicked) {
        await page.keyboard.press("Enter").catch(() => {});
        await page.waitForTimeout(5000);
    }

    const looksChanged = (raw) => {
        const t = String(raw || "");
        if (SUCCESS_KEYWORDS.some((kw) => t.toLowerCase().includes(kw.toLowerCase()))) return true;
        if (/password changed|we keep your account protected/i.test(t)) return true;
        return false;
    };
    let text = await page.innerText("body");
    let verified = looksChanged(text);
    if (!verified) {
        await page.waitForTimeout(4000);
        text = await page.innerText("body");
        verified = looksChanged(text);
    }
    if (!verified) {
        const started = page.getByRole("button", {name: /get started|开始|empezar|começar/i}).first();
        if (await started.isVisible({timeout: 1500}).catch(() => false)) verified = true;
    }
    if (!verified) {
        log("[密码] 未见改密成功文案，不保存新密码");
        await dumpPage(page, "pwd_unverified", log, email);
        const afterDump = String(await page.innerText("body").catch(() => ""));
        if (looksChanged(afterDump)) {
            log("[密码] 截图后补到成功文案，按已改密处理");
            verified = true;
            text = afterDump;
        } else {
            // 已经点过 Change password，Google 可能已生效。空 newPassword 会让上层继续用旧密。
            log("[密码] 未见成功文案，仍先保存已提交的新密码");
            return {ok: true, newPassword: np, verified: false, detail: String(text).slice(0, 200)};
        }
    }
    log("[密码] 密码修改成功");

    for (const t of ["OK", "知道了", "Got it", "Mulai", "始める", "开始", "Start", "Get started"]) {
        const btn = page.locator(`button:has-text("${t}")`);
        if (await btn.first().isVisible({timeout: 1000}).catch(() => false)) {
            await btn.first().click();
            break;
        }
    }

    // 原仓库提交后即返回新密码；verified 仅作文案确认
    return {ok: true, newPassword: np, verified, detail: String(text).slice(0, 200)};
}

const STORE_HREF_RE = /play\.google|apps\.apple|itunes\.apple|support\.google|policies\.google|\/TOS|privacy/i;

function hrefLooksAuthAction(href) {
    const h = String(href || "");
    if (!h || STORE_HREF_RE.test(h)) return false;
    return /authenticator|totp|enroll|twosv|two-step-verification/i.test(h);
}

async function clickVisibleHref(page, pred, log, tag) {
    const links = page.locator("a[href], [role='link'][href]");
    const n = await links.count().catch(() => 0);
    for (let i = 0; i < n; i++) {
        const a = links.nth(i);
        if (!await a.isVisible({timeout: 150}).catch(() => false)) continue;
        const href = String(await a.getAttribute("href").catch(() => "") || "");
        if (!pred(href)) continue;
        await a.scrollIntoViewIfNeeded().catch(() => {});
        await a.click({force: true}).catch(() => a.click());
        if (log) log(`[2FA] ${tag} href=${href.slice(0, 90)}`);
        return true;
    }
    return false;
}

async function onAuthenticatorDetail(page) {
    if (/\/authenticator/i.test(page.url())) return true;
    return page.evaluate(() => {
        const bad = /play\.google|apps\.apple|support\.google|policies\.google|\/TOS|privacy/i;
        const vis = (el) => {
            if (!el || !el.getClientRects().length) return false;
            const r = el.getBoundingClientRect();
            return r.width > 6 && r.height > 6;
        };
        for (const card of document.querySelectorAll("article, li, [role='listitem'], [role='region'], section, div")) {
            if ((card.innerText || "").length > 2200) continue;
            const as = [...card.querySelectorAll("a")].filter((a) => vis(a) && !bad.test(a.href || ""));
            const btns = [...card.querySelectorAll("button, [role='button']")].filter(vis);
            if (as.length === 1 && btns.some((b) => ((b.textContent || "").trim().length <= 2))) return true;
        }
        return false;
    }).catch(() => false);
}

/** 不看文案：卡片里「一条业务链接 + 一个垃圾桶」就是改验证器。 */
async function clickAuthenticatorChangeByDom(page, log) {
    if (await clickVisibleHref(page, (h) => hrefLooksAuthAction(h) && /authenticator|totp|enroll/i.test(h) && !/\/two-step-verification\/?(\?|$)/i.test(h), log, "点结构链接")) {
        return true;
    }
    const href = await page.evaluate(() => {
        const bad = /play\.google|apps\.apple|support\.google|policies\.google|\/TOS|privacy/i;
        const vis = (el) => {
            if (!el || !el.getClientRects().length) return false;
            const r = el.getBoundingClientRect();
            return r.width > 8 && r.height > 8;
        };
        const isTrash = (el) => {
            const t = (el.textContent || "").replace(/\s+/g, "").trim();
            const al = `${el.getAttribute("aria-label") || ""} ${el.getAttribute("data-tooltip") || ""}`;
            if (/delete|remove|trash|sil|hapus|excluir|löschen|supprimer|eliminar|kaldır|eemalda|usuń|删除|移除/i.test(al)) return true;
            return t.length <= 2 && !!(el.querySelector("svg, img, i"));
        };
        for (const card of document.querySelectorAll("article, li, [role='listitem'], [role='region'], section, div")) {
            if ((card.innerText || "").length > 2200) continue;
            const links = [...card.querySelectorAll("a, [role='link']")].filter((el) => vis(el) && !bad.test(el.href || el.getAttribute("href") || ""));
            const trash = [...card.querySelectorAll("button, [role='button']")].filter((el) => vis(el) && isTrash(el));
            if (!trash.length || !links.length) continue;
            const action = links.find((el) => !isTrash(el));
            if (!action) continue;
            action.setAttribute("data-cm-2fa", "1");
            return action.getAttribute("href") || action.textContent.trim().slice(0, 40);
        }
        return "";
    }).catch(() => "");
    if (!href) return false;
    const marked = page.locator("[data-cm-2fa='1']").first();
    if (await marked.isVisible({timeout: 800}).catch(() => false)) {
        await marked.click({force: true}).catch(() => marked.click());
        log(`[2FA] 点卡片操作链 ${String(href).slice(0, 60)}`);
        return true;
    }
    return false;
}

async function openAuthenticatorDetail(page, log) {
    if (await onAuthenticatorDetail(page)) return true;
    if (await clickVisibleHref(page, (h) => /\/authenticator/i.test(h) && !STORE_HREF_RE.test(h), log, "点开 Authenticator 行")) {
        /* opened */
    } else {
        try {
            await page.goto("https://myaccount.google.com/two-step-verification/authenticator?hl=en", {waitUntil: "domcontentloaded", timeout: 30000});
            log("[2FA] 直达 authenticator 页");
        } catch { /* ignore */ }
    }
    for (let i = 0; i < 16; i++) {
        await page.waitForTimeout(400);
        if (await onAuthenticatorDetail(page)) return true;
    }
    return false;
}

/** 在已打开的 page 上添加 / 替换 TOTP（对应原 change_2fa）。 */
export async function change2faOnPage(page, {
    email, password, totpSecret = "", recoveryEmail = "", log = () => {},
} = {}) {
    log("[2FA] 开始修改 TOTP");

    const ok = await ensureGoogleLoggedIn(
        page, TWO_STEP_URL,
        {email, password, totpSecret, recoveryEmail, requireInbox: false},
        log,
    );
    if (!ok) {
        log("[2FA] 登录失败");
        return {ok: false, error: "Google 登录失败"};
    }
    try { await page.goto(TWO_STEP_URL, {waitUntil: "domcontentloaded", timeout: 30000}); } catch { /* ignore */ }
    await page.waitForTimeout(1500);
    await preferEnglishGoogleUi(page, log, TWO_STEP_URL);

    await googleReauthPassword(page, {password, totpSecret, log});
    for (let i = 0; i < 6; i++) {
        const t = String(await page.innerText("body").catch(() => ""));
        if (!isVerifyItsYouText(t)) break;
        await googleReauthPassword(page, {password, totpSecret, log});
        await page.waitForTimeout(2500);
    }
    await page.waitForTimeout(2000);
    const afterReauth = String(await page.innerText("body").catch(() => ""));
    if (isVerifyItsYouText(afterReauth)) {
        log("[2FA] 二次验证未过，仍在 Verify it's you");
        await dumpPage(page, "2fa_still_verify", log, email);
        return {ok: false, error: "二次验证未过"};
    }

    const AUTH_PATTERNS = ["uthenticat", "utenticador", "uthentifizierung"];
    const contentLower = String(await page.innerText("body")).toLowerCase();
    const onVerify = isVerifyItsYouText(contentLower);
    let foundAuth = !onVerify && (
        /\/authenticator/i.test(page.url())
        || await page.locator('a[href*="authenticator"]').first().isVisible({timeout: 400}).catch(() => false)
        || CHANGE_KEYWORDS.some((kw) => contentLower.includes(kw.toLowerCase()))
    );

    if (!foundAuth && !onVerify) {
        if (await clickVisibleHref(page, (h) => /authenticator/i.test(h) && !STORE_HREF_RE.test(h), log, "总览点 authenticator")) {
            foundAuth = true;
        }
    }

    if (!foundAuth && !onVerify) {
        for (let scroll = 0; scroll < 6; scroll++) {
            if (isVerifyItsYouText(String(await page.innerText("body").catch(() => "")))) break;
            const clickIdx = await page.evaluate((patterns) => {
                const links = document.querySelectorAll('a, [role="link"], li');
                for (let i = 0; i < links.length; i++) {
                    const el = links[i];
                    if (!el.offsetParent) continue;
                    const text = (el.textContent || "").toLowerCase();
                    if (!patterns.some((p) => text.includes(p))) continue;
                    if ((el.textContent || "").length > 200) continue;
                    if (el.tagName === "H1" || el.tagName === "H2") continue;
                    if (el.closest("h1, h2, h3")) continue;
                    return i;
                }
                return -1;
            }, AUTH_PATTERNS);
            if (clickIdx >= 0) {
                const target = page.locator('a, [role="link"], li').nth(clickIdx);
                if (await target.isVisible({timeout: 1500}).catch(() => false)) {
                    await target.click();
                    foundAuth = true;
                    break;
                }
            }
            await page.mouse.wheel(0, 300);
            await page.waitForTimeout(1000);
        }
    }

    if (!foundAuth) {
        log("[2FA] 未找到 Authenticator 入口");
        await dumpPage(page, "2fa_no_auth_entry", log, email);
        return {ok: false, error: "未找到 Authenticator 入口"};
    }

    const opened = await openAuthenticatorDetail(page, log);
    if (!opened) {
        log("[2FA] 点了 Authenticator 但还在总览页");
        await dumpPage(page, "2fa_no_action_btn", log, email);
        return {ok: false, error: "未进入 Authenticator 详情页"};
    }
    log("[2FA] 进入 Authenticator 页面");

    let clickedAction = await clickAuthenticatorChangeByDom(page, log);
    if (!clickedAction) {
        clickedAction = await clickText(page, CHANGE_KEYWORDS.concat(SETUP_KEYWORDS), 2000);
        if (clickedAction) log("[2FA] 文案兜底点到了更改");
    }

    if (!clickedAction) {
        log("[2FA] 未找到更改/设置按钮");
        await dumpPage(page, "2fa_no_action_btn", log, email);
        return {ok: false, error: "未找到更改/设置按钮"};
    }
    await page.waitForTimeout(5000);

    let cantClicked = false;
    for (const dialogSel of ['[role="dialog"]', '[role="alertdialog"]', '[class*="dialog"]', '[class*="Dialog"]', '[class*="modal"]']) {
        const dialog = page.locator(dialogSel);
        if (await dialog.first().isVisible({timeout: 1500}).catch(() => false)) {
            const dialogLinks = dialog.locator("a");
            if (await dialogLinks.count() > 0) {
                await dialogLinks.first().click();
                cantClicked = true;
                log("[2FA] 点击 dialog 内链接（无法扫描）");
                break;
            }
        }
    }

    if (!cantClicked) {
        const qrNearby = await page.evaluate(() => {
            const imgs = document.querySelectorAll("img, canvas, svg");
            for (const img of imgs) {
                const rect = img.getBoundingClientRect();
                if (rect.width > 80 && rect.width < 400 && Math.abs(rect.width - rect.height) < 20) {
                    let parent = img.parentElement;
                    for (let i = 0; i < 5 && parent; i++) {
                        const links = parent.querySelectorAll("a");
                        for (const a of links) {
                            if (a.offsetParent && a.textContent.trim().length > 3) {
                                return a.textContent.trim();
                            }
                        }
                        parent = parent.parentElement;
                    }
                }
            }
            return null;
        });
        if (qrNearby) {
            const target = page.locator(`text="${qrNearby}"`).first();
            if (await target.isVisible({timeout: 2000}).catch(() => false)) {
                await target.click();
                cantClicked = true;
                log(`[2FA] 点击 QR 附近链接: ${String(qrNearby).slice(0, 30)}`);
            }
        }
    }

    if (!cantClicked) {
        if (await clickText(page, CANT_SCAN_KEYWORDS, 3000)) {
            cantClicked = true;
            log("[2FA] 通过关键词点击无法扫描");
        }
    }

    if (!cantClicked) {
        log("[2FA] 未找到无法扫描按钮");
        await dumpPage(page, "2fa_no_cant_scan", log, email);
        return {ok: false, error: "未找到无法扫描按钮"};
    }
    await page.waitForTimeout(3000);

    const bodyText = await page.innerText("body");
    const newSecret = extractTotpSecret(bodyText);
    if (!newSecret) {
        log("[2FA] 未能提取 secret");
        await dumpPage(page, "2fa_no_secret", log, email);
        return {ok: false, error: "未能提取 TOTP secret"};
    }
    log(`[2FA] 新 TOTP secret: ${newSecret}`);

    const codeAlreadyVisible = await page.locator(
        'input[placeholder*="code" i], input[name="totpPin"], input[type="tel"], input[autocomplete="one-time-code"]',
    ).first().isVisible({timeout: 800}).catch(() => false);
    if (!codeAlreadyVisible) {
        await clickVisibleButton(page, NEXT_KEYWORDS);
        await page.waitForTimeout(2500);
    }

    let verified = false;
    const WRONG_RE = /wrong code|incorrect code|c[oó]digo (incorrecto|errado)|code incorrect|验证码有误/i;
    for (let attempt = 1; attempt <= 3; attempt++) {
        // 经跳板 Verify 要 8–12s，窗口剩 8s 再填会在提交途中过期。
        await waitTotpSafeWindow(16);
        const code = generateTotp(newSecret);
        const dialog = page.locator('[role="dialog"], [role="alertdialog"]').first();
        const scoped = (await dialog.isVisible({timeout: 400}).catch(() => false)) ? dialog : page;
        const codeInput = scoped.locator(
            'input[name="totpPin"], input[autocomplete="one-time-code"], input[type="tel"], '
            + 'input[name*="code" i], input[name*="pin" i], input[aria-label*="code" i]',
        );
        let foundInput = null;
        const inputCount = await codeInput.count();
        for (let i = 0; i < inputCount; i++) {
            const inp = codeInput.nth(i);
            if (await inp.isVisible({timeout: 500}).catch(() => false)) {
                const atype = (await inp.getAttribute("autocomplete")) || "";
                if (!String(atype).includes("search")) {
                    foundInput = inp;
                    break;
                }
            }
        }
        if (!foundInput) {
            const via = await submitGoogleTotp(page, newSecret, (m) => log(`[2FA] ${m}`), attempt);
            if (via === "missing") break;
            verified = via !== "wrong";
            if (verified) break;
            log("[2FA] Wrong code，等下一窗再验证");
            await waitNextTotpWindow();
            continue;
        }
        await foundInput.click({force: true}).catch(() => {});
        await foundInput.press("Meta+A").catch(() => {});
        await foundInput.press("Control+A").catch(() => {});
        await foundInput.press("Backspace").catch(() => {});
        await foundInput.pressSequentially(code, {delay: 80}).catch(async () => {
            await foundInput.fill(code);
        });
        log(`[2FA] 验证码已逐位输入(${attempt}): ${code}`);
        // Google 满 6 位常自动提交。立刻再点 Verify 会把同一码再送一次 → Wrong code。
        let after = "";
        let autoDone = false;
        for (let w = 0; w < 10; w++) {
            await page.waitForTimeout(500);
            after = String(await page.innerText("body").catch(() => ""));
            if (WRONG_RE.test(after)) break;
            const stillDialog = await page.getByText(/change authenticator|enter the 6-digit|输入.*6.*位/i).first().isVisible({timeout: 200}).catch(() => false);
            if (!stillDialog) { autoDone = true; break; }
        }
        if (WRONG_RE.test(after)) {
            log("[2FA] Google 报 Wrong code，等下一窗再填（不连点 Verify）");
            await waitNextTotpWindow();
            continue;
        }
        if (!autoDone) {
            await clickVisibleButton(page, VERIFY_KEYWORDS);
            await page.waitForTimeout(3500);
            after = String(await page.innerText("body").catch(() => ""));
        }
        if (WRONG_RE.test(after)) {
            log("[2FA] Google 报 Wrong code，等下一窗再填");
            await waitNextTotpWindow();
            continue;
        }
        verified = true;
        break;
    }
    if (!verified) {
        log("[2FA] 未找到验证码输入框或多次 Wrong code");
        await dumpPage(page, "2fa_no_code_input", log, email);
        return {ok: false, error: "未找到验证码输入框或 Wrong code"};
    }

    const resultText = await page.innerText("body");
    const successMarkers = [
        "telah diubah", "baru saja", "berhasil", "foi alterado", "adicionado agora",
        "Done", "完成", "Updated", "已更新", "Verified", "changed", "successfully",
        "ha sido cambiado", "a été modifié", "na-update",
    ];
    if (successMarkers.some((m) => String(resultText).toLowerCase().includes(m.toLowerCase()))) {
        log("[2FA] TOTP 修改成功!");
    } else {
        log("[2FA] TOTP 修改已提交");
    }

    return {ok: true, totpSecret: newSecret};
}

export async function changeGooglePassword(email, oldPassword, newPassword, {
    totpSecret = "", recoveryEmail = "", log = () => {},
} = {}) {
    return withGooglePage((page) => changePasswordOnPage(page, {
        email, password: oldPassword, totpSecret, recoveryEmail, newPassword, log,
    }));
}

export async function changeGoogleTotp(email, password, {
    totpSecret = "", recoveryEmail = "", log = () => {},
} = {}) {
    return withGooglePage((page) => change2faOnPage(page, {
        email, password, totpSecret, recoveryEmail, log,
    }));
}
