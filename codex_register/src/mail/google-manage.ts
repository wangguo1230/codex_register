// @ts-nocheck
/**
 * Google 账号改密 / 换 TOTP（Playwright 网页版）
 * 完整移植自 google-automation/web/backend/web_tasks/{change_pwd,change_2fa}.py
 */
import {randomBytes} from "node:crypto";
import {mkdirSync} from "node:fs";
import path from "node:path";
import {generateTotp, totpRemainSec, waitNextTotpWindow, waitTotpSafeWindow} from "../mfa.js";
import {ensureGoogleLoggedIn, googleReauthPassword, isVerifyItsYouText, submitGoogleTotp, bounceOffSslOrSid, preferEnglishGoogleUi, recoverSslOrSlowPage, googleSslDead} from "./google-auth.js";
import {launchGoogleBrowser} from "./google-account.js";

const PASSWORD_URL = "https://myaccount.google.com/signinoptions/password?hl=en";
const TWO_STEP_URL = "https://myaccount.google.com/signinoptions/two-step-verification?hl=en";
const AUTHENTICATOR_URL = "https://myaccount.google.com/two-step-verification/authenticator?hl=en";

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
    email, password, totpSecret = "", recoveryEmail = "", newPassword = "", log = () => {}, onPersist,
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
    for (let i = 0; i < 4; i++) {
        const t = String(await page.innerText("body").catch(() => ""));
        if (!isVerifyItsYouText(t) && !/accounts\.google\.com\/(v3\/)?signin|challenge\/totp/i.test(page.url())) break;
        log("[密码] 改密前还在二次验证，再过一次");
        await googleReauthPassword(page, {password, totpSecret, log});
        await page.waitForTimeout(800);
    }

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
        if (/Wrong password|Enter your password|Forgot password|Verify it.?s you|To help keep your account secure/i.test(body)
            || isVerifyItsYouText(body)) {
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
        const {enterMailJobCritical} = await import("./mailbox-job-stop.js");
        const leaveCritical = enterMailJobCritical();
        try {
            await submit.click().catch(() => submit.click({force: true}));
            clicked = true;
            log("[密码] 点了表单提交按钮");
            await page.waitForTimeout(5000);
        } finally {
            leaveCritical();
        }
    }
    if (!clicked) {
        for (const kw of CHANGE_PWD_KEYWORDS) {
            const btn = page.locator(`button:has-text("${kw}")`);
            if (await btn.first().isVisible({timeout: 1200}).catch(() => false)) {
                const {enterMailJobCritical} = await import("./mailbox-job-stop.js");
                const leaveCritical = enterMailJobCritical();
                try {
                    await btn.first().click();
                    clicked = true;
                    log(`[密码] 点击: ${kw}`);
                    await page.waitForTimeout(5000);
                } finally {
                    leaveCritical();
                }
                break;
            }
        }
    }
    if (!clicked) {
        const {enterMailJobCritical} = await import("./mailbox-job-stop.js");
        const leaveCritical = enterMailJobCritical();
        try {
            await page.keyboard.press("Enter").catch(() => {});
            await page.waitForTimeout(5000);
        } finally {
            leaveCritical();
        }
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
            log("[密码] 未见成功文案，不覆盖库内密码（只留痕）");
            return {ok: false, newPassword: np, verified: false, submitted: true, detail: String(text).slice(0, 200)};
        }
    }
    log("[密码] 密码修改成功（已见成功文案）");
    if (typeof onPersist === "function" && np) {
        await onPersist(np).catch(() => {});
        log("[密码] 已验证，新密码落库");
    }

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

function sameAuthOverview(href, pageUrl) {
    try {
        const abs = new URL(href, pageUrl);
        const cur = new URL(pageUrl);
        const norm = (p) => String(p || "").replace(/\/+$/, "");
        if (norm(abs.pathname) === norm(cur.pathname)) return true;
        if (/\/two-step-verification\/authenticator\/?$/i.test(norm(abs.pathname))) return true;
    } catch { /* ignore */ }
    return false;
}

function hrefLooksAuthAction(href, pageUrl = "") {
    const h = String(href || "");
    if (!h || STORE_HREF_RE.test(h)) return false;
    if (sameAuthOverview(h, pageUrl)) return false;
    return /totp|enroll|change.?auth|signinoptions\/twosv/i.test(h);
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

function changeAuthenticatorBtn(page) {
    return page.locator("button").filter({
        hasText: /change authenticator app|set up authenticator app|更改身份验证|设置身份验证/i,
    }).first();
}

async function onAuthenticatorDetail(page) {
    if (await changeAuthenticatorBtn(page).isVisible({timeout: 250}).catch(() => false)) return true;
    const ready = page.getByRole("button", {name: /change authenticator|set up authenticator|更改身份验证|设置身份验证/i})
        .or(page.getByText(/^your authenticator$/i));
    return ready.first().isVisible({timeout: 250}).catch(() => false);
}

async function dismissAccountFlyout(page) {
    const close = page.locator('[aria-label="Close"], [aria-label="关闭"], [aria-label*="Close" i], [aria-label*="Cerrar" i]').first();
    if (await close.isVisible({timeout: 250}).catch(() => false)) {
        await close.click().catch(() => {});
        await page.waitForTimeout(300);
        return;
    }
    if (await page.getByText(/Manage your Google Account|管理您的 Google 账号/i).first().isVisible({timeout: 250}).catch(() => false)) {
        await page.keyboard.press("Escape").catch(() => {});
        await page.mouse.click(16, 180).catch(() => {});
    }
}

async function isAccountPickerDialog(page) {
    const dlg = page.locator('[role="dialog"], [role="alertdialog"]').first();
    if (!await dlg.isVisible({timeout: 150}).catch(() => false)) return false;
    const t = String(await dlg.innerText().catch(() => ""));
    return /Manage your Google Account|Add account|Sign out|管理您的 Google 账号|添加账号|退出账号/i.test(t);
}

function dialogLooksLikeChangeTotp(text) {
    const t = String(text || "");
    return /enter the 6-digit|enter code|输入.*6.*位|输入验证码/i.test(t)
        && /change authenticator|authenticator app|更改身份验证|验证器/i.test(t);
}

function dialogLooksLikeReplaceConfirm(text) {
    const t = String(text || "");
    if (/enter the 6-digit|enter code|输入.*6.*位|输入验证码/i.test(t)) return false;
    if (/can.?t scan|cannot scan|无法扫描|scan a qr|the qr code|loading/i.test(t)) return false;
    return /won.t be able to use your old|you will no longer|old authenticator|无法再使用|旧的身份验证|replace this authenticator/i.test(t)
        && !/scan a qr|qr code/i.test(t);
}

function dialogLooksLikeQrSetup(text) {
    const t = String(text || "");
    if (/enter the 6-digit|enter code|输入.*6.*位|输入验证码/i.test(t)) return false;
    return /can.?t scan|cannot scan|无法扫描|the qr code|scan a qr/i.test(t);
}

function dialogLooksLikeLoadingQr(text) {
    const t = String(text || "");
    return /\bloading\b/i.test(t)
        && /change authenticator|scan a qr|old authenticator|authenticator app/i.test(t);
}

async function findChangeTotpDialog(page) {
    const scopes = [page, ...page.frames().filter((f) => f !== page.mainFrame())];
    for (const scope of scopes) {
        const loc = scope.locator('[role="dialog"], [role="alertdialog"]');
        const n = await loc.count().catch(() => 0);
        for (let i = 0; i < n; i++) {
            const dlg = loc.nth(i);
            if (!await dlg.isVisible({timeout: 150}).catch(() => false)) continue;
            if (dialogLooksLikeChangeTotp(String(await dlg.innerText().catch(() => "")))) return dlg;
        }
        const enter = scope.getByText(/enter the 6-digit code you see in the app/i).first();
        if (await enter.isVisible({timeout: 150}).catch(() => false)) {
            const box = enter.locator("xpath=ancestor::*[@role='dialog' or @role='alertdialog'][1]");
            if (await box.isVisible({timeout: 150}).catch(() => false)) return box;
            return enter;
        }
    }
    return null;
}

async function findDialogCodeInput(dlg, page) {
    const lists = [
        page.getByLabel(/enter code|6-digit|验证码/i),
        page.getByPlaceholder(/enter code|code|验证码/i),
        dlg.getByRole("textbox"),
        page.getByRole("dialog").getByRole("textbox"),
        dlg.locator("input:visible"),
        page.locator('[role="dialog"] input:visible, [role="alertdialog"] input:visible'),
        dlg.locator(
            'input[name="totpPin"], input[autocomplete="one-time-code"], input[type="tel"], '
            + 'input[aria-label*="code" i], input[placeholder*="code" i], input[placeholder*="码" i], '
            + 'input[inputmode="numeric"], input[type="text"], input[type="number"]',
        ),
    ];
    for (const loc of lists) {
        const n = await loc.count().catch(() => 0);
        for (let i = 0; i < n; i++) {
            const el = loc.nth(i);
            if (!await el.isVisible({timeout: 200}).catch(() => false)) continue;
            const typ = String(await el.getAttribute("type").catch(() => "") || "").toLowerCase();
            if (typ === "hidden" || typ === "checkbox" || typ === "password" || typ === "email") continue;
            return el;
        }
    }
    const label = dlg.getByText(/enter code|enter the 6-digit|输入验证码/i).first();
    if (await label.isVisible({timeout: 250}).catch(() => false)) {
        const box = await label.boundingBox().catch(() => null);
        if (box) await page.mouse.click(box.x + box.width / 2, box.y + Math.min(box.height / 2 + 18, box.height - 4));
        const focused = page.locator("input:focus, [role='textbox']:focus").first();
        if (await focused.isVisible({timeout: 250}).catch(() => false)) return focused;
    }
    return null;
}

async function typeDialogTotp(el, page, code) {
    await el.scrollIntoViewIfNeeded().catch(() => {});
    await el.click({timeout: 2000}).catch(() => el.click({force: true}));
    await page.waitForTimeout(120);
    await el.fill("").catch(() => {});
    await el.pressSequentially(String(code), {delay: 35}).catch(() => {});
    let got = String(await el.inputValue().catch(() => "")).replace(/\s+/g, "");
    if (got === String(code)) return true;
    await el.click({force: true}).catch(() => {});
    await el.fill(String(code)).catch(() => {});
    got = String(await el.inputValue().catch(() => "")).replace(/\s+/g, "");
    if (got === String(code)) return true;
    return false;
}

/** 换验证器前要先用当前 TOTP 过一道。必须写进对话框可见输入框，空点 Verify 会停在这个框里。 */
async function fillChangeAuthenticatorCode(page, totpSecret, log) {
    const dlg = await findChangeTotpDialog(page);
    if (!dlg) return "missing";
    const secret = String(totpSecret || "").trim();
    if (!secret) {
        log("[2FA] 更换框要验证码，但没有当前密钥");
        return "missing";
    }
    const input = await findDialogCodeInput(dlg, page);
    if (!input) {
        const hint = await page.evaluate(() => [...document.querySelectorAll('[role="dialog"], [role="alertdialog"], [aria-modal="true"]')].map((d) => ({
            t: String(d.innerText || "").replace(/\s+/g, " ").slice(0, 90),
            inputs: d.querySelectorAll("input").length,
            types: [...d.querySelectorAll("input")].map((i) => i.type || i.getAttribute("inputmode") || "?"),
        })).slice(0, 4)).catch(() => []);
        log(`[2FA] 更换框里没找到可见输入框 ${JSON.stringify(hint)}`);
        return "missing";
    }
    const remain = totpRemainSec();
    if (remain < 6) {
        log(`[2FA] 窗口只剩 ${remain}s，等到下一窗再填`);
        await waitTotpSafeWindow(8);
    }
    const code = generateTotp(secret);
    if (!code) return "missing";
    const typed = await typeDialogTotp(input, page, code);
    const shown = String(await input.inputValue().catch(() => "")).replace(/\s+/g, "");
    if (!typed || shown !== String(code)) {
        log(`[2FA] 更换框没填上 目标=${code} 框内=${shown || "空"}（不点 Verify）`);
        return "missing";
    }
    log(`[2FA] 更换前验证码已填 ${code} 框内已确认 remain=${totpRemainSec()}s`);
    const WRONG_RE = /wrong code|incorrect code|c[oó]digo (incorrecto|errado)|code incorrect|验证码有误/i;
    const backOut = async () => {
        const back = dlg.getByRole("button", {name: /^(back|返回|上一步)$/i}).first();
        if (await back.isVisible({timeout: 300}).catch(() => false)) await back.click().catch(() => {});
        else await page.keyboard.press("Escape").catch(() => {});
    };
    for (let w = 0; w < 8; w++) {
        await page.waitForTimeout(350);
        const after = String(await page.innerText("body").catch(() => ""));
        if (WRONG_RE.test(after)) {
            log("[2FA] 更换前验证码 Wrong code（自动提交）");
            await backOut();
            return "wrong";
        }
        if (!await findChangeTotpDialog(page)) return "ok";
    }
    const still = String(await input.inputValue().catch(() => "")).replace(/\s+/g, "");
    if (still !== String(code)) {
        log(`[2FA] 点 Verify 前框又空了 框内=${still || "空"}`);
        return "missing";
    }
    if (WRONG_RE.test(String(await page.innerText("body").catch(() => "")))) {
        await backOut();
        return "wrong";
    }
    const verify = dlg.getByRole("button", {name: /^(verify|verif|验证|確認|确认)$/i}).first();
    if (await verify.isVisible({timeout: 400}).catch(() => false)) {
        await verify.click().catch(() => verify.click({force: true}));
        log("[2FA] 点了更换前 Verify");
    }
    await page.waitForTimeout(1500);
    const after = String(await page.innerText("body").catch(() => ""));
    if (WRONG_RE.test(after)) {
        log("[2FA] 更换前验证码 Wrong code");
        await backOut();
        return "wrong";
    }
    return await findChangeTotpDialog(page) ? "pending" : "ok";
}

async function waitAuthenticatorSetup(page, ms = 9000) {
    const deadline = Date.now() + ms;
    const cant = page.getByText(/can.?t scan it\??|cannot scan|无法扫描/i);
    const qr = page.locator("[role='dialog'] img, [role='alertdialog'] img, canvas, img[alt*='QR' i], img[src*='qr' i]");
    const secret = page.getByText(/secret key|setup key|密钥|otpauth:\/\//i);
    while (Date.now() < deadline) {
        if (await isAccountPickerDialog(page)) {
            await dismissAccountFlyout(page);
            await page.waitForTimeout(150);
            continue;
        }
        if (await cant.first().isVisible({timeout: 120}).catch(() => false)) return "secret";
        if (await qr.first().isVisible({timeout: 120}).catch(() => false)) return "qr";
        if (await secret.first().isVisible({timeout: 120}).catch(() => false)) return "secret";
        if (await findChangeTotpDialog(page)) return "reauth";
        const dlg = page.locator('[role="dialog"], [role="alertdialog"]').first();
        if (await dlg.isVisible({timeout: 80}).catch(() => false)) {
            const dt = String(await dlg.innerText().catch(() => ""));
            if (dialogLooksLikeLoadingQr(dt)) {
                await page.waitForTimeout(250);
                continue;
            }
            if (dialogLooksLikeQrSetup(dt)) return "qr";
            if (dialogLooksLikeReplaceConfirm(dt)) return "confirm";
        }
        await page.waitForTimeout(180);
    }
    return "";
}

async function clickDialogNext(page, log) {
    if (await findChangeTotpDialog(page)) return false;
    const loc = page.locator('[role="dialog"], [role="alertdialog"]');
    const n = await loc.count().catch(() => 0);
    let dlg = null;
    for (let i = 0; i < n; i++) {
        const cand = loc.nth(i);
        if (!await cand.isVisible({timeout: 150}).catch(() => false)) continue;
        const t = String(await cand.innerText().catch(() => ""));
        if (dialogLooksLikeChangeTotp(t)) continue;
        if (dialogLooksLikeReplaceConfirm(t) || !dlg) dlg = cand;
        if (dialogLooksLikeReplaceConfirm(t)) break;
    }
    if (!dlg) return false;
    const codeBox = dlg.locator('input[placeholder*="code" i], input[name="totpPin"], input[autocomplete="one-time-code"]').first();
    if (await codeBox.isVisible({timeout: 200}).catch(() => false)) return false;
    const names = await dlg.evaluate((el) => [...el.querySelectorAll("button, [role='button'], a")].filter((b) => b.getClientRects().length).map((b) => (b.textContent || "").replace(/\s+/g, " ").trim()).filter(Boolean).slice(0, 8)).catch(() => []);
    log(`[2FA] 确认框可见按钮 ${JSON.stringify(names)}`);
    await dlg.evaluate((el) => {
        el.scrollTop = el.scrollHeight;
        for (const n of el.querySelectorAll("*")) {
            if (n.scrollHeight - n.clientHeight > 20) n.scrollTop = n.scrollHeight;
        }
    }).catch(() => {});
    const nextBtn = dlg.getByRole("button", {name: "Next", exact: true})
        .or(dlg.getByRole("button", {name: /^(next|continue|下一步|继续)$/i}))
        .last();
    if (await nextBtn.isVisible({timeout: 400}).catch(() => false)) {
        await nextBtn.scrollIntoViewIfNeeded().catch(() => {});
        await nextBtn.focus().catch(() => {});
        await nextBtn.click({timeout: 2000}).catch(() => {});
        await page.keyboard.press("Enter").catch(() => {});
        log("[2FA] 点了确认框 Next + Enter");
        return true;
    }
    const nexts = dlg.getByRole("button", {name: /^(next|continue|下一步|继续)$/i});
    const nn = await nexts.count().catch(() => 0);
    for (let i = nn - 1; i >= 0; i--) {
        const btn = nexts.nth(i);
        if (!await btn.isVisible({timeout: 150}).catch(() => false)) continue;
        if (await btn.isDisabled().catch(() => false)) continue;
        await btn.click({timeout: 2000, force: true}).catch(() => {});
        log("[2FA] 点了确认框可见 Next");
        return true;
    }
    return false;
}

/** 不看文案：先关账号浮层，再点卡片里垃圾桶旁边那条业务链接。不要点当前页自己的 /authenticator。 */
async function clickAuthenticatorChangeByDom(page, log) {
    await dismissAccountFlyout(page);
    const pill = changeAuthenticatorBtn(page);
    if (await pill.isVisible({timeout: 400}).catch(() => false)) {
        await pill.scrollIntoViewIfNeeded().catch(() => {});
        await pill.click({timeout: 2000}).catch(() => pill.click({force: true, timeout: 1500}));
        log("[2FA] 点了 Change authenticator app 按钮");
        return true;
    }
    const namedBtn = page.getByRole("button", {name: /change authenticator|set up authenticator|更改身份验证|设置身份验证/i}).first();
    if (await namedBtn.isVisible({timeout: 350}).catch(() => false)) {
        await namedBtn.scrollIntoViewIfNeeded().catch(() => {});
        await namedBtn.click().catch(() => namedBtn.click({force: true}));
        log("[2FA] 点了 Change authenticator app 按钮");
        return true;
    }
    const named = page.getByRole("link", {name: /change authenticator|set up authenticator|更改身份验证|设置身份验证/i}).first();
    if (await named.isVisible({timeout: 500}).catch(() => false)) {
        await named.scrollIntoViewIfNeeded().catch(() => {});
        await named.click({force: true}).catch(() => named.click());
        log("[2FA] 点了 Change authenticator app");
        return true;
    }
    const marked = await page.evaluate(() => {
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
        document.querySelectorAll("[data-cm-2fa]").forEach((el) => el.removeAttribute("data-cm-2fa"));
        for (const card of document.querySelectorAll("article, li, [role='listitem'], [role='region'], section, div")) {
            if ((card.innerText || "").length > 2200) continue;
            const links = [...card.querySelectorAll("a, [role='link'], button, [role='button']")].filter((el) => vis(el) && !bad.test(el.href || el.getAttribute("href") || ""));
            const trash = [...card.querySelectorAll("button, [role='button']")].filter((el) => vis(el) && isTrash(el));
            if (!trash.length || !links.length) continue;
            const action = links.find((el) => !isTrash(el) && /change|set up|更改|设置|authenticator/i.test(`${el.textContent || ""} ${el.getAttribute("aria-label") || ""}`))
                || links.find((el) => !isTrash(el));
            if (!action) continue;
            action.setAttribute("data-cm-2fa", "1");
            return action.textContent.trim().slice(0, 50) || action.getAttribute("href") || "ok";
        }
        return "";
    }).catch(() => "");
    if (marked) {
        const loc = page.locator("[data-cm-2fa='1']").first();
        if (await loc.isVisible({timeout: 800}).catch(() => false)) {
            await loc.scrollIntoViewIfNeeded().catch(() => {});
            await loc.click({force: true}).catch(() => loc.click());
            log(`[2FA] 点卡片更改链 ${String(marked).slice(0, 50)}`);
            return true;
        }
    }
    const pageUrl = page.url();
    if (await clickVisibleHref(page, (h) => hrefLooksAuthAction(h, pageUrl), log, "点结构链接")) return true;
    return false;
}

async function clickCantScanByDom(page, log) {
    const dlg = page.locator('[role="dialog"], [role="alertdialog"]').first();
    const scope = await dlg.isVisible({timeout: 300}).catch(() => false) ? dlg : page;
    const candidates = [
        scope.getByRole("button", {name: /can.?t scan|cannot scan|无法扫描/i}),
        scope.locator("button").filter({hasText: /can.?t scan|无法扫描/i}),
        scope.locator('[jsname="Pr7Yme"]').filter({hasText: /can.?t scan|无法扫描/i}),
        scope.getByText(/can.?t scan it\??/i),
    ];
    for (const loc of candidates) {
        const el = loc.first();
        if (!await el.isVisible({timeout: 350}).catch(() => false)) continue;
        await el.scrollIntoViewIfNeeded().catch(() => {});
        await el.click({timeout: 2000}).catch(() => el.click({force: true, timeout: 1500}));
        log("[2FA] 点了 Can't scan it?");
        return true;
    }
    return false;
}

async function openAuthenticatorDetail(page, log) {
    if (await onAuthenticatorDetail(page)) return true;
    if (await isAccountPickerDialog(page)) {
        await dismissAccountFlyout(page);
        await page.keyboard.press("Escape").catch(() => {});
    }
    for (let attempt = 0; attempt < 3; attempt++) {
        if (await onAuthenticatorDetail(page)) return true;
        const already = /myaccount\.google\.com\/.*authenticator/i.test(page.url())
            && !/accounts\.google\.com/i.test(page.url());
        if (!already || attempt > 0) {
            try {
                await page.goto(AUTHENTICATOR_URL, {waitUntil: "domcontentloaded", timeout: 60000});
                log(attempt === 0 ? "[2FA] 直达 authenticator 页" : `[2FA] 再进 authenticator ${attempt + 1}/3`);
            } catch (e) {
                log(`[2FA] 打开 authenticator 超时: ${String(e?.message || e).slice(0, 70)}`);
            }
        }
        if (await googleSslDead(page)) {
            await recoverSslOrSlowPage(page, log, AUTHENTICATOR_URL, 2);
            if (await googleSslDead(page)) continue;
        }
        for (let i = 0; i < 20; i++) {
            if (await onAuthenticatorDetail(page)) return true;
            if (await googleSslDead(page)) break;
            if (/accounts\.google\.com\/(v3\/)?signin|challenge\/totp/i.test(page.url())) {
                log("[2FA] authenticator 页又要二次验证");
                return false;
            }
            await page.waitForTimeout(250);
        }
    }
    return false;
}

/** 在已打开的 page 上添加 / 替换 TOTP（对应原 change_2fa）。 */
export async function change2faOnPage(page, {
    email, password, totpSecret = "", recoveryEmail = "", log = () => {}, onPersist,
} = {}) {
    log("[2FA] 开始修改 TOTP");

    const alreadyIn = /myaccount\.google\.com/i.test(String(page.url()))
        && !/accounts\.google\.com/i.test(String(page.url()));
    if (!alreadyIn) {
        const ok = await ensureGoogleLoggedIn(
            page, AUTHENTICATOR_URL,
            {email, password, totpSecret, recoveryEmail, requireInbox: false},
            log,
        );
        if (!ok) {
            log("[2FA] 登录失败");
            return {ok: false, error: "Google 登录失败"};
        }
    }
    if (!await onAuthenticatorDetail(page)) {
        try { await page.goto(AUTHENTICATOR_URL, {waitUntil: "domcontentloaded", timeout: 60000}); } catch { /* ignore */ }
        if (await googleSslDead(page)) await recoverSslOrSlowPage(page, log, AUTHENTICATOR_URL, 3);
    }
    if (!await onAuthenticatorDetail(page)) {
        await preferEnglishGoogleUi(page, log, AUTHENTICATOR_URL);
        await googleReauthPassword(page, {password, totpSecret, log});
        for (let i = 0; i < 4; i++) {
            if (await onAuthenticatorDetail(page)) break;
            if (!/accounts\.google\.com\/(v3\/)?signin|challenge\/totp/i.test(page.url())
                && !isVerifyItsYouText(String(await page.locator("h1, h2, [role='heading']").first().innerText().catch(() => "")))) {
                break;
            }
            await googleReauthPassword(page, {password, totpSecret, log});
            await page.waitForTimeout(800);
        }
    }
    if (/accounts\.google\.com\/(v3\/)?signin|challenge\/totp/i.test(page.url())) {
        log("[2FA] 二次验证未过，仍在 Verify it's you");
        await dumpPage(page, "2fa_still_verify", log, email);
        return {ok: false, error: "二次验证未过"};
    }
    const {isMailboxJobStopped, enterMailJobCritical} = await import("./mailbox-job-stop.js");
    if (isMailboxJobStopped()) {
        log("[2FA] 已停止，尚未点更改");
        return {ok: false, error: "已停止"};
    }
    const leaveCritical = enterMailJobCritical();
    try {
    const AUTH_PATTERNS = ["uthenticat", "utenticador", "uthentifizierung"];
    const onVerify = /accounts\.google\.com\/(v3\/)?signin|challenge\/totp/i.test(page.url());
    let foundAuth = !onVerify && (
        await onAuthenticatorDetail(page)
        || /\/authenticator/i.test(page.url())
        || await page.locator('a[href*="authenticator"]').first().isVisible({timeout: 250}).catch(() => false)
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
        if (await googleSslDead(page)) {
            log("[2FA] 入口页被 SSL 掐了，刷新再进");
            await recoverSslOrSlowPage(page, log, AUTHENTICATOR_URL, 4);
            const again = String(await page.innerText("body").catch(() => "")).toLowerCase();
            foundAuth = !isVerifyItsYouText(again) && (
                /\/authenticator/i.test(page.url())
                || await page.locator('a[href*="authenticator"]').first().isVisible({timeout: 800}).catch(() => false)
                || CHANGE_KEYWORDS.some((kw) => again.includes(kw.toLowerCase()))
                || /authenticator app|change authenticator|your authenticator/i.test(again)
            );
        }
    }

    if (!foundAuth) {
        log("[2FA] 未找到 Authenticator 入口");
        await dumpPage(page, "2fa_no_auth_entry", log, email);
        return {ok: false, error: "未找到 Authenticator 入口"};
    }

    let opened = await openAuthenticatorDetail(page, log);
    if (!opened) {
        await googleReauthPassword(page, {password, totpSecret, log});
        opened = await openAuthenticatorDetail(page, log);
    }
    if (!opened) {
        log("[2FA] 点了 Authenticator 但还在总览页");
        await dumpPage(page, "2fa_no_action_btn", log, email);
        return {ok: false, error: "未进入 Authenticator 详情页"};
    }
    log("[2FA] 进入 Authenticator 页面");
    await dismissAccountFlyout(page);

    let setup = "";
    let clickedChange = false;
    for (let tryChange = 0; tryChange < 10 && !["qr", "secret"].includes(setup); tryChange++) {
        if (await isAccountPickerDialog(page)) await dismissAccountFlyout(page);
        if (await findChangeTotpDialog(page)) {
            const filled = await fillChangeAuthenticatorCode(page, totpSecret, log);
            if (filled === "wrong" || filled === "pending") {
                log("[2FA] 等下一窗换新码再填");
                await waitNextTotpWindow();
                continue;
            }
            if (filled !== "ok") {
                log("[2FA] 更换前验证码没填上");
                continue;
            }
            setup = await waitAuthenticatorSetup(page, 15000);
            continue;
        }
        const dlg = page.locator('[role="dialog"], [role="alertdialog"]').first();
        const dlgOpen = await dlg.isVisible({timeout: 200}).catch(() => false);
        const dlgText = dlgOpen ? String(await dlg.innerText().catch(() => "")) : "";
        const qrVisible = await page.locator(
            "[role='dialog'] img, [role='alertdialog'] img, img[alt*='QR' i], img[src*='qr' i], [role='dialog'] canvas",
        ).first().isVisible({timeout: 200}).catch(() => false);
        if (dialogLooksLikeLoadingQr(dlgText) || (dlgOpen && /loading/i.test(dlgText))) {
            if (tryChange === 0 || tryChange === 3) log("[2FA] 确认框还在出 QR，继续等");
            setup = await waitAuthenticatorSetup(page, 15000);
            continue;
        }
        if (dialogLooksLikeQrSetup(dlgText) || qrVisible || /can.?t scan|cannot scan|无法扫描/i.test(dlgText)) {
            log("[2FA] 确认框已出 QR，点 Can't scan it?");
            if (await clickCantScanByDom(page, log)) {
                setup = await waitAuthenticatorSetup(page, 8000);
                if (!setup) setup = "secret";
            } else {
                log("[2FA] Can't scan 还没出来，再等");
                setup = await waitAuthenticatorSetup(page, 12000);
            }
            continue;
        }
        if (dialogLooksLikeReplaceConfirm(dlgText)) {
            const hit = await clickDialogNext(page, log);
            log(hit ? "[2FA] 确认框已点 Next，等填码/QR" : "[2FA] 确认框 Next 没点到");
            setup = await waitAuthenticatorSetup(page, 8000);
            continue;
        }
        if (dlgOpen) {
            setup = await waitAuthenticatorSetup(page, 12000);
            continue;
        }
        if (!clickedChange || tryChange >= 5) {
            let clickedAction = await clickAuthenticatorChangeByDom(page, log);
            if (!clickedAction) {
                const named = page.getByRole("button", {name: /change authenticator app/i})
                    .or(page.getByRole("link", {name: /change authenticator app/i}))
                    .or(page.getByText(/^change authenticator app$/i));
                if (await named.first().isVisible({timeout: 600}).catch(() => false)) {
                    await named.first().click().catch(() => named.first().click({force: true}));
                    clickedAction = true;
                    log("[2FA] 点了 Change authenticator app 文案");
                }
            }
            if (!clickedAction) break;
            clickedChange = true;
            setup = await waitAuthenticatorSetup(page, 25000);
            continue;
        }
        setup = await waitAuthenticatorSetup(page, 8000);
    }

    if (!setup && await findChangeTotpDialog(page)) {
        const filled = await fillChangeAuthenticatorCode(page, totpSecret, log);
        if (filled === "ok") setup = await waitAuthenticatorSetup(page, 9000);
    }
    if (!["qr", "secret"].includes(setup) && !await findChangeTotpDialog(page)) {
        log("[2FA] 确认后没有出现填码框或密钥");
        await dumpPage(page, "2fa_no_setup_after_confirm", log, email);
        return {ok: false, error: "确认后没有出现填码框或密钥"};
    }

    let cantClicked = setup === "secret";
    const canSeeCantScan = await page.getByText(/can.?t scan|cannot scan|无法扫描/i).first().isVisible({timeout: 500}).catch(() => false);
    if (!cantClicked && (setup === "qr" || setup === "dialog" || canSeeCantScan)) {
        if (canSeeCantScan && await clickCantScanByDom(page, log)) cantClicked = true;
    }
    if (!cantClicked) {
        const qrNearby = await page.evaluate(() => {
            const bad = /play\.google|apps\.apple|support\.google/i;
            const imgs = document.querySelectorAll("img, canvas, svg");
            for (const img of imgs) {
                const rect = img.getBoundingClientRect();
                if (rect.width > 80 && rect.width < 400 && Math.abs(rect.width - rect.height) < 20) {
                    let parent = img.parentElement;
                    for (let i = 0; i < 5 && parent; i++) {
                        const links = parent.querySelectorAll("a");
                        for (const a of links) {
                            if (!a.getClientRects().length) continue;
                            if (bad.test(a.href || "")) continue;
                            if ((a.textContent || "").trim().length > 3) {
                                a.setAttribute("data-cm-scan", "1");
                                return true;
                            }
                        }
                        parent = parent.parentElement;
                    }
                }
            }
            return false;
        }).catch(() => false);
        if (qrNearby) {
            const target = page.locator("[data-cm-scan='1']").first();
            if (await target.isVisible({timeout: 1500}).catch(() => false)) {
                await target.click({force: true}).catch(() => target.click());
                cantClicked = true;
                log("[2FA] 点了 QR 旁链接");
            }
        }
    }
    if (!cantClicked && canSeeCantScan && await clickCantScanByDom(page, log)) cantClicked = true;
    if (!cantClicked) {
        log("[2FA] Can't scan 还没出现，再等 QR 加载");
        setup = await waitAuthenticatorSetup(page, 20000);
        if (["qr", "secret"].includes(setup) && await clickCantScanByDom(page, log)) cantClicked = true;
    }

    if (!cantClicked && !/otpauth:\/\//i.test(String(await page.innerText("body").catch(() => "")))) {
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
        if (totpRemainSec() < 6) await waitTotpSafeWindow(8);
        const code = generateTotp(newSecret);
        const dialog = await findChangeTotpDialog(page) || page.locator('[role="dialog"], [role="alertdialog"]').filter({hasText: /code|验证码/i}).first();
        const foundInput = await findDialogCodeInput(dialog, page);
        if (!foundInput) {
            const via = await submitGoogleTotp(page, newSecret, (m) => log(`[2FA] ${m}`), attempt);
            if (via === "missing") break;
            verified = via !== "wrong";
            if (verified) break;
            log("[2FA] Wrong code，等下一窗再验证");
            await waitNextTotpWindow();
            continue;
        }
        const typed = await typeDialogTotp(foundInput, page, code);
        const shown = String(await foundInput.inputValue().catch(() => "")).replace(/\s+/g, "");
        if (!typed || shown !== String(code)) {
            log(`[2FA] 新密钥验证码没填上 目标=${code} 框内=${shown || "空"}`);
            await waitNextTotpWindow();
            continue;
        }
        log(`[2FA] 验证码已逐位输入(${attempt}): ${code} 框内已确认`);
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
    if (typeof onPersist === "function" && newSecret) {
        await onPersist({totpSecret: newSecret}).catch(() => {});
        log("[2FA] 新密钥已先落库");
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
    } finally {
        leaveCritical();
    }
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
