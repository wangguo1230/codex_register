// @ts-nocheck
/**
 * 基于浏览器自动化的 ChatGPT 注册(真 Chrome，过 Cloudflare)。
 * 依据 Chrome Recorder 录制的 chatgpt.com/auth/login 流程:
 *   邮箱 → [可选密码] → 邮箱验证码(mailcom取) → 资料(全名/年龄) → 关引导弹窗 → 拿 session token
 * 与 HTTP 注册(authRegisterHTTP + sentinel)互补:真浏览器行为最像真人、不碰 sentinel/TLS 指纹。
 *
 * 选择器策略:语言无关优先(#email / autocomplete=one-time-code / data-testid),中英文可访问名兜底。
 * 界面语言默认跟随 locale;录制是中文,这里 zh-CN。
 */
import {chromium} from "playwright-core";
import {getEmailVerificationCode} from "./mailbox.js";
import {generateTotpCandidates, isMfaContinueUrl} from "./mfa.js";
import {chatOnPage} from "./simulate-chat.js";
import {googleLogin, isOnGoogleLoginPage} from "./mail/google-auth.js";
import {resolveGoogleCred} from "./mail/google-account.js";

const AUTH_URL = "https://chatgpt.com/auth/login";

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

const NAMES = ["Alex", "Jordan", "Taylor", "Morgan", "Casey", "Riley", "Jamie", "Avery", "Quinn", "Skyler"];
const rand = (arr) => arr[Math.floor(Math.random() * arr.length)];

// 点"继续/下一步"类主按钮(中英文 + 提交按钮兜底)
async function clickContinue(page, log) {
    // 去掉 form button.last() 危险兜底(会点错按钮触发 GET ?email=);逐个 try 且【等按钮变 enabled】再点
    // (邮箱填完 React onChange 未跟上时按钮 disabled，直接跳过会导致没点到正确的继续按钮)。
    // ★ 邮箱页有多个含"继续"的按钮(使用 Google/Apple/电话 账户继续,都是 type=button)。
    //   真正的提交是 type="submit"(社交登录是 type=button) → 优先 submit;文本兜底用【精确】/^继续$/(不匹配"使用X账户继续")。
    const tries = [
        () => page.locator('[data-testid="login-form"] button[type="submit"]').first(),
        () => page.locator('form button[type="submit"]').first(),
        () => page.getByRole("button", {name: /^\s*(继续|Continue|Continuer|下一步|Next|Verify|Confirm|Submit|Volgende|Bevestigen|Continuar|Avançar|Verificar|Finaliser)\s*$/i}).first(),
    ];
    // 轮询等继续按钮出现并可点(~18s):慢代理下页面/按钮渲染晚,多等;页面可能 A/B 切换/重渲染,只即时查一次会 count=0 漏掉。
    for (let round = 0; round < 8; round += 1) {
        for (let idx = 0; idx < tries.length; idx += 1) {
            try {
                const b = tries[idx]();
                if (await b.count() && await b.isVisible().catch(() => false) && await b.isEnabled().catch(() => false)) {
                    const txt = (await b.innerText().catch(() => "")).replace(/\s+/g, " ").trim().slice(0, 16);
                    await b.click({timeout: 4000});
                    await page.waitForTimeout(400);
                    log(`点继续(round${round} try${idx} "${txt}") → url=${page.url().slice(0, 70)}`);
                    return true;
                }
            } catch { /* next */ }
        }
        await page.waitForTimeout(400);
    }
    log("⚠️ 未找到可点的继续按钮(3s 内按钮未出现/不可点)");
    return false;
}

// 账号被 OpenAI 停用/删除的检测:命中则抛【不可重试】错误(重跑注定失败,别浪费接码/时间)
class DeactivatedError extends Error {}
async function checkDeactivated(page) {
    const body = (await page.innerText("body").catch(() => "")).replace(/\s+/g, " ");
    if (/account_deactivated|账户已被删除或停用|已被删除或停用|deleted or deactivated|account.{0,6}deactivated/i.test(body)) {
        throw new DeactivatedError("账号已停用/删除(account_deactivated)，勿重试");
    }
}

// 找可见输入框(多选择器兜底)
async function fillField(page, selectors, value, log, label) {
    for (const sel of selectors) {
        try {
            const el = typeof sel === "function" ? sel() : page.locator(sel).first();
            if (await el.count() && await el.isVisible().catch(() => false)) {
                await el.click({timeout: 3000}).catch(() => {});
                await el.fill(value, {timeout: 4000});
                return true;
            }
        } catch { /* next */ }
    }
    log(`⚠️ 未找到输入框: ${label}`);
    return false;
}

async function fillOtpCode(page, code, log) {
    const digits = String(code || "").replace(/\D/g, "").slice(0, 6);
    if (digits.length !== 6) return false;
    const boxes = page.locator('input[autocomplete="one-time-code"], input[name="code"], input[name="otp"], input[inputmode="numeric"], input[maxlength="1"]');
    const n = await boxes.count().catch(() => 0);
    const visible = [];
    for (let i = 0; i < n; i++) {
        const el = boxes.nth(i);
        if (await el.isVisible().catch(() => false)) visible.push(el);
    }
    if (visible.length >= 6) {
        for (let i = 0; i < 6; i++) {
            await visible[i].click({timeout: 2000}).catch(() => {});
            await visible[i].fill(digits[i], {timeout: 2000}).catch(() => {});
        }
        log(`验证码按 6 格填入 ${digits}`);
        return true;
    }
    return fillField(page, [
        'input[autocomplete="one-time-code"]',
        'input[name="code"]',
        'input[name="otp"]',
        'input[name="totpPin"]',
    ], digits, log, "验证码");
}

/**
 * @param email 注册邮箱
 * @param opts {password, proxyUrl, headless, log}
 * @returns {ok, token?, session?, cookies?, error?}
 */
function isGmailAddress(email) {
    return /@(gmail|googlemail)\.com$/i.test(String(email || ""));
}

async function tryGoogleSso(page, email, log) {
    const popupWait = page.waitForEvent("popup", {timeout: 10000}).catch(() => null);
    const btns = [
        page.getByRole("button", {name: /使用 Google 账户继续|Continue with Google/i}).first(),
        page.locator("button, a").filter({hasText: /使用 Google 账户继续|Continue with Google/i}).first(),
    ];
    let clicked = false;
    for (const b of btns) {
        if (await b.isVisible({timeout: 2500}).catch(() => false)) {
            await b.click();
            clicked = true;
            log("点击「使用 Google 账户继续」");
            break;
        }
    }
    if (!clicked) {
        popupWait.catch(() => {});
        return false;
    }
    const popup = await popupWait;
    const authPage = popup || page;
    await authPage.waitForTimeout(2500);

    if (await isOnGoogleLoginPage(authPage)) {
        let cred = {email, password: "", totpSecret: "", recoveryEmail: ""};
        try { cred = resolveGoogleCred(email); } catch { /* 没有池就只点已登录会话 */ }
        log("Google SSO 需要登录");
        const ok = await googleLogin(authPage, {
            email: cred.email || email,
            password: cred.password,
            totpSecret: cred.totpSecret,
            recoveryEmail: cred.recoveryEmail,
            log,
        });
        if (!ok) return false;
    }

    for (let pick = 0; pick < 3; pick++) {
        const picker = authPage.locator(`[data-identifier="${email}"], [data-email="${email}"]`).first();
        const byText = authPage.getByText(email, {exact: false}).first();
        if (await picker.isVisible({timeout: 1500}).catch(() => false)) {
            await picker.click({force: true});
            log(`Google 账号选择: ${email}`);
            await authPage.waitForTimeout(2500);
            break;
        }
        if (await byText.isVisible({timeout: 1200}).catch(() => false)) {
            await byText.click({force: true}).catch(() => {});
            log(`Google 账号选择(文本): ${email}`);
            await authPage.waitForTimeout(2500);
            break;
        }
        await authPage.waitForTimeout(1000);
    }

    for (const name of [/Continue|继续|Allow|允许|Confirm|确认|İleri|Sıradaki|Siguiente|Lanjut/i]) {
        const b = authPage.getByRole("button", {name}).first();
        if (await b.isVisible({timeout: 1200}).catch(() => false)) {
            await b.click({force: true}).catch(() => {});
            await authPage.waitForTimeout(1500);
        }
    }

    for (let i = 0; i < 18; i++) {
        await page.waitForTimeout(2000);
        const u = page.url();
        const au = authPage.url();
        if (/chatgpt\.com/i.test(u) && !/auth\/login/i.test(u)) {
            log(`Google SSO 已进入 ChatGPT: ${u.slice(0, 60)}`);
            return true;
        }
        if (/about-you/i.test(u + au)) {
            log("Google SSO 进入资料页");
            return true;
        }
        if (/email-verification|create-account\/password/i.test(u)) {
            log("Google SSO 后回到邮箱验证/设密，走原流程");
            return false;
        }
        if (/accountchooser/i.test(au) && i % 3 === 0) {
            await authPage.getByText(email, {exact: false}).first().click({force: true}).catch(() => {});
        }
        if (await page.locator('input[type="password"]').first().isVisible().catch(() => false)) {
            log("Google SSO 之后出现密码页，回退原流程");
            return false;
        }
    }
    log(`Google SSO 未进主站(page=${page.url().slice(0, 70)})`);
    return false;
}

export async function registerViaBrowser(email, {password = "", totpSecret = "", proxyUrl = "", headless = false, chatMessage = "", cdpEndpoint = "", preferGoogleSso = false, log = () => {}} = {}) {
    let browser, ctx;
    // 信号清理:worker 被 kill 时确保 Chrome 进程不泄漏(同步 kill Chrome 进程,不走 async close)
    const cleanup = () => {
        try { const p = browser?.process?.(); if (p?.pid) process.kill(p.pid, "SIGKILL"); } catch {}
        process.exit(1);
    };
    process.on("SIGTERM", cleanup);
    process.on("SIGINT", cleanup);
    if (cdpEndpoint) {
        browser = await chromium.connectOverCDP(cdpEndpoint);
        ctx = browser.contexts()[0] || await browser.newContext();
        log("已连接比特浏览器窗口(独立指纹+代理)");
    } else {
        const launchOpts: any = {channel: "chrome", headless, args: ["--disable-blink-features=AutomationControlled"]};
        const po = parseProxyOpt(proxyUrl);
        if (po) launchOpts.proxy = po;
        browser = await chromium.launch(launchOpts);
        ctx = await browser.newContext({locale: "zh-CN", viewport: {width: 1280, height: 860}});
    }
    try {
        const page = ctx.pages()[0] || await ctx.newPage();
        page.setDefaultTimeout(30000);
        page.on("dialog", (d) => { d.accept().catch(() => {}); });

        log(`打开 ${AUTH_URL}`);
        // 代理不稳(机房 IP 对 chatgpt 偶发 ERR_CONNECTION_CLOSED) → 打开失败重试
        let opened = false;
        for (let i = 0; i < 3 && !opened; i += 1) {
            try { await page.goto(AUTH_URL, {waitUntil: "domcontentloaded", timeout: 60000}); opened = true; }
            catch (e: any) { log(`打开失败(${String(e?.message ?? e).slice(0, 50)})，重试 ${i + 1}/3`); await page.waitForTimeout(3000); }
        }
        if (!opened) throw new Error("多次打开 auth/login 失败(代理/网络不稳，ERR_CONNECTION_CLOSED)");
        const useGoogleSso = !!preferGoogleSso;
        if (useGoogleSso) {
            await page.waitForTimeout(2500);
            if (await tryGoogleSso(page, email, log)) {
                // 已进主站，后面走拿 token
            }
        }
        // 填邮箱 + 点继续，降级时重载页面重试(最多 3 轮)
        const LOGIN_MAX_RETRY = 3;
        const alreadyIn = /^https:\/\/chatgpt\.com\/?($|\?|#)/.test(page.url()) && !/auth\/login/.test(page.url());
        for (let loginAttempt = 0; loginAttempt < LOGIN_MAX_RETRY && !alreadyIn; loginAttempt++) {
            // 邮箱框出来再短等 hydrate。CF 挑战先等它自己过，不要 15s 就扔。
            const emailEl = page.locator("#email, input[type='email'], input[name='email']").first();
            let sawEmail = false;
            for (let w = 0; w < 20 && !sawEmail; w++) {
                if (await emailEl.isVisible().catch(() => false)) { sawEmail = true; break; }
                if (w === 8) {
                    log("登录页还没有邮箱框，刷新一次等 CF…");
                    await page.reload({waitUntil: "domcontentloaded", timeout: 30000}).catch(() => {});
                }
                await page.waitForTimeout(800);
            }
            if (!sawEmail) {
                if (loginAttempt < LOGIN_MAX_RETRY - 1) {
                    log(`邮箱输入框未出现(url=${page.url().slice(0, 60)})，重载重试`);
                    await page.goto(AUTH_URL, {waitUntil: "domcontentloaded", timeout: 60000}).catch(() => {});
                    continue;
                }
                throw new Error(`邮箱输入框未出现(可能被 CF 拦，url=${page.url().slice(0, 60)})`);
            }
            for (let w = 0; w < 6 && await emailEl.isDisabled().catch(() => false); w++) await page.waitForTimeout(300);
            await page.waitForTimeout(500);
            await emailEl.click({force: true});
            await emailEl.pressSequentially(email, {delay: 15});
            await page.waitForTimeout(300);
            if ((await emailEl.inputValue().catch(() => "")).trim().toLowerCase() !== email.toLowerCase()) {
                await emailEl.fill("");
                await emailEl.pressSequentially(email, {delay: 60});
                await page.waitForTimeout(600);
            }
            log(`填邮箱 ${email}(实际 value=${(await emailEl.inputValue().catch(() => "")).slice(0, 40)})，提交`);
            if (!await clickContinue(page, log)) {
                await emailEl.press("Enter").catch(() => {});
            }
            await page.waitForURL(
                (u) => /email-verification|about-you|create-account|mfa-challenge|chatgpt\.com\/?($|\?|#)/i.test(String(u)),
                {timeout: 8000},
            ).catch(() => {});
            // 兜底:若点继续触发了浏览器原生 GET 提交(仍在 login 页、未出现验证码/密码框) → 此时 React 已 hydrate,重填邮箱重点一次
            if (/email-verification|about-you|create-account|mfa-challenge/i.test(page.url())) break;
            await page.waitForTimeout(600);
            if (/auth\/login/.test(page.url()) && !(await page.locator('input[autocomplete="one-time-code"], input[type="password"]').first().isVisible().catch(() => false))) {
                const el2 = page.locator("#email, input[type='email']").first();
                if (await el2.isVisible().catch(() => false)) {
                    log("疑似原生 GET 提交(仍在 login)，React 已就绪，重填邮箱重点继续…");
                    await el2.click().catch(() => {});
                    await el2.fill("").catch(() => {});
                    await el2.pressSequentially(email, {delay: 30}).catch(() => {});
                    await page.waitForTimeout(400);
                    await clickContinue(page, log);
                }
            }
            await page.waitForTimeout(600);
            const stillOnLogin = /auth\/login/.test(page.url())
                && !(await page.locator('input[autocomplete="one-time-code"], input[type="password"]').first().isVisible().catch(() => false))
                && /Continue with (Google|Apple|phone)|使用\s*(Google|Apple|电话)|Log in or sign up|登录或注册/i.test((await page.innerText("body").catch(() => "")).replace(/\s+/g, " "));
            if (!stillOnLogin) break;
            if (useGoogleSso && await tryGoogleSso(page, email, log)) break;
            if (loginAttempt < LOGIN_MAX_RETRY - 1) {
                log(`降级为原生表单(第 ${loginAttempt + 1}/${LOGIN_MAX_RETRY} 次)，重载页面重试…`);
                await page.goto(AUTH_URL, {waitUntil: "domcontentloaded", timeout: 60000}).catch(() => {});
            } else {
                throw new Error("出口 IP 被 chatgpt 降级为原生表单(重试 " + LOGIN_MAX_RETRY + " 次仍失败)，此 IP 注册走不通 → 换 IP 重跑");
            }
        }

        // 2) 等下一页出现:验证码框 / 密码框 / 已登录(已注册号密码登录可能免 OTP)。轮询 ~20s,兼容注册/登录/慢渲染。
        const codeSel = 'input[autocomplete="one-time-code"], input[name="code"], input[name="otp"], input[name="totpPin"]';
        const pwSel = 'input[type="password"]';
        const detect = async () => {
            const u = page.url();
            if (/^https:\/\/chatgpt\.com\/?($|\?|#)/.test(u) && !/auth\/login/.test(u)) return "loggedin";
            if (isMfaContinueUrl(u)) return "totp";
            if (/email-verification/i.test(u)) return "code";
            if (/create-account\/password|password\/verify|password/i.test(u) && await page.locator(pwSel).first().isVisible().catch(() => false)) return "password";
            if (/auth\/login/i.test(u)) return ""; // 登录首页不要把杂输入框当成验证码
            if (await page.locator(pwSel).first().isVisible().catch(() => false)) return "password";
            if (await page.locator(codeSel).first().isVisible().catch(() => false)) return totpSecret ? "totp" : "code";
            return "";
        };
        async function trySwitchToPassword() {
            if (!password) return false;
            const tries = [
                () => page.getByRole("link", {name: /使用密码|用密码|Log in with password|Use (a )?password|Continue with password/i}),
                () => page.getByRole("button", {name: /使用密码|用密码|Log in with password|Use (a )?password|Continue with password/i}),
                () => page.locator("a, button").filter({hasText: /使用密码|用密码登录|Log in with password|Use (a )?password instead|Continue with password/i}),
            ];
            for (const get of tries) {
                try {
                    const el = get().first();
                    if (await el.count() && await el.isVisible().catch(() => false)) {
                        const txt = (await el.innerText().catch(() => "")).replace(/\s+/g, " ").trim().slice(0, 40);
                        await el.click({timeout: 4000});
                        log(`邮箱验证页改走密码登录("${txt}")`);
                        return true;
                    }
                } catch { /* next */ }
            }
            return false;
        }
        let stage = "";
        for (let i = 0; i < 8 && !stage; i++) { await page.waitForTimeout(800); stage = await detect(); }
        // 仅已有账号的验证页才改走密码；新号创建必须走邮箱 OTP，不能先点「用密码继续」把验证码框弄没
        const bodyNow = (await page.innerText("body").catch(() => "")).replace(/\s+/g, " ");
        if (stage === "code" && password && /log in with password|use (a )?password|使用密码|已有.*密码/i.test(bodyNow) && !/create-account|create a password|创建密码/i.test(bodyNow + page.url())) {
            if (await trySwitchToPassword()) {
                stage = "";
                for (let i = 0; i < 8 && !stage; i++) { await page.waitForTimeout(1500); stage = await detect(); }
            }
        }

        // 密码页(全新号设密码 / 已注册号密码登录)→ 填统一密码 → 再等验证码框/登录
        if (stage === "password") {
            if (!password) throw new Error("出现密码页但未提供密码");
            log("检测到密码页，填密码");
            // 密码框同邮箱:必须逐字 pressSequentially 触发 React onChange,否则 fill 设的值被受控组件清空→继续按钮 disabled、提示"密码必须12字符"
            const pwEl = page.locator(pwSel).first();
            await pwEl.click().catch(() => {});
            await pwEl.fill("").catch(() => {});
            await pwEl.pressSequentially(password, {delay: 40});
            await pwEl.press("Tab").catch(() => {}); // 触发 blur/校验,让"继续"按钮 enable
            await page.waitForTimeout(1200);
            await clickContinue(page, log);
            // 密码提交后【等离开 create-account/password 页】(比特英文+慢代理跳转慢);还在则中途再点一次继续。
            // 不能一看到"密码框还在"就判失败——那只是还没跳转,给足时间。
            stage = "";
            for (let i = 0; i < 12 && !stage; i += 1) {
                await page.waitForTimeout(2000);
                if (/create-account\/password/i.test(page.url())) { if (i === 5) { log("密码页未跳转,再次点继续…"); await clickContinue(page, log); } continue; }
                stage = (await detect()) || (totpSecret ? "totp" : "code");
            }
        }

        const isLoggedIn = () => /^https:\/\/chatgpt\.com/.test(page.url()) && !/auth\/login/.test(page.url());
        async function handleTotp() {
            if (!isMfaContinueUrl(page.url()) && stage !== "totp") return false;
            if (!totpSecret) {
                log("出现 2FA 页但无 TOTP secret，回退邮箱验证");
                return false;
            }
            const codes = generateTotpCandidates(totpSecret);
            log(`检测到 2FA，填 TOTP(url=${page.url().slice(0, 70)})`);
            for (let i = 0; i < codes.length && !isLoggedIn(); i++) {
                if (i) log(`TOTP 未过，试下一窗(${i + 1}/${codes.length})`);
                if (!await fillField(page, [codeSel, 'input[autocomplete="one-time-code"]'], codes[i], log, "TOTP")) break;
                await clickContinue(page, log);
                for (let w = 0; w < 8; w += 1) {
                    await page.waitForTimeout(2000);
                    if (isLoggedIn() || !isMfaContinueUrl(page.url())) break;
                }
                if (!isMfaContinueUrl(page.url())) break;
            }
            return isLoggedIn() || !isMfaContinueUrl(page.url());
        }
        if (stage === "totp") {
            await handleTotp();
            stage = isLoggedIn() ? "loggedin" : ((await detect()) || "code");
        }

        // 3) 验证码页 → 取码填入;验证失败(旧码残留/慢)则【排除旧码重取新码】重试(重跑已注册号邮箱有旧 OTP,易填旧码)
        if (stage === "code") {
            for (let i = 0; i < 12; i++) {
                if (/email-verification/i.test(page.url()) || await page.locator(codeSel).first().isVisible().catch(() => false)) break;
                await page.waitForTimeout(1000);
            }
            if (!/email-verification/i.test(page.url()) && !await page.locator(codeSel).first().isVisible().catch(() => false)) {
                throw new Error(`未进入邮箱验证码页(url=${page.url().slice(0, 80)})`);
            }
            let codeOk = false, lastCode = "";
            for (let ctry = 0; ctry < 2 && !codeOk; ctry += 1) {
                log(`从 mailcom 取邮箱验证码… url=${page.url().slice(0, 80)}`);
                const code = await getEmailVerificationCode(email, lastCode ? {excludeCode: lastCode} : undefined);
                lastCode = code;
                log(`收到验证码 ${code}，填入`);
                if (!await fillOtpCode(page, code, log)) throw new Error("验证码输入框未找到");
                await page.waitForTimeout(1500);
                const oops = page.getByRole("button", {name: /try again|重试|tente novamente/i}).first();
                if (await oops.isVisible({timeout: 800}).catch(() => false)
                    || /oops, an error|invalid content type|route error/i.test(await page.innerText("body").catch(() => ""))) {
                    log("验证码页出现 OpenAI Route Error，点 Try again 后重来");
                    await oops.click({force: true}).catch(() => {});
                    await page.waitForTimeout(2000);
                    continue;
                }
                if (/email-verification/i.test(page.url())) {
                    const submit = page.locator('form button[type="submit"], button[type="submit"]').first();
                    if (await submit.isVisible().catch(() => false) && await submit.isEnabled().catch(() => false)) {
                        await submit.click({timeout: 4000}).catch(() => {});
                    } else {
                        await clickContinue(page, log);
                    }
                }
                // 等待离开验证页: about-you / 主站都算过。最多 ~30s。
                for (let w = 0; w < 15 && !codeOk; w += 1) {
                    await page.waitForTimeout(2000);
                    await checkDeactivated(page);
                    const u = page.url();
                    codeOk = isLoggedIn() || /about-you|chatgpt\.com\/($|\?|#)/i.test(u) || !/email-verification/i.test(u);
                    if (w === 5 && !codeOk) {
                        log("验证码页未跳转，再点一次继续");
                        try {
                            const {mkdirSync} = await import("node:fs");
                            const {default: pathMod} = await import("node:path");
                            const dir = pathMod.resolve(process.cwd(), "captures", "screenshots");
                            mkdirSync(dir, {recursive: true});
                            await page.screenshot({path: pathMod.join(dir, `otp_${Date.now()}.png`)});
                        } catch { /* ignore */ }
                        await clickContinue(page, log);
                    }
                }
                if (!codeOk && ctry === 0) log("验证仍未通过(疑旧码/错码/页面慢)，排除旧码重取新码重试…");
            }
            if (!codeOk) throw new Error("邮箱验证码多次验证失败(可能旧码残留/接码问题/页面慢)");
            // 邮箱 OTP 通过后常跳到 /mfa-challenge，这里再填 TOTP
            if (!isLoggedIn() && isMfaContinueUrl(page.url())) await handleTotp();
        } else if (stage === "loggedin") {
            log("提交邮箱后已直接登录(免 OTP)，跳到拿 token");
        } else {
            const body = (await page.innerText("body").catch(() => "")).replace(/\s+/g, " ").slice(0, 200);
            throw new Error(`提交邮箱后未进验证码/密码/登录页(url=${page.url().slice(0, 60)}) 页面:${body}`);
        }

        // 4) 资料页(全名 + 年龄 或 全名 + 生日):仅【全新号注册】有;已注册号登录路径无资料页 → 已登录则跳过
        await page.waitForTimeout(1500);
        if (!isLoggedIn() && isMfaContinueUrl(page.url())) await handleTotp();
        if (!isLoggedIn() && !isMfaContinueUrl(page.url())) {
            const name = rand(NAMES) + " " + rand(NAMES);
            const age = String(18 + Math.floor(Math.random() * 22));
            const birthYear = String(2008 - Math.floor(Math.random() * 20)); // 18-37 岁（相对 2026）
            const birthMonth = String(1 + Math.floor(Math.random() * 12));
            const birthDay = String(1 + Math.floor(Math.random() * 28));
            const nameSel = [() => page.getByLabel(/全名|Full name|name/i).first(), 'input[name*="name" i]', 'input[autocomplete="name"]'];
            const ageSel = [() => page.getByLabel(/年龄|Age|old/i).first(), 'input[name*="age" i]', 'input[type="number"]', 'input[inputmode="numeric"]'];

            let filled = false;
            for (let t = 0; t < 4 && !filled; t += 1) {
                const nameOk = await fillField(page, nameSel, name, log, "全名");

                // 检测页面类型：年龄 input 还是生日(select/date)
                // type=number + React Aria 受控组件需要逐字符输入，fill() 不触发 React 状态更新
                let ageOk = false;
                for (const sel of ageSel) {
                    try {
                        const el = typeof sel === "function" ? sel() : page.locator(sel).first();
                        if (await el.count() && await el.isVisible().catch(() => false)) {
                            await el.click({timeout: 3000}).catch(() => {});
                            await el.fill("");
                            await el.pressSequentially(age, {delay: 50});
                            await el.press("Tab").catch(() => {});
                            ageOk = true; break;
                        }
                    } catch { /* next */ }
                }

                if (!ageOk) {
                    // 尝试生日模式：select[name*=month/day/year] 或 input[type=date] 或多个 select
                    const monthSel = page.locator('select[name*="month" i], select[id*="month" i], select[aria-label*="Month" i], select[aria-label*="月" i]').first();
                    const daySel = page.locator('select[name*="day" i], select[id*="day" i], select[aria-label*="Day" i], select[aria-label*="日" i]').first();
                    const yearSel = page.locator('select[name*="year" i], select[id*="year" i], select[aria-label*="Year" i], select[aria-label*="年" i]').first();
                    const dateInput = page.locator('input[type="date"]').first();

                    if (await monthSel.isVisible().catch(() => false)) {
                        // 生日下拉模式
                        try {
                            await monthSel.selectOption({index: Number(birthMonth)}).catch(() => monthSel.selectOption(birthMonth));
                            if (await daySel.isVisible().catch(() => false))
                                await daySel.selectOption({index: Number(birthDay)}).catch(() => daySel.selectOption(birthDay));
                            if (await yearSel.isVisible().catch(() => false))
                                await yearSel.selectOption(birthYear).catch(() => yearSel.selectOption({index: 20}));
                            ageOk = true;
                            log(`生日(下拉) ${birthYear}-${birthMonth}-${birthDay}`);
                        } catch (e) { log(`生日下拉填写异常: ${String(e?.message || e).slice(0, 80)}`); }
                    } else if (await dateInput.isVisible().catch(() => false)) {
                        // input[type=date] 模式
                        try {
                            await dateInput.fill(`${birthYear}-${birthMonth.padStart(2, "0")}-${birthDay.padStart(2, "0")}`);
                            ageOk = true;
                            log(`生日(date input) ${birthYear}-${birthMonth}-${birthDay}`);
                        } catch (e) { log(`生日 input 填写异常: ${String(e?.message || e).slice(0, 80)}`); }
                    } else {
                        // 兜底：查看所有 select，尝试作为生日填写
                        const selects = await page.locator("select").all();
                        const visSelects = [];
                        for (const s of selects) if (await s.isVisible().catch(() => false)) visSelects.push(s);
                        if (visSelects.length >= 2) {
                            try {
                                await visSelects[0].selectOption({index: Number(birthMonth)}).catch(() => {});
                                if (visSelects.length >= 3) {
                                    await visSelects[1].selectOption({index: Number(birthDay)}).catch(() => {});
                                    await visSelects[2].selectOption(birthYear).catch(() => visSelects[2].selectOption({index: 20}));
                                } else {
                                    await visSelects[1].selectOption(birthYear).catch(() => visSelects[1].selectOption({index: 20}));
                                }
                                ageOk = true;
                                log(`生日(兜底 select×${visSelects.length}) ${birthYear}-${birthMonth}-${birthDay}`);
                            } catch { /* */ }
                        }
                    }
                }

                if (!ageOk) {
                    // React Aria combobox：Month / Day / Year，不是原生 select
                    const combos = page.getByRole("combobox");
                    const cn = await combos.count().catch(() => 0);
                    if (cn >= 3) {
                        const months = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
                        const vals = [months[Number(birthMonth) - 1] || birthMonth, birthDay, birthYear];
                        try {
                            for (let i = 0; i < 3; i++) {
                                const box = combos.nth(i);
                                await box.click({timeout: 3000});
                                await page.waitForTimeout(250);
                                await page.keyboard.type(String(vals[i]), {delay: 30});
                                await page.keyboard.press("Enter");
                                await page.waitForTimeout(200);
                            }
                            ageOk = true;
                            log(`生日(combobox) ${birthYear}-${birthMonth}-${birthDay}`);
                        } catch (e) { log(`生日 combobox 异常: ${String(e?.message || e).slice(0, 80)}`); }
                    }
                }

                if (!ageOk) {
                    const months = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
                    const monthName = months[Number(birthMonth) - 1] || "January";
                    const pickers = [
                        [/^(month|月)$/i, monthName],
                        [/^(day|日)$/i, birthDay],
                        [/^(year|年)$/i, birthYear],
                    ];
                    let picked = 0;
                    for (const [lab, val] of pickers) {
                        const btn = page.getByRole("button", {name: lab}).or(page.getByRole("combobox", {name: lab})).first();
                        if (!await btn.isVisible({timeout: 500}).catch(() => false)) continue;
                        await btn.click({force: true}).catch(() => {});
                        await page.waitForTimeout(300);
                        const opt = page.getByRole("option", {name: new RegExp(`^\\s*${val}\\s*$`, "i")}).first();
                        if (await opt.isVisible({timeout: 1500}).catch(() => false)) {
                            await opt.click({force: true}).catch(() => {});
                            picked += 1;
                        } else {
                            await page.keyboard.type(String(val), {delay: 20});
                            await page.keyboard.press("Enter");
                            picked += 1;
                        }
                        await page.waitForTimeout(200);
                    }
                    if (picked >= 3) {
                        ageOk = true;
                        log(`生日(listbox) ${birthYear}-${birthMonth}-${birthDay}`);
                    } else {
                        let labeled = 0;
                        for (const [lab, val] of [["month", birthMonth], ["day", birthDay], ["year", birthYear], ["月", birthMonth], ["日", birthDay], ["年", birthYear]]) {
                            const el = page.getByLabel(new RegExp(`^${lab}$`, "i")).first();
                            if (await el.isVisible({timeout: 400}).catch(() => false)) {
                                await el.click().catch(() => {});
                                await el.fill("").catch(() => {});
                                await el.pressSequentially(String(val), {delay: 30}).catch(() => {});
                                labeled += 1;
                            }
                        }
                        if (labeled >= 3) {
                            ageOk = true;
                            log(`生日(label) ${birthYear}-${birthMonth}-${birthDay}`);
                        }
                    }
                }

                if (!ageOk) {
                    // 最后兜底：第2个可见 input 当年龄填
                    const inputs = await page.locator("input").all();
                    const vis = [], info = [];
                    for (const el of inputs) {
                        if (!await el.isVisible().catch(() => false)) continue;
                        vis.push(el);
                        info.push(await el.evaluate((n: any) => ({type: n.type, name: n.name, ph: n.placeholder, al: n.getAttribute("aria-label"), im: n.inputMode})).catch(() => ({})));
                    }
                    if (t === 0) log(`资料页可见 input(${vis.length}): ${JSON.stringify(info).slice(0, 260)}`);
                    if (vis.length >= 2) { try { await vis[1].click(); await vis[1].fill(""); await vis[1].pressSequentially(age, {delay: 40}); await vis[1].press("Tab").catch(() => {}); ageOk = true; log("年龄用第2个可见 input 兜底填入"); } catch { /* */ } }
                }

                filled = nameOk && ageOk;
                if (!filled) { log(`资料字段未齐(全名=${nameOk} 年龄/生日=${ageOk})，等待渲染重试(${t + 1}/4)…`); await page.waitForTimeout(2500); }
            }
            log(`填资料 name=${name} age/birthday=${age}/${birthYear}-${birthMonth}-${birthDay}${filled ? "" : "(⚠️未完全填上)"}`);
            await page.keyboard.press("Enter").catch(() => {});
            await clickContinue(page, log);
        }

        // 等进主站，最多 ~18s；中途再推一次提交
        for (let i = 0; i < 12 && !isLoggedIn(); i += 1) {
            if (isMfaContinueUrl(page.url()) && totpSecret) { await handleTotp(); continue; }
            if (i === 4) { log("尚未进入主界面，再次尝试提交(Enter+继续)…"); await page.keyboard.press("Enter").catch(() => {}); await clickContinue(page, log); }
            await page.waitForTimeout(1500);
        }
        if (!isLoggedIn()) await checkDeactivated(page); // 没进登录态,可能是账号停用页 → 抛不可重试
        if (!isLoggedIn() && /about-you/i.test(page.url())) {
            const about = (await page.innerText("body").catch(() => "")).replace(/\s+/g, " ").slice(0, 220);
            log(`资料页未过: ${about}`);
            try {
                const {mkdirSync} = await import("node:fs");
                const {default: pathMod} = await import("node:path");
                const dir = pathMod.resolve(process.cwd(), "captures", "screenshots");
                mkdirSync(dir, {recursive: true});
                await page.screenshot({path: pathMod.join(dir, `about_you_${Date.now()}.png`), fullPage: true});
            } catch { /* ignore */ }
        }
        log(isLoggedIn() ? `已进入登录态: ${page.url().slice(0, 45)}` : `⚠️ 仍未跳转到主界面(url=${page.url().slice(0, 45)})，仍尝试拿 token`);

        // 5) 【先拿 token】(注册主产物,优先保证入库)：资料提交/进主界面会触发导航,等稳再 evaluate /api/auth/session
        //    (直接 evaluate 会撞 "Execution context was destroyed, most likely because of a navigation" → 等稳 + 失败重试)
        await page.waitForLoadState("domcontentloaded").catch(() => {});
        await page.waitForTimeout(3000);
        let session = null;
        for (let i = 0; i < 6; i++) {
            try {
                session = await page.evaluate(async () => {
                    try { const r = await fetch("/api/auth/session", {headers: {accept: "application/json"}}); return await r.json(); } catch { return null; }
                });
                if (session && session.accessToken) break;
            } catch (e) { /* context destroyed(导航中) → 等一下重试 */ }
            await page.waitForTimeout(2000);
        }
        const token = session?.accessToken || "";
        const cookies = await ctx.cookies();
        if (!token) log(`⚠️ 未从 /api/auth/session 拿到 accessToken(session=${JSON.stringify(session).slice(0, 80)})`);
        else log(`✅ 注册完成，拿到 accessToken ${token.slice(0, 18)}…`);

        // 6) token 已拿到(入库有保证)【后】再养号:硬超时 90s——养号卡死(如聊天输入框被弹窗拦截)也不拖垮流程、不致重跑
        if (chatMessage && token) {
            try {
                log("拿到 token,当前页养号发消息…");
                await Promise.race([
                    chatOnPage(page, chatMessage, log),
                    new Promise((_, reject) => setTimeout(() => reject(new Error("养号超时(90s)")), 90000)),
                ]);
            } catch (e: any) { log("养号失败(不影响注册): " + (e?.message ?? e)); }
        } else if (!chatMessage) {
            for (let i = 0; i < 6; i++) {
                const btn = page.locator('dialog button, [role="dialog"] button').filter({hasText: /继续|Continue|Okay|Got it|开始|Start/i}).first();
                if (await btn.count() && await btn.isVisible().catch(() => false)) { await btn.click({timeout: 3000}).catch(() => {}); log("关引导弹窗"); await page.waitForTimeout(1500); }
                else break;
            }
        }
        return {ok: !!token, token, session, cookies, url: page.url()};
    } catch (e: any) {
        return {ok: false, error: String(e?.message ?? e)};
    } finally {
        process.removeListener("SIGTERM", cleanup);
        process.removeListener("SIGINT", cleanup);
        // 比特 CDP 不能 close：会把指纹窗口一起关掉
        if (!cdpEndpoint) {
            try { await browser.close(); } catch { /* ignore */ }
        }
    }
}
