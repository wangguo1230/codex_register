// @ts-nocheck
/**
 * Google 账号网页版登录辅助（Playwright）
 * 完整移植自 google-automation/web/backend/web_tasks/google_auth.py
 *
 * 处理全部认证步骤和边界情况：
 * - 邮箱 / 密码 / TOTP / 辅助邮箱
 * - 错误检测（密码错误 / 账号禁用 / TOTP 失败 / 异常活动）
 * - selfie / video 验证跳过
 * - 页面 loading 等待
 * - 密码 + TOTP 二次验证（敏感操作前）
 */
import {generateTotp, generateTotpCandidates, waitNextTotpWindow, waitTotpSafeWindow, straightenGoogleCreds} from "../mfa.js";

const SKIP_TEXTS = [
    "Lain kali", "Not now", "Maybe later", "以后再说", "Agora não", "Plus tard",
    "Ahora no", "Huwag muna",
    "Skip", "跳过", "Lewati", "Pular", "Sauter", "Omitir", "Laktawan",
    "I agree", "我同意", "Accept", "接受", "Aceitar", "Accepter", "Aceptar",
    "Got it", "知道了", "Continue", "继续", "Continuar",
];

const ERROR_MARKERS = [
    "Wrong password", "Senha incorreta", "Kata sandi salah", "密码错误",
    "Mot de passe incorrect", "Contraseña incorrecta", "Maling password",
    "Couldn't find your Google Account", "找不到您的 Google 帐号",
    "Não foi possível encontrar", "Akun Google tidak ditemukan",
    "This account has been disabled", "此帐号已被停用",
    "Esta conta foi desativada", "Akun ini telah dinonaktifkan",
    "Couldn't sign you in", "无法让您登录",
    "Too many failed attempts", "尝试次数过多",
    "This account cannot be accessed", "Tidak dapat mengakses akun ini",
    "account has been locked", "conta foi bloqueada",
];

// 这些是额外验证页，不是登录失败。原逻辑把文案当 fatal，TOTP 后立刻中止。
const CHALLENGE_MARKERS = [
    "verify it's you", "verificar que é você", "verificar que eres tú",
    "verifica que eres tú", "verifica que eres tu",
    "Unusual activity", "Atividade incomum", "Aktivitas tidak biasa",
    "actividad inusual", "activité inhabituelle",
];

const VERIFY_YOU_RE = /verify (that )?it.?s you|first verify that|verifica(?:r)? que eres t[uú]|verificar que [eé]s voc[eê]|v[eé]rifiez que c.?est (bien )?vous|確認是你|确认是你|ini benar-benar kamu/i;
const IMAGE_CAPTCHA_RE = /type the text you (hear or )?see|enter the characters you see|characters you see in the image|digite o texto que|escribe el texto/i;
const TOTP_PLACEHOLDER_RE = /enter( the)? code|ingresar el c[oó]digo|introduc(?:ir|e)(?: el)? c[oó]digo|c[oó]digo|验证码|kod(?:e|igo)?/i;
const WRONG_TOTP_RE = /wrong code|incorrect code|that code didn.?t work|c[oó]digo (incorrecto|errado|inv[aá]lido)|code incorrect|kode salah|验证码有误|代码不正确|代码有误|wrong pin/i;

export function isVerifyItsYouText(text) {
    return VERIFY_YOU_RE.test(String(text || ""));
}

const ACK_TEXTS = [
    "Yes, it was me", "This was me", "It was me", "I understand",
    "是我", "是我本人", "我知道了", "知道了",
    "Fui eu", "Era yo", "C'était moi", "Saya sendiri",
];

async function safeClick(page, selector, timeout = 3000) {
    try {
        const loc = page.locator(selector).first();
        if (await loc.isVisible({timeout})) {
            await loc.click();
            return true;
        }
    } catch {
        /* ignore */
    }
    return false;
}

async function typeGoogleInput(loc, value, {selectAll = false} = {}) {
    // 跟人一样：点进输入框、打字，不要 blur。Material Next 靠焦点和 input 事件亮起来。
    await loc.click({timeout: 2500}).catch(async () => {
        await loc.click({force: true, timeout: 1500});
    });
    const cur = String(await loc.inputValue().catch(() => ""));
    if (cur === String(value)) return;
    // 密码框不要 fill("")：Google 会立刻校验空值，后续输入来不及，页面就报 Enter a password。
    if (selectAll) {
        await loc.press("Control+A").catch(() => {});
        await loc.press("Backspace").catch(() => {});
    } else {
        await loc.fill("").catch(() => {});
    }
    await loc.pressSequentially(String(value), {delay: 28}).catch(async () => {
        await loc.fill(value);
    });
}

const PASSWORD_BOX_SEL = [
    'input[name="Passwd"]',
    'input[autocomplete="current-password"]',
    '#password input',
    'input[type="password"]',
    'input[aria-label*="password" i]',
    'input[aria-label*="contrase" i]',
    'input[aria-label*="senha" i]',
    'input[aria-label*="sandi" i]',
    'input[aria-label*="密码"]',
].join(", ");

/** 真正给人看的那个密码框。隐藏/1px 的 Passwd 也能被 :visible 命中，填进去 Google 当没填。 */
async function findLoginPasswordBox(page, {allowSmall = false} = {}) {
    const boxes = page.locator(PASSWORD_BOX_SEL);
    const n = await boxes.count().catch(() => 0);
    let best = null;
    let bestW = 0;
    let fallback = null;
    for (let i = 0; i < n; i++) {
        const el = boxes.nth(i);
        const ac = String(await el.getAttribute("autocomplete").catch(() => "") || "");
        if (/new-password/i.test(ac)) continue;
        const typ = String(await el.getAttribute("type").catch(() => "") || "").toLowerCase();
        if (typ === "hidden") continue;
        const box = await el.boundingBox().catch(() => null);
        if (!box) continue;
        if (!fallback) fallback = el;
        const visible = await el.isVisible({timeout: 150}).catch(() => false);
        if (!visible && !allowSmall) continue;
        if (!allowSmall && (box.width < 40 || box.height < 8)) continue;
        if (box.width > bestW) {
            best = el;
            bestW = box.width;
        }
    }
    return best || (allowSmall ? fallback : null);
}

async function dumpPasswordInputs(page, write) {
    const rows = await page.evaluate(() => [...document.querySelectorAll("input")].slice(0, 12).map((el) => {
        const r = el.getBoundingClientRect();
        return `${el.type || "?"} name=${el.name || ""} ac=${el.autocomplete || ""} aria=${(el.getAttribute("aria-label") || "").slice(0, 24)} ${Math.round(r.width)}x${Math.round(r.height)}`;
    })).catch(() => []);
    write(`  密码页输入框: ${rows.join(" | ") || "无"}`);
}

async function primePasswordField(page) {
    const hits = [
        page.locator("#password").first(),
        page.locator('input[name="Passwd"]').first(),
        page.getByLabel(/password|contrase|senha|sandi|密码/i).first(),
        page.getByText(/enter (your )?password|ingresa (tu )?contrase|digite (sua )?senha|masukkan sandi|输入密码/i).first(),
    ];
    for (const loc of hits) {
        if (await loc.isVisible({timeout: 250}).catch(() => false)) {
            await loc.click({timeout: 1200}).catch(async () => loc.click({force: true, timeout: 800}).catch(() => {}));
            return;
        }
    }
    await page.locator(PASSWORD_BOX_SEL).first().click({force: true, timeout: 800}).catch(() => {});
}

async function waitForLoginPasswordBox(page, write, ms = 12000) {
    const deadline = Date.now() + ms;
    let primed = false;
    while (Date.now() < deadline) {
        const step = loginStep(page.url());
        if (step === "totp") return null;
        if (step !== "password" && step !== "other" && step !== "identifier") return null;
        let box = await findLoginPasswordBox(page);
        if (box) return box;
        if (!primed && step === "password") {
            await primePasswordField(page);
            primed = true;
            box = await findLoginPasswordBox(page, {allowSmall: true});
            if (box) {
                await box.click({force: true, timeout: 800}).catch(() => {});
                await page.waitForTimeout(250);
                return await findLoginPasswordBox(page) || box;
            }
        }
        await page.waitForTimeout(350);
    }
    await dumpPasswordInputs(page, write);
    return findLoginPasswordBox(page, {allowSmall: true});
}

function emptyPasswordErrorVisible(text) {
    // 标签是 Enter your password；红字报错才是 Enter a password。
    const t = String(text || "");
    return /\bEnter a password\b/.test(t)
        || /Ingresa una contrase[nñ]a/i.test(t)
        || /Saisissez un mot de passe/i.test(t)
        || /Masukkan sandi/i.test(t)
        || /请输入密码/.test(t);
}

async function hostNextReady(page, hostSel) {
    return page.evaluate((sel) => {
        const host = document.querySelector(sel);
        if (!host) return false;
        const rect = host.getBoundingClientRect();
        if (rect.width < 8 || rect.height < 8) return false;
        const st = getComputedStyle(host);
        if (st.display === "none" || st.visibility === "hidden" || Number(st.opacity) === 0) return false;
        const btn = host.querySelector("button") || host;
        return !btn.disabled && btn.getAttribute("aria-disabled") !== "true";
    }, hostSel).catch(() => false);
}

async function tryClick(loc, timeout = 2500) {
    try {
        if (!await loc.isVisible({timeout: 400}).catch(() => false)) return false;
        await loc.click({timeout, noWaitAfter: true});
        return true;
    } catch {
        return false;
    }
}

/** 只点当前看得见、已启用的 Next。不用 JS 伪造 click（isTrusted=false，Google 会当没点）。 */
async function clickHostNext(page, hostSel) {
    if (!await hostNextReady(page, hostSel)) return false;
    const host = page.locator(hostSel).first();
    if (!await host.isVisible({timeout: 400}).catch(() => false)) return false;
    const inner = host.locator("button").first();
    const target = await inner.isVisible({timeout: 200}).catch(() => false) ? inner : host;
    try {
        await target.scrollIntoViewIfNeeded();
        await target.click({timeout: 2500, noWaitAfter: true});
        return true;
    } catch {
        try {
            const box = await target.boundingBox();
            if (!box) return false;
            await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
            return true;
        } catch {
            return false;
        }
    }
}

function loginStep(url) {
    const u = String(url || "");
    if (/challenge\/totp|signin\/totp/i.test(u)) return "totp";
    if (/challenge\/pwd|signin\/pwd|challenge\/password/i.test(u)) return "password";
    if (/signin\/identifier|ServiceLogin/i.test(u)) return "identifier";
    return "other";
}

/** 只点当前这一步的 Next，避免点到上一页还留在 DOM 里的按钮。 */
async function clickStepNext(page) {
    const step = loginStep(page.url());
    const host = step === "totp" ? "#totpNext" : step === "password" ? "#passwordNext" : "#identifierNext";
    if (await clickHostNext(page, host)) return true;
    const named = page.getByRole("button", {name: /^(next|verify|continue|下一步|验证|继续)$/i}).first();
    if (await tryClick(named, 2000)) return true;
    return false;
}

async function clickNext(page, _timeout = 800) {
    return clickStepNext(page);
}

async function waitLeftIdentifier(page, pwdSoon) {
    for (let w = 0; w < 50; w++) {
        await page.waitForTimeout(400);
        const url = String(page.url());
        const st = loginStep(url);
        if (st === "password" || st === "totp") return true;
        if (!/signin\/identifier/i.test(url) && /challenge|rejected|speedbump|signin\/v2|signin\/pwd/i.test(url)) return true;
        if (await findLoginPasswordBox(page)) return true;
        if (await totpFieldVisible(page)) return true;
        if (await pwdSoon.isVisible({timeout: 150}).catch(() => false)) return true;
    }
    return false;
}

async function dismissGoogleConsent(page, write) {
    const blob = `${page.url()} ${String(await page.innerText("body").catch(() => "")).slice(0, 1200)}`;
    if (!/before you continue|we use cookies|value your privacy|consent\.google|gode cookie|Accept all|Reject all/i.test(blob)) {
        return false;
    }
    for (const name of [/accept all/i, /^i agree$/i, /^agree$/i, /reject all/i, /^got it$/i, /^ok$/i]) {
        const b = page.getByRole("button", {name}).first();
        if (await b.isVisible({timeout: 350}).catch(() => false)) {
            await b.click().catch(() => {});
            write(`  关掉同意页`);
            await page.waitForTimeout(1200);
            return true;
        }
    }
    return false;
}

async function findIdentifierBox(page) {
    const boxes = page.locator('input[name="identifier"], #identifierId, input[type="email"]');
    const n = await boxes.count().catch(() => 0);
    let best = null;
    let bestW = 0;
    for (let i = 0; i < n; i++) {
        const el = boxes.nth(i);
        if (!await el.isVisible({timeout: 200}).catch(() => false)) continue;
        const typ = String(await el.getAttribute("type").catch(() => "") || "").toLowerCase();
        if (typ === "hidden") continue;
        const box = await el.boundingBox().catch(() => null);
        if (!box || box.width < 40) continue;
        if (box.width > bestW) {
            best = el;
            bestW = box.width;
        }
    }
    return best;
}

async function clickIdentifierNext(page) {
    if (await clickHostNext(page, "#identifierNext")) return "host";
    const named = page.getByRole("button", {name: /^(next|continue|下一步|继续|siguiente|pr[oó]ximo)$/i}).first();
    if (await tryClick(named, 2000)) return "role";
    return "";
}

async function checkError(page) {
    try {
        const url = page.url();
        if (/recaptcha|captcha/i.test(url)) return "reCAPTCHA 人机验证";
        const text = await page.innerText("body");
        const lower = String(text || "").toLowerCase();
        if (IMAGE_CAPTCHA_RE.test(lower) || lower.includes("not a robot") || lower.includes("no eres un robot")) {
            return "reCAPTCHA 人机验证";
        }
        if (/err_ssl_protocol_error|can.?t provide a secure connection|sent an invalid response/i.test(lower)) {
            return "SSL/代理中断";
        }
        for (const marker of ERROR_MARKERS) {
            if (lower.includes(marker.toLowerCase())) return marker;
        }
    } catch {
        /* ignore */
    }
    return "";
}

function isPostLoginUrl(url) {
    const u = String(url || "");
    // continue=myaccount.google.com 会写在登录 URL 查询串里，不能当成已经进了账号中心
    if (/accounts\.google\.com/i.test(u) && /signin|challenge|ServiceLogin/i.test(u)) return false;
    if (/myaccount\.google\.com\/intro/i.test(u)) return false;
    try {
        const host = new URL(u).hostname;
        return /^(mail\.google\.com|myaccount\.google\.com|gds\.google\.com)$/i.test(host);
    } catch {
        return /mail\.google\.com\/mail|myaccount\.google\.com|gds\.google\.com/i.test(u);
    }
}

async function pageLooksLikeGoogleSignIn(page) {
    const t = String(await page.innerText("body").catch(() => ""));
    if (/Inbox|Primary|Important|Caixa de entrada|Inkorg/i.test(t) && !/Forgot email/i.test(t)) return false;
    return /Use your Google Account|Email or phone|Forgot email|Create account|identifierId/i.test(t);
}

/** 检查是否还在 Google 登录页面。 */
export async function isOnGoogleLoginPage(page) {
    const url = page.url();
    if (/myaccount\.google\.com\/intro|accounts\.google\.com\/.*(interstitial|recoveryoptions|doritos)/i.test(url)) return true;
    if (isPostLoginUrl(url)) return pageLooksLikeGoogleSignIn(page);
    if (!String(url).includes("accounts.google.com")) return false;
    try {
        const u = new URL(url);
        if (/accounts\.google\.com$/i.test(u.hostname) && /signin|challenge|ServiceLogin/i.test(u.pathname)) return true;
        if (/myaccount\.google\.com$/i.test(u.hostname) && /video-verification|precollection/i.test(u.pathname)) return false;
    } catch {
        if (/signin|challenge|ServiceLogin/i.test(url)) return true;
    }
    try {
        const ei = page.locator('input[type="email"], input[name="identifier"]');
        const pi = page.locator('input[type="password"], input[name="Passwd"]');
        const ti = page.locator('input[name="totpPin"], input[type="tel"]');
        if (await ei.first().isVisible({timeout: 500})) return true;
        if (await pi.first().isVisible({timeout: 500})) return true;
        if (await ti.first().isVisible({timeout: 500})) return true;
    } catch {
        /* ignore */
    }
    return false;
}

/**
 * 在当前 page 上完成 Google 登录。
 * 兼容对象参数：{email, password, totpSecret, recoveryEmail, log}
 */
export async function googleLogin(page, emailOrOpts, password = "", totpSecret = "", recoveryEmail = "", log = console.log) {
    const opts = emailOrOpts && typeof emailOrOpts === "object"
        ? emailOrOpts
        : {email: emailOrOpts, password, totpSecret, recoveryEmail, log};
    const email = String(opts.email || "");
    const pwd = String(opts.password || "");
    const write = typeof opts.log === "function" ? opts.log : console.log;
    const straight = straightenGoogleCreds(opts);
    const totp = straight.totpSecret;
    const recovery = straight.recoveryEmail;
    if (straight.swapped) write("  导入字段对调：totp/辅助邮箱已纠正");
    if (!totp && String(opts.totpSecret || opts.totp_secret || "")) write("  totp 字段不是合法密钥，改走其它验证");

    try {
        let idleCount = 0;
        let totpAttempts = 0;
        let passwordFilled = false;
        let emailSubmitted = false;
        let emailNextClicks = 0;
        let passwordNextClicks = 0;
        let tryAnotherClicks = 0;
        for (let step = 0; step < 15; step++) {
            const err = await checkError(page);
            if (err) {
                write(`  登录失败: ${err}`);
                return false;
            }

            if (!await isOnGoogleLoginPage(page)) break;

            let acted = false;

            const url = page.url();
            if (await dismissGoogleGlitch(page, write)) continue;
            if (await dismissGoogleConsent(page, write)) continue;
            if (await dismissRecoveryPrompt(page, write)) continue;

            if (/video-verification|precollection|selfie/i.test(String(url))) {
                for (const t of ["Not now", "Skip", "No thanks", "Maybe later", "Cancel", "Do it later", "以后再说", "跳过", "Lain kali", "Agora não"]) {
                    if (await safeClick(page, `button:has-text("${t}"), a:has-text("${t}"), [role="button"]:has-text("${t}")`, 1500)) {
                        write(`  跳过自拍验证: ${t}`);
                        await page.waitForTimeout(3000);
                        acted = true;
                        break;
                    }
                }
                if (!acted) {
                    write("  已过验证码，落到自拍页（登录已成功）");
                    return true;
                }
                continue;
            }

            // 已经到密码/验证码页就不要再动邮箱。identifier 输入框在密码页 DOM 里还在。
            const step = loginStep(url);
            const pwdSoon = page.locator('input[name="Passwd"]:visible').first();
            const pwdVisible = await pwdSoon.isVisible({timeout: 400}).catch(() => false);
            if (step === "identifier" && !pwdVisible && !await totpFieldVisible(page)) {
                const ei = await findIdentifierBox(page) || page.locator('input[name="identifier"], #identifierId').first();
                if (await ei.isVisible({timeout: 1500}).catch(() => false)) {
                    if (!emailSubmitted) {
                        for (let i = 0; i < 24 && !await hostNextReady(page, "#identifierNext"); i++) await page.waitForTimeout(250);
                        await page.waitForTimeout(400);
                        await typeGoogleInput(ei, email);
                        const shown = String(await ei.inputValue().catch(() => ""));
                        if (shown.toLowerCase() !== email.toLowerCase()) {
                            await ei.click().catch(() => {});
                            await ei.fill("").catch(() => {});
                            await ei.pressSequentially(email, {delay: 45});
                        }
                        emailSubmitted = true;
                        write(`  邮箱已输入: ${email} 框内=${String(await ei.inputValue().catch(() => "")).slice(0, 40)}`);
                        await ei.press("Tab").catch(() => {});
                        await page.waitForTimeout(600);
                        for (let i = 0; i < 20 && !await hostNextReady(page, "#identifierNext"); i++) await page.waitForTimeout(250);
                    }
                    if (emailNextClicks >= 3) {
                        const leftover = String(await page.innerText("body").catch(() => "")).replace(/\s+/g, " ").slice(0, 160);
                        write(`  邮箱页 Next 已点过 ${emailNextClicks} 次仍在 identifier url=${String(page.url()).slice(0, 80)} ${leftover}`);
                        try {
                            const {mkdirSync} = await import("node:fs");
                            const {default: path} = await import("node:path");
                            const dir = path.resolve(process.cwd(), "captures", "screenshots");
                            mkdirSync(dir, {recursive: true});
                            await page.screenshot({path: path.join(dir, `id_stuck_${Date.now()}.png`), fullPage: true});
                        } catch { /* ignore */ }
                        return false;
                    }
                    emailNextClicks += 1;
                    let how = "";
                    if (emailNextClicks === 1) {
                        how = await clickIdentifierNext(page);
                        if (!how) {
                            await ei.press("Enter").catch(() => {});
                            how = "enter";
                        }
                    } else if (emailNextClicks === 2) {
                        await ei.click().catch(() => {});
                        await ei.press("Enter").catch(() => {});
                        how = "enter";
                    } else {
                        how = await clickIdentifierNext(page) || "retry";
                    }
                    write(`  邮箱页提交 #${emailNextClicks} via=${how || "?"} nextReady=${await hostNextReady(page, "#identifierNext")}`);
                    const left = await waitLeftIdentifier(page, pwdSoon);
                    if (left) await page.waitForTimeout(700);
                    if (!left && !await totpFieldVisible(page)) {
                        write(`  第 ${emailNextClicks} 次提交后仍在邮箱页 url=${String(page.url()).slice(0, 80)}`);
                    }
                    const e2 = await checkError(page);
                    if (e2) {
                        write(`  邮箱错误: ${e2}`);
                        return false;
                    }
                    if (loginStep(page.url()) === "password") {
                        write("  已到密码页，等密码框");
                        await waitForLoginPasswordBox(page, write, 10000);
                    }
                    continue;
                }
            }

            // 登录密码：只填真正看得见的大框。隐藏 Passwd 也能 :visible，填了 Google 当没填。
            const pwdLogin = loginStep(page.url()) === "password"
                ? await waitForLoginPasswordBox(page, write, passwordFilled ? 2000 : 8000)
                : await findLoginPasswordBox(page);
            if (!passwordFilled && pwd && pwdLogin) {
                await page.waitForTimeout(500);
                await typeGoogleInput(pwdLogin, pwd, {selectAll: true});
                await page.waitForTimeout(400);
                let shownPw = String(await pwdLogin.inputValue().catch(() => ""));
                if (shownPw !== String(pwd)) {
                    write("  密码框内容和库不一致，重打，不点 Next");
                    await pwdLogin.click().catch(() => {});
                    await pwdLogin.press("Control+A").catch(() => {});
                    await pwdLogin.pressSequentially(pwd, {delay: 40});
                    await page.waitForTimeout(400);
                    shownPw = String(await pwdLogin.inputValue().catch(() => ""));
                }
                if (!shownPw) {
                    write("  密码仍未进框，放弃这次提交");
                    continue;
                }
                write(`  密码已输入 len=${shownPw.length} 框内确认非空`);
                for (let i = 0; i < 12 && !await hostNextReady(page, "#passwordNext"); i++) await page.waitForTimeout(200);
                const still = String(await pwdLogin.inputValue().catch(() => ""));
                if (!still) {
                    write("  提交前密码框被清空，不点 Next");
                    continue;
                }
                passwordNextClicks += 1;
                await pwdLogin.press("Enter").catch(() => {});
                write("  密码页在输入框回车");
                let leftPwd = false;
                for (let w = 0; w < 10; w++) {
                    await page.waitForTimeout(400);
                    if (await totpFieldVisible(page) || loginStep(page.url()) === "totp") { leftPwd = true; break; }
                    if (emptyPasswordErrorVisible(await page.innerText("body").catch(() => ""))) break;
                    if (!/challenge\/pwd|signin\/pwd/i.test(page.url()) && loginStep(page.url()) !== "password") { leftPwd = true; break; }
                }
                if (!leftPwd && emptyPasswordErrorVisible(await page.innerText("body").catch(() => ""))) {
                    write("  回车后仍是空密码，重新填，不点 Next");
                    continue;
                }
                if (!leftPwd) {
                    const beforeNext = String(await pwdLogin.inputValue().catch(() => ""));
                    if (!beforeNext) {
                        write("  Next 前密码框空了，不点");
                        continue;
                    }
                    if (!await clickHostNext(page, "#passwordNext")) {
                        write("  密码页 #passwordNext 点不到");
                    } else {
                        write("  密码页点 Next");
                    }
                }
                passwordFilled = true;
                for (let w = 0; w < 15; w++) {
                    await page.waitForTimeout(1000);
                    if (await totpFieldVisible(page)) break;
                    if (emptyPasswordErrorVisible(await page.innerText("body").catch(() => ""))) {
                        write("  点完 Next 仍报空密码，重置后再填");
                        passwordFilled = false;
                        break;
                    }
                    if (!await isOnGoogleLoginPage(page) && looksLikeAccountHome(page.url(), String(await page.innerText("body").catch(() => "")))) break;
                    const e2 = await checkError(page);
                    if (e2) {
                        write(`  密码错误: ${e2}`);
                        return false;
                    }
                }
                continue;
            }

            // TOTP：窗口够用再填；Google 常自动提交，先等，再视情况点 Next。Wrong code 换下一窗重试。
            if (totpAttempts < 4 && totp && await totpFieldVisible(page)) {
                totpAttempts += 1;
                const submitted = await submitGoogleTotp(page, totp, write, totpAttempts);
                if (submitted === "glitch") {
                    totpAttempts = Math.max(0, totpAttempts - 1);
                    write("  验证页故障已 Restart，重填验证码");
                    await page.waitForTimeout(800);
                    continue;
                }
                if (submitted === "left") {
                    let host = "";
                    try { host = new URL(page.url()).hostname; } catch { /* */ }
                    if (!/accounts\.google\.com$/i.test(host)) {
                        write("  登录完成");
                        return true;
                    }
                }
                const e2 = await checkError(page);
                if (e2 && !WRONG_TOTP_RE.test(e2)) {
                    write(`  TOTP 验证失败: ${e2}`);
                    return false;
                }
                if (!await isOnGoogleLoginPage(page)) {
                    write("  登录完成");
                    return true;
                }
                if (WRONG_TOTP_RE.test(String(await page.innerText("body").catch(() => "")))) {
                    write("  TOTP Wrong code，清空后等下一窗");
                    const box = await findVisibleTotpBox(page);
                    if (box) {
                        await box.click().catch(() => {});
                        await box.fill("").catch(() => {});
                    }
                    await waitNextTotpWindow();
                    continue;
                }
                write("  TOTP 后仍在验证页，继续处理挑战");
            } else if (totpAttempts < 3 && !totp && await page.locator('input[name="totpPin"], input[type="tel"]').first().isVisible({timeout: 800}).catch(() => false)) {
                write("  需要 TOTP 但未提供 secret");
                return false;
            }

            // 异常活动 / Verify it's you：先点「是我」再走其他方式
            const bodyText = String(await page.innerText("body").catch(() => ""));
            if (CHALLENGE_MARKERS.some((m) => bodyText.toLowerCase().includes(m.toLowerCase()))) {
                write("  遇到异常活动/身份确认页");
                for (const t of ACK_TEXTS) {
                    if (await safeClick(page, `button:has-text("${t}"), a:has-text("${t}"), [role="button"]:has-text("${t}")`, 800)) {
                        write(`  确认本人: ${t}`);
                        await page.waitForTimeout(3000);
                        acted = true;
                        break;
                    }
                }
                if (acted) continue;
            }

            // 密码已交、还在 pwd 页：先等 2FA。空密码红字就重填，绝不再盲点 Next。
            if (passwordFilled && totp && /challenge\/pwd/i.test(page.url()) && !await totpFieldVisible(page)) {
                if (emptyPasswordErrorVisible(await page.innerText("body").catch(() => ""))) {
                    write("  密码页报 Enter a password，重新填");
                    passwordFilled = false;
                    continue;
                }
                const stayBox = await findLoginPasswordBox(page);
                const stayVal = stayBox ? String(await stayBox.inputValue().catch(() => "")) : "";
                if (!stayVal) {
                    write("  密码提交后框是空的，重新填，不点 Next");
                    passwordFilled = false;
                    continue;
                }
                write("  密码已交，等 2FA 框");
                let sawTotp = false;
                for (let w = 0; w < 12; w++) {
                    await page.waitForTimeout(800);
                    if (await totpFieldVisible(page)) { sawTotp = true; break; }
                    if (emptyPasswordErrorVisible(await page.innerText("body").catch(() => ""))) break;
                    if (!/challenge\/pwd/i.test(page.url())) break;
                }
                if (sawTotp) continue;
                if (emptyPasswordErrorVisible(await page.innerText("body").catch(() => ""))
                    || !(stayBox && String(await stayBox.inputValue().catch(() => "")))) {
                    write("  等 2FA 时密码框空了，重新填");
                    passwordFilled = false;
                    continue;
                }
            }

            // 2FA 方式选择页 — 没有输入框但有 Authenticator 可选项
            let authOption = page.locator(
                '[data-challengetype], li, [role="link"], [role="button"]',
            ).filter({hasText: "uthenticat"});
            if (!await authOption.first().isVisible({timeout: 500}).catch(() => false)) {
                authOption = page.locator(
                    '[data-challengetype], li, [role="link"], [role="button"]',
                ).filter({hasText: "utenticador"});
            }
            if (await authOption.first().isVisible({timeout: 1000}).catch(() => false)) {
                await authOption.first().click();
                write("  选择 Authenticator 验证方式");
                await page.waitForTimeout(3000);
                continue;
            }

            // 密码页/验证码页底部也有 Try another way，提前点会空提交或打断填码。
            if (tryAnotherClicks < 1 && step === "other" && !pwdVisible && !await totpFieldVisible(page)) {
                let tryBtn = page.locator('[jsname="Njthtb"]');
                if (!await tryBtn.first().isVisible({timeout: 400}).catch(() => false)) {
                    tryBtn = page.getByText(/try another way|试试其他方式|autre fa[cç]on|cara lain|otra manera|tentar de outra/i).first();
                }
                if (await tryBtn.first().isVisible({timeout: 800}).catch(() => false)) {
                    tryAnotherClicks += 1;
                    await tryBtn.first().click().catch(() => {});
                    write("  点击试试其他方式");
                    await page.waitForTimeout(3000);
                    continue;
                }
            }
            const recOpt = page.locator('[data-challengetype], li, [role="link"], [role="button"], div').filter({
                hasText: /recovery email|辅助邮箱|e-mail de recupera|correo de recupera|email de récupér|confirm.*email/i,
            }).first();
            if (recovery && await recOpt.isVisible({timeout: 800}).catch(() => false)) {
                await recOpt.click({force: true}).catch(() => {});
                write("  选择辅助邮箱验证");
                await page.waitForTimeout(3000);
                continue;
            }

            const content = await page.content();
            const recoveryHints = [
                "辅助邮箱", "recovery email", "email pemulihan",
                "e-mail de recuperação", "correo de recuperación",
                "email de récupération", "confirm your recovery",
                "confirm the email", "confirme o e-mail", "last 2 digits",
                "knowledgePreregisteredEmail",
            ];
            const contentLower = String(content || "").toLowerCase();
            // 密码页 URL 也带 challenge，不能当辅助邮箱页。泛匹配 type=text 会填错框再点 Next。
            const recBox = page.locator('input[name="knowledgePreregisteredEmailResponse"]:visible').first();
            const recVisible = await recBox.isVisible({timeout: 800}).catch(() => false);
            if (recovery && recVisible && step === "other" && recoveryHints.some((h) => contentLower.includes(h.toLowerCase()))) {
                await recBox.fill(recovery);
                await recBox.press("Enter").catch(() => {});
                write("  辅助邮箱已输入");
                await page.waitForTimeout(5000);
                continue;
            }

            for (const t of SKIP_TEXTS) {
                if (await safeClick(page, `button:has-text("${t}"), a:has-text("${t}")`, 800)) {
                    write(`  跳过: ${t}`);
                    await page.waitForTimeout(3000);
                    acted = true;
                    break;
                }
            }
            if (acted) continue;

            // 没有可操作的元素——可能页面还在 loading
            if (loginStep(page.url()) === "password" && pwd && !passwordFilled) {
                write("  密码页还没拿到输入框，再等");
                idleCount = Math.max(0, idleCount - 1);
                await waitForLoginPasswordBox(page, write, 6000);
                continue;
            }
            idleCount += 1;
            if (idleCount >= 3) break;
            await page.waitForTimeout(3000);
        }

        await page.waitForTimeout(1500);
        if (await dismissGoogleGlitch(page, write) && totp && await totpFieldVisible(page)) {
            const r = await submitGoogleTotp(page, totp, write, totpAttempts + 1);
            if (r === "left" || looksLikeAccountHome(page.url(), String(await page.innerText("body").catch(() => "")))) {
                write("  登录完成");
                return true;
            }
        }
        if (looksLikeAccountHome(page.url(), String(await page.innerText("body").catch(() => "")))) {
            write("  已在账号中心");
            return true;
        }
        if (totp && await totpFieldVisible(page)) {
            const r = await submitGoogleTotp(page, totp, write, totpAttempts + 1);
            totpAttempts += 1;
            if (r === "left" || looksLikeAccountHome(page.url(), String(await page.innerText("body").catch(() => "")))) {
                write("  登录完成");
                return true;
            }
        }
        if (await dismissRecoveryPrompt(page, write)) {
            /* 补恢复手机/邮箱插页已取消 */
        }
        if (isPostLoginUrl(page.url()) || /recoveryoptions|interstitial/i.test(page.url())) {
            for (const t of ["Cancel", "Not now", "Skip", "No thanks", "Maybe later", "以后再说", "Agora não", "Avbryt", "Senare", "Hoppa över"]) {
                if (await safeClick(page, `button:has-text("${t}"), a:has-text("${t}")`, 600)) {
                    write(`  跳过恢复信息页: ${t}`);
                    await page.waitForTimeout(2000);
                    break;
                }
            }
            if (!passwordFilled && pwd) {
                const pwdBox = await findLoginPasswordBox(page);
                if (pwdBox) {
                    await typeGoogleInput(pwdBox, pwd, {selectAll: true});
                    const shown = String(await pwdBox.inputValue().catch(() => ""));
                    if (!shown) {
                        write("  补填密码后框仍空，不点 Next");
                    } else {
                        passwordFilled = true;
                        write("  补填密码");
                        for (let i = 0; i < 12 && !await hostNextReady(page, "#passwordNext"); i++) await page.waitForTimeout(200);
                        if (String(await pwdBox.inputValue().catch(() => ""))) {
                            await pwdBox.press("Enter").catch(() => {});
                        } else {
                            write("  补填后提交前又空了，不点 Next");
                        }
                    }
                    await page.waitForTimeout(3500);
                    const afterFill = await checkError(page);
                    if (afterFill) {
                        write(`  补填密码失败: ${afterFill}`);
                        return false;
                    }
                } else if (await totpFieldVisible(page)) {
                    write("  已在 TOTP 二次验证，不再补填密码");
                } else if (/signinoptions|two-step|\/security/i.test(page.url())) {
                    write("  会话仍在账号中心，跳过补填密码");
                    return true;
                } else {
                    write(`  未输入过密码就离开登录页 url=${String(page.url()).slice(0, 90)}`);
                    return false;
                }
            }
            if (totp) {
                for (let t = 0; t < 12; t++) {
                    if (await totpFieldVisible(page)) {
                        await submitGoogleTotp(page, totp, write, 1);
                        totpAttempts += 1;
                        break;
                    }
                    if (looksLikeAccountHome(page.url(), String(await page.innerText("body").catch(() => "")))) break;
                    await page.waitForTimeout(1000);
                }
                if (totpAttempts === 0 && !looksLikeAccountHome(page.url(), String(await page.innerText("body").catch(() => "")))) {
                    write(`  有 2FA 但未见验证码框 url=${String(page.url()).slice(0, 90)}`);
                    return false;
                }
            }
            if (await isOnGoogleLoginPage(page) || !isPostLoginUrl(page.url())) {
                write(`  补填后仍未进账号中心 url=${String(page.url()).slice(0, 90)}`);
                return false;
            }
            write("  登录完成");
            return true;
        }
        if (loginStep(page.url()) === "password" && !passwordFilled) {
            write(`  还在密码页，密码没填上 url=${String(page.url()).slice(0, 90)}`);
            await dumpPasswordInputs(page, write);
            try {
                const {mkdirSync} = await import("node:fs");
                const {default: path} = await import("node:path");
                const dir = path.resolve(process.cwd(), "captures", "screenshots");
                mkdirSync(dir, {recursive: true});
                await page.screenshot({path: path.join(dir, `pwd_no_input_${Date.now()}.png`), fullPage: true});
            } catch { /* ignore */ }
            return false;
        }
        if (totp && totpAttempts === 0 && loginStep(page.url()) !== "password") {
            write(`  有 2FA 却没填验证码就离开了 url=${String(page.url()).slice(0, 90)}`);
            return false;
        }
        if (await isOnGoogleLoginPage(page) || /accounts\.google\.com/i.test(page.url())) {
            const leftover = String(await page.innerText("body").catch(() => "")).replace(/\s+/g, " ").slice(0, 180);
            write(`  登录未完成：仍在登录页 url=${String(page.url()).slice(0, 90)} ${leftover}`);
            try {
                const {mkdirSync} = await import("node:fs");
                const {default: path} = await import("node:path");
                const dir = path.resolve(process.cwd(), "captures", "screenshots");
                mkdirSync(dir, {recursive: true});
                await page.screenshot({path: path.join(dir, `gmail_login_fail_${Date.now()}.png`), fullPage: true});
            } catch { /* ignore */ }
            return false;
        }

        write("  登录完成");
        return true;
    } catch (e) {
        write(`  登录异常: ${e?.message || e}`);
        return false;
    }
}

function totpInputs(page) {
    return page.locator(
        'input[name="totpPin"]:visible, input[autocomplete="one-time-code"]:visible, '
        + 'input[id*="totp" i]:visible, input[aria-label*="code" i]:visible',
    );
}

async function isRecoveryPromptPage(page) {
    const t = String(await page.innerText("body").catch(() => ""));
    return /make sure you can always sign in|add a recovery phone|your recovery email|添加恢复电话|恢复邮箱/i.test(t);
}

const GLITCH_RE = /something went wrong|sorry, something went wrong there|出了点问题|出了点差错|出了點問題|发生错误|發生錯誤/i;

async function googleGlitchVisible(page) {
    const t = String(await page.innerText("body").catch(() => ""));
    return GLITCH_RE.test(t);
}

/** Google SPA 偶发遮罩：Something went wrong / Restart。点掉后当页重来，不当登录失败。 */
async function dismissGoogleGlitch(page, write = () => {}) {
    if (!await googleGlitchVisible(page)) return false;
    write("  Google 弹出 Something went wrong，点 Restart");
    const candidates = [
        page.getByRole("button", {name: /^(restart|try again|retry|ok|重新开始|重试|再试一次)$/i}),
        page.locator('[role="dialog"] button, [role="alertdialog"] button'),
        page.getByText(/^(Restart|Try again|Retry)$/i),
    ];
    for (const loc of candidates) {
        if (await tryClick(loc.first(), 1600)) break;
    }
    for (let i = 0; i < 12; i++) {
        await page.waitForTimeout(350);
        if (!await googleGlitchVisible(page)) return true;
    }
    write("  故障弹窗还在，继续当页处理");
    return true;
}

async function dismissRecoveryPrompt(page, write = () => {}) {
    if (!await isRecoveryPromptPage(page)) return false;
    for (const t of ["Cancel", "Not now", "Skip", "No thanks", "取消", "以后再说", "跳过"]) {
        if (await safeClick(page, `button:has-text("${t}"), [role="button"]:has-text("${t}")`, 1200)) {
            write(`  跳过补全恢复信息: ${t}`);
            await page.waitForTimeout(1500);
            return true;
        }
    }
    write("  恢复信息插页未见取消按钮");
    return false;
}

async function findVisibleTotpBox(page) {
    if (await isRecoveryPromptPage(page)) return null;
    const preferred = totpInputs(page);
    const n = await preferred.count().catch(() => 0);
    for (let i = 0; i < n; i++) {
        const el = preferred.nth(i);
        if (!await el.isVisible({timeout: 300}).catch(() => false)) continue;
        const typ = String(await el.getAttribute("type").catch(() => "") || "").toLowerCase();
        if (typ === "password" || typ === "email" || typ === "hidden" || typ === "checkbox") continue;
        const lab = `${await el.getAttribute("aria-label").catch(() => "")} ${await el.getAttribute("placeholder").catch(() => "")}`;
        if (/phone|tel|recovery/i.test(lab)) continue;
        return el;
    }
    if (loginStep(page.url()) !== "totp") return null;
    const fallback = page.locator('input[type="tel"]:visible, input[inputmode="numeric"]:visible');
    const m = await fallback.count().catch(() => 0);
    for (let i = 0; i < m; i++) {
        const el = fallback.nth(i);
        if (!await el.isVisible({timeout: 200}).catch(() => false)) continue;
        const typ = String(await el.getAttribute("type").catch(() => "") || "").toLowerCase();
        if (typ === "password" || typ === "email" || typ === "checkbox") continue;
        const name = `${await el.getAttribute("name").catch(() => "")} ${await el.getAttribute("aria-label").catch(() => "")} ${await el.getAttribute("autocomplete").catch(() => "")}`;
        const val = String(await el.inputValue().catch(() => ""));
        if (val.length > 8) continue;
        if (/phone|tel|recovery/i.test(name)) continue;
        if (/totp|pin|otp|code|one-time/i.test(name)) return el;
    }
    return null;
}

async function totpFieldVisible(page) {
    return !!(await findVisibleTotpBox(page));
}

/** 跟人打验证码一样：点框、清空、逐位按键。不用 JS 改 value（Google 当没填）。 */
async function typeTotpInto(el, code) {
    await el.click({timeout: 2000}).catch(async () => {
        await el.click({force: true, timeout: 800});
    });
    await el.press("Meta+A").catch(() => {});
    await el.press("Control+A").catch(() => {});
    await el.press("Backspace").catch(() => {});
    await el.fill("").catch(() => {});
    if (!code) return true;
    await el.pressSequentially(String(code), {delay: 90});
    const got = String(await el.inputValue().catch(() => "")).replace(/\s+/g, "");
    return got === String(code);
}

async function fillVisibleTotp(page, totp, codeOverride = "") {
    if (!codeOverride) await waitTotpSafeWindow(10);
    const code = codeOverride || generateTotp(totp);
    if (!code) return false;
    const el = await findVisibleTotpBox(page);
    if (!el) return false;
    return typeTotpInto(el, code);
}

async function totpLeftChallenge(page) {
    const url = String(page.url());
    if (/signin\/challenge\/totp/i.test(url)) return false;
    if (/accounts\.google\.com\/v3\/signin\/identifier/i.test(url)) return false;
    if (await totpFieldVisible(page) && isVerifyItsYouText(String(await page.innerText("body").catch(() => "")))) return false;
    return true;
}

async function pageHasWrongTotp(page) {
    return WRONG_TOTP_RE.test(String(await page.innerText("body").catch(() => "")));
}

/** 等离开验证码页，或出现「新的」Wrong code。上次留下的红字不算这次失败。 */
async function waitTotpOutcome(page, hadWrong, write) {
    let sawClear = !hadWrong;
    for (let i = 0; i < 14; i++) {
        await page.waitForTimeout(400);
        if (await googleGlitchVisible(page)) {
            write("  填码后弹出 Something went wrong");
            return "glitch";
        }
        if (await totpLeftChallenge(page)) {
            write(i < 4 ? "  填完后已进入" : "  提交后已进入");
            return "left";
        }
        const wrong = await pageHasWrongTotp(page);
        if (!wrong) sawClear = true;
        else if (sawClear && i >= 3) {
            write("  这次提交后出现 Wrong code");
            return "wrong";
        }
    }
    if (await totpLeftChallenge(page)) return "left";
    if (await pageHasWrongTotp(page) && sawClear) return "wrong";
    return "pending";
}

/** 逐位输入当前窗验证码。只点当前页 #totpNext。上次的 Wrong code 不能当这次失败。 */
export async function submitGoogleTotp(page, secret, write = () => {}, attempt = 1) {
    if (await dismissGoogleGlitch(page, write)) return "glitch";
    await waitTotpSafeWindow(14);
    const hadWrong = await pageHasWrongTotp(page);
    const code = generateTotp(secret);
    if (!code) return "missing";
    const typed = await fillVisibleTotp(page, secret, code);
    if (!typed) return "missing";
    write(`  TOTP ${code} 已逐位输入(${attempt})${hadWrong ? "（页上还有上次红字）" : ""}`);
    const boxAfter = await findVisibleTotpBox(page);
    if (boxAfter) await boxAfter.press("Enter").catch(() => {});
    let outcome = await waitTotpOutcome(page, hadWrong, write);
    if (outcome === "left" || outcome === "wrong" || outcome === "glitch") return outcome;

    if (await googleGlitchVisible(page)) return "glitch";
    if (await clickHostNext(page, "#totpNext")) {
        write("  验证码页点 #totpNext 一次");
    } else {
        write("  验证码页 Next 未点到，已回车过");
    }
    outcome = await waitTotpOutcome(page, await pageHasWrongTotp(page), write);
    if (outcome === "left" || outcome === "wrong" || outcome === "glitch") return outcome;
    write(`  填码后仍在验证页 url=${String(page.url()).slice(0, 80)}`);
    return "ok";
}

/** 处理敏感操作前的密码 + TOTP 二次验证。 */
export async function googleReauthPassword(page, passwordOrOpts, totpSecret = "", log = console.log) {
    const opts = passwordOrOpts && typeof passwordOrOpts === "object"
        ? passwordOrOpts
        : {password: passwordOrOpts, totpSecret, log};
    const pwd = String(opts.password || "");
    const totp = String(opts.totpSecret || "");
    const write = typeof opts.log === "function" ? opts.log : console.log;

    for (let i = 0; i < 5; i++) {
        const url = page.url();
        const body = String(await page.innerText("body").catch(() => ""));
        if (await dismissGoogleGlitch(page, write)) continue;
        if (IMAGE_CAPTCHA_RE.test(body)) {
            write("  二次验证遇到图片验证码，换出口再试");
            return false;
        }

        if (String(url).includes("video-verification")) {
            for (const t of ["Lain kali", "Not now", "Agora não"]) {
                if (await safeClick(page, `button:has-text("${t}"), a:has-text("${t}")`, 2000)) {
                    await page.waitForTimeout(5000);
                    break;
                }
            }
            continue;
        }

        // 先填已可见的 TOTP（Verify it's you 页文案也含 Authenticator，不能先去点选择器）
        if (totp && await totpFieldVisible(page)) {
            const r = await submitGoogleTotp(page, totp, write, i + 1);
            if (r === "glitch") {
                write("  二次验证故障已 Restart，重填");
                continue;
            }
            write(r === "wrong" ? "  TOTP 二次验证 Wrong code，再试" : "  TOTP 二次验证");
            if (r === "left" || !isVerifyItsYouText(String(await page.innerText("body").catch(() => "")))) return true;
            if (r === "wrong") await waitNextTotpWindow();
            continue;
        }

        // 密码（排除修改密码页 2 个框；只填看得见的大框）
        const reauthBox = await findLoginPasswordBox(page);
        if (reauthBox) {
            await typeGoogleInput(reauthBox, pwd, {selectAll: true});
            await page.waitForTimeout(600);
            if (!String(await reauthBox.inputValue().catch(() => ""))) {
                write("  二次验证密码框是空的，不点 Next");
                continue;
            }
            await reauthBox.press("Enter").catch(() => {});
            write("  密码二次验证（回车）");
            await page.waitForTimeout(2500);
            continue;
        }
        const pwdCount = await page.locator('input[type="password"]:visible, input[name="Passwd"]:visible').count().catch(() => 0);
        if (pwdCount >= 2 && !reauthBox) break;

        // 2FA 方式选择（仅当还没有验证码框时）
        const content = await page.content();
        const alreadyCode = /Enter code|输入验证码|Ingresar el c[oó]digo|Introduc/i.test(content);
        if (!alreadyCode && /uthenticat|utenticador/i.test(content) && !isVerifyItsYouText(body)) {
            const authOpt = page.locator(
                '[data-challengetype], li, [role="link"], [role="button"]',
            ).filter({hasText: /uthenticat|utenticador/i});
            if (await authOpt.first().isVisible({timeout: 1000}).catch(() => false)) {
                await authOpt.first().click();
                await page.waitForTimeout(3000);
                continue;
            }
        }

        if (!isVerifyItsYouText(body) && !/accounts\.google\.com\/(signin|challenge|v3)/i.test(String(url))) break;
        await page.waitForTimeout(1500);
    }

    const leftover = String(await page.innerText("body").catch(() => ""));
    if (isVerifyItsYouText(leftover) || IMAGE_CAPTCHA_RE.test(leftover)) {
        write("  二次验证未过");
        return false;
    }
    return true;
}

/** 兼容旧名 */
export const googleReauth = googleReauthPassword;

/**
 * 导航到目标 URL，如果需要登录则自动登录。
 * 兼容：ensureGoogleLoggedIn(page, url, {email, password, totpSecret, recoveryEmail}, log)
 */
export async function ensureGoogleLoggedIn(page, targetUrl, creds = {}, log = console.log) {
    const email = String(creds.email || "");
    const password = String(creds.password || "");
    const totpSecret = String(creds.totpSecret || "");
    const recoveryEmail = String(creds.recoveryEmail || "");
    const write = typeof log === "function" ? log : (typeof creds.log === "function" ? creds.log : console.log);

    for (let nav = 0; nav < 3; nav++) {
        try {
            await page.goto(targetUrl, {waitUntil: "domcontentloaded", timeout: 30000});
        } catch (e) {
            write(`  打开目标页失败(${String(e?.message || e).slice(0, 80)})，重试 ${nav + 1}/3`);
            await page.waitForTimeout(2500);
            continue;
        }
        await page.waitForTimeout(2000);
        const bootTry = String(await page.innerText("body").catch(() => ""));
        if (/err_ssl_protocol_error|can.?t provide a secure connection|sent an invalid response|ERR_CONNECTION|can.t be reached/i.test(bootTry)) {
            write("  目标页 SSL/代理中断，重载");
            await page.waitForTimeout(3000);
            continue;
        }
        break;
    }
    const continueUrl = loginContinueUrl(targetUrl, creds);
    if (/workspace\.google\.com|about\/products|google\.com\/account\/about/i.test(page.url())) {
        write("  落到 Gmail/Workspace 营销页，改走 Google 登录入口");
        try {
            await page.goto(
                `https://accounts.google.com/ServiceLogin?hl=en&continue=${encodeURIComponent(continueUrl)}`,
                {waitUntil: "domcontentloaded", timeout: 30000},
            );
        } catch { /* ignore */ }
        await page.waitForTimeout(4000);
    }

    let boot = String(await page.innerText("body").catch(() => ""));
    if (/can.t be reached|ERR_CONNECTION|unexpectedly closed|err_ssl_protocol_error|can.?t provide a secure connection/i.test(boot)
        || /ERR_CONNECTION|ERR_SSL|ERR_TUNNEL/i.test(String(page.url()))) {
        write("  直达账号中心被代理掐了，改走登录入口");
        try {
            await page.goto(
                `https://accounts.google.com/ServiceLogin?hl=en&continue=${encodeURIComponent(continueUrl)}`,
                {waitUntil: "domcontentloaded", timeout: 30000},
            );
        } catch { /* ignore */ }
        await page.waitForTimeout(2500);
        boot = String(await page.innerText("body").catch(() => ""));
        if (/can.t be reached|ERR_CONNECTION|err_ssl_protocol_error/i.test(boot)) {
            write("  打开目标页失败(网络/代理)");
            return false;
        }
    }

    const alreadyInbox = /mail\.google\.com\/mail/i.test(page.url())
        && /\b(Inbox|Primary|Caixa de entrada|收件箱)\b/i.test(boot)
        && !/workspace\.google\.com|about\/products/i.test(page.url());
    if (alreadyInbox) {
        write("  已在收件箱");
        return true;
    }
    if (!/accounts\.google\.com/i.test(page.url())) {
        write("  走 Google 登录入口");
        try {
            await page.goto(
                `https://accounts.google.com/ServiceLogin?hl=en&continue=${encodeURIComponent(continueUrl)}`,
                {waitUntil: "domcontentloaded", timeout: 30000},
            );
        } catch { /* ignore */ }
        await page.waitForTimeout(4000);
    }

    write("  需要登录");
    const ok = await googleLogin(page, {email, password, totpSecret, recoveryEmail, log: write});
    if (!ok) return false;

    // 等 Google SPA 完成跳转 + 处理可能的二次验证
    for (let waitI = 0; waitI < 5; waitI++) {
        await bounceOffSslOrSid(page, write);
        await page.waitForTimeout(1500);
        const curUrl = page.url();
        if (/recaptcha|captcha/i.test(curUrl)) {
            write("  遇到 reCAPTCHA 人机验证，无法自动通过");
            return false;
        }
        if (!await isOnGoogleLoginPage(page)) break;

        const ti = page.locator(
            'input[name="totpPin"], input[type="tel"], input[placeholder*="code" i], input[aria-label*="code" i], input[autocomplete="one-time-code"]',
        ).first();
        if (await ti.isVisible({timeout: 1000}).catch(() => false) && totpSecret) {
            await submitGoogleTotp(page, totpSecret, write, waitI + 1);
            write("  二次 TOTP 验证");
            continue;
        }
        const pi = page.locator('input[type="password"]:visible').first();
        if (await pi.isVisible({timeout: 1000}).catch(() => false)) {
            await pi.fill(password);
            await page.waitForTimeout(500);
            await clickNext(page, 2000);
            write("  二次密码验证");
            continue;
        }
    }

    if (await isOnGoogleLoginPage(page)) {
        const curUrl = page.url();
        if (/recaptcha|captcha/i.test(curUrl)) {
            write("  遇到 reCAPTCHA 人机验证，无法自动通过");
            return false;
        }
        try {
            await page.goto(targetUrl, {waitUntil: "domcontentloaded", timeout: 30000});
        } catch {
            /* ignore */
        }
        await page.waitForTimeout(2500);
        if (await isOnGoogleLoginPage(page)) {
            const again = page.url();
            if (/recaptcha|captcha/i.test(again)) write("  遇到 reCAPTCHA 人机验证");
            else write("  登录后仍在登录页，可能凭据无效");
            return false;
        }
    }

    if (await dismissRecoveryPrompt(page, write) || /interstitial|doritos|passkey|recoveryoptions/i.test(page.url())) {
        write("  处理登录后插页");
        await dismissRecoveryPrompt(page, write);
        const names = page.getByRole("button");
        const n = Math.min(await names.count().catch(() => 0), 12);
        for (let i = 0; i < n; i++) {
            const b = names.nth(i);
            if (!await b.isVisible().catch(() => false)) continue;
            const txt = String(await b.innerText().catch(() => "")).replace(/\s+/g, " ").trim();
            if (!txt || /help|privacy|terms|footer|learn more|save|保存|done|完成/i.test(txt)) continue;
            if (!/cancel|skip|not now|no thanks|取消|跳过/i.test(txt)) continue;
            write(`  插页按钮: ${txt.slice(0, 40)}`);
            await b.click({force: true}).catch(() => {});
            await page.waitForTimeout(1200);
            if (!/interstitial|doritos|recovery/i.test(page.url()) && !await isRecoveryPromptPage(page)) break;
        }
    }
    // 整备/改密/换2FA 都不需要收件箱。目标是账号中心时也不强求 Gmail。
    const needInbox = creds.requireInbox === true;
    if (!needInbox) {
        for (let w = 0; w < 8; w++) {
            await bounceOffSslOrSid(page, write);
            if (looksLikeAccountHome(page.url(), String(await page.innerText("body").catch(() => "")))) {
                write(`  登录后已在账号中心 ${String(page.url()).slice(0, 70)}`);
                return true;
            }
            if (loginStep(page.url()) === "totp" && totpSecret) {
                await submitGoogleTotp(page, totpSecret, write, 1);
            }
            await page.waitForTimeout(800);
        }
        const my = await tryOpenMyAccount(page, write, totpSecret);
        if (my) {
            write("  账号已登录，整备走账号中心（不依赖 Gmail 收件箱）");
            return true;
        }
        if (looksLikeAccountHome(page.url(), String(await page.innerText("body").catch(() => "")))) {
            write(`  跳转超时但已在账号中心 ${String(page.url()).slice(0, 70)}`);
            return true;
        }
        write(`  账号中心未确认 url=${String(page.url()).slice(0, 90)}`);
        return false;
    }
    const inboxOk = await recoverGmailInbox(page, write);
    if (inboxOk) return true;
    if (!needInbox) {
        const my = await tryOpenMyAccount(page, write);
        if (my) {
            write("  未进收件箱，但账号中心已登录，整备可继续");
            return true;
        }
    }
    write(`  登录后未进收件箱 url=${String(page.url()).slice(0, 90)}`);
    return false;
}

function loginContinueUrl(targetUrl, creds = {}) {
    if (creds.requireInbox === false) return "https://myaccount.google.com/security?hl=en";
    if (/myaccount\.google\.com|gds\.google\.com/i.test(String(targetUrl || ""))) {
        return String(targetUrl);
    }
    return "https://mail.google.com/mail/u/0/#inbox";
}

function isSslOrSidDead(url, body = "") {
    const blob = `${url} ${body}`;
    return /chrome-error:|err_ssl|can.?t provide a secure connection|sent an invalid response|ERR_CONNECTION|ERR_TUNNEL|ERR_PROXY/i.test(blob)
        || /accounts\.youtube\.com|\/accounts\/SetSID/i.test(url);
}

export async function bounceOffSslOrSid(page, write) {
    const url = String(page.url());
    const body = String(await page.innerText("body").catch(() => ""));
    if (!isSslOrSidDead(url, body)) return false;
    write(`  跨站 SetSID/SSL 被代理掐了，改回账号中心 ${url.slice(0, 70)}`);
    try {
        await page.goto("https://myaccount.google.com/security?hl=en", {waitUntil: "domcontentloaded", timeout: 45000});
    } catch { /* */ }
    await page.waitForTimeout(1500);
    return true;
}

function looksLikeAccountHome(url, body) {
    if (isSslOrSidDead(url, body)) return false;
    if (/workspace\.google\.com|google\.com\/account\/about|about\/products|myaccount\.google\.com\/intro/i.test(url)) return false;
    if (/accounts\.google\.com/i.test(url)) return false;
    if (/myaccount\.google\.com|gds\.google\.com/i.test(url)) return true;
    return /Security|Personal info|Data & privacy|欢迎|账号/i.test(body)
        && !/Create a Google Account|Use your Google Account|Sign in to continue|2-Step Verification/i.test(body.slice(0, 200));
}

async function dismissAccountIntro(page, write) {
    if (!/myaccount\.google\.com\/intro/i.test(page.url())) return false;
    write("  落到账号介绍页，点进设置（不重新登录）");
    for (const name of [/get started/i, /^next$/i, /^continue$/i, /开始/, /下一步/]) {
        const b = page.getByRole("button", {name}).first();
        if (await b.isVisible({timeout: 600}).catch(() => false)) {
            await b.click({force: true}).catch(() => {});
            await page.waitForTimeout(1500);
            break;
        }
    }
    try {
        await page.goto("https://myaccount.google.com/signinoptions/two-step-verification?hl=en", {
            waitUntil: "domcontentloaded", timeout: 30000,
        });
    } catch { /* ignore */ }
    await page.waitForTimeout(2500);
    return !/myaccount\.google\.com\/intro|accounts\.google\.com\/(v3\/signin\/identifier|ServiceLogin)/i.test(page.url());
}

async function tryOpenMyAccount(page, write, totpSecret = "") {
    const here = String(page.url());
    const hereBody = String(await page.innerText("body").catch(() => ""));
    if (looksLikeAccountHome(here, hereBody)) {
        write(`  已在 Google 账号中心 ${here.slice(0, 70)}`);
        return true;
    }
    if (/myaccount\.google\.com\/intro/i.test(here) && await dismissAccountIntro(page, write)) {
        write(`  已从介绍页进入 ${String(page.url()).slice(0, 70)}`);
        return true;
    }
    // 刚登完不要先冲 2FA 设置页，会再要一次验证码。先走普通安全页。
    const targets = [
        "https://myaccount.google.com/security?hl=en",
        "https://myaccount.google.com/?hl=en",
    ];
    for (const url of targets) {
        try {
            await page.goto(url, {waitUntil: "domcontentloaded", timeout: 45000});
        } catch (e) {
            write(`  打开账号中心超时 ${url.split("?")[0].slice(-24)}: ${String(e?.message || e).slice(0, 60)}`);
        }
        await bounceOffSslOrSid(page, write);
        await page.waitForTimeout(1500);
        if (loginStep(page.url()) === "totp" && totpSecret) {
            write("  进账号中心又要验证码，再填一次");
            await submitGoogleTotp(page, totpSecret, write, 1);
            await page.waitForTimeout(2000);
        }
        if (/myaccount\.google\.com\/intro/i.test(page.url())) {
            if (await dismissAccountIntro(page, write)) return true;
            continue;
        }
        const landed = String(page.url());
        const body = String(await page.innerText("body").catch(() => ""));
        if (looksLikeAccountHome(landed, body)) {
            write(`  已进入 Google 账号中心 ${landed.slice(0, 70)}`);
            return true;
        }
        write(`  账号中心未打开 url=${landed.slice(0, 80)}`);
    }
    return looksLikeAccountHome(page.url(), String(await page.innerText("body").catch(() => "")));
}

async function recoverGmailInbox(page, write) {
    const tries = [
        "https://mail.google.com/mail/u/0/#inbox",
        "https://mail.google.com/mail/u/0/?ui=html",
        "https://mail.google.com/mail/?tab=rm&ogbl",
    ];
    for (const url of tries) {
        try {
            await page.goto(url, {waitUntil: "domcontentloaded", timeout: 30000});
        } catch { continue; }
        await page.waitForTimeout(2200);
        const landedUrl = String(page.url());
        const landedBody = String(await page.innerText("body").catch(() => ""));
        if (/workspace\.google\.com|about\/products|google\.com\/account\/about/i.test(landedUrl)) {
            write(`  落到营销页 ${landedUrl.slice(0, 70)}，不点广告按钮`);
            const clicked = await clickWorkspaceGmail(page);
            if (clicked) {
                await page.waitForTimeout(2500);
                if (/mail\.google\.com\/mail/i.test(page.url())) {
                    write("  已从营销页进入 Gmail");
                    return true;
                }
            }
            continue;
        }
        if (/\b(Inbox|Primary|Caixa de entrada|收件箱|#inbox)\b/i.test(`${landedUrl} ${landedBody}`)) {
            write("  已进收件箱");
            return true;
        }
        if (/mail\.google\.com\/mail/i.test(landedUrl) && !/accounts\.google\.com/i.test(landedUrl)) {
            write("  已在 Gmail 页");
            return true;
        }
    }
    return false;
}

async function clickWorkspaceGmail(page) {
    const texts = [
        /^Go to Gmail$/i, /^Sign in to Gmail$/i, /^Open Gmail$/i,
        /^前往 Gmail$/, /^打开 Gmail$/,
    ];
    for (const re of texts) {
        const loc = page.getByRole("link", {name: re}).first();
        if (await loc.isVisible({timeout: 600}).catch(() => false)) {
            await loc.click({force: true}).catch(() => {});
            return true;
        }
        const btn = page.getByRole("button", {name: re}).first();
        if (await btn.isVisible({timeout: 400}).catch(() => false)) {
            await btn.click({force: true}).catch(() => {});
            return true;
        }
    }
    return false;
}
