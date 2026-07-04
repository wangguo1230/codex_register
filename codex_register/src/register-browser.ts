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
import {chatOnPage} from "./simulate-chat.js";

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
        () => page.getByRole("button", {name: /^\s*(继续|Continue|下一步|Next)\s*$/i}).first(),
    ];
    // 轮询等继续按钮出现并可点(~18s):慢代理下页面/按钮渲染晚,多等;页面可能 A/B 切换/重渲染,只即时查一次会 count=0 漏掉。
    for (let round = 0; round < 18; round += 1) {
        for (let idx = 0; idx < tries.length; idx += 1) {
            try {
                const b = tries[idx]();
                if (await b.count() && await b.isVisible().catch(() => false) && await b.isEnabled().catch(() => false)) {
                    const txt = (await b.innerText().catch(() => "")).replace(/\s+/g, " ").trim().slice(0, 16);
                    await b.click({timeout: 4000});
                    await page.waitForTimeout(1200);
                    log(`点继续(round${round} try${idx} "${txt}") → url=${page.url().slice(0, 70)}`);
                    return true;
                }
            } catch { /* next */ }
        }
        await page.waitForTimeout(1000);
    }
    log("⚠️ 未找到可点的继续按钮(12s 内按钮未出现/不可点)");
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

/**
 * @param email 注册邮箱
 * @param opts {password, proxyUrl, headless, log}
 * @returns {ok, token?, session?, cookies?, error?}
 */
export async function registerViaBrowser(email, {password = "", proxyUrl = "", headless = false, chatMessage = "", cdpEndpoint = "", log = () => {}} = {}) {
    // cdpEndpoint(比特浏览器窗口):连接已有【独立指纹+代理】窗口;否则 launch 临时 Chrome(旧方式,同机器指纹一致)
    let browser, ctx;
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

        log(`打开 ${AUTH_URL}`);
        // 代理不稳(机房 IP 对 chatgpt 偶发 ERR_CONNECTION_CLOSED) → 打开失败重试
        let opened = false;
        for (let i = 0; i < 3 && !opened; i += 1) {
            try { await page.goto(AUTH_URL, {waitUntil: "domcontentloaded", timeout: 60000}); opened = true; }
            catch (e: any) { log(`打开失败(${String(e?.message ?? e).slice(0, 50)})，重试 ${i + 1}/3`); await page.waitForTimeout(3000); }
        }
        if (!opened) throw new Error("多次打开 auth/login 失败(代理/网络不稳，ERR_CONNECTION_CLOSED)");
        // 等 React hydrate 完成:否则点"继续"会触发浏览器原生 GET 提交(url→?email=、reload 回 login),而非 SPA 进 OTP
        await page.waitForLoadState("networkidle", {timeout: 12000}).catch(() => {});
        await page.waitForTimeout(3500);

        // 1) 邮箱:【直接逐字 pressSequentially】触发 React onChange,确保 value 落地 + "继续"按钮激活。
        //    (fill 只设 DOM value、不触发 onChange,React 受控组件重渲染会用 state 清空 → value="",继续按钮一直 disabled)
        const emailEl = page.locator("#email, input[type='email'], input[name='email']").first();
        try { await emailEl.waitFor({state: "visible", timeout: 20000}); }
        catch { throw new Error(`邮箱输入框未出现(可能被 CF 拦，url=${page.url().slice(0, 60)})`); }
        await emailEl.click();
        await emailEl.pressSequentially(email, {delay: 30});
        await page.waitForTimeout(600);
        if ((await emailEl.inputValue().catch(() => "")).trim().toLowerCase() !== email.toLowerCase()) {
            await emailEl.fill("");
            await emailEl.pressSequentially(email, {delay: 60}); // 慢一点重试一次
            await page.waitForTimeout(600);
        }
        log(`填邮箱 ${email}(实际 value=${(await emailEl.inputValue().catch(() => "")).slice(0, 40)})，提交`);
        if (!await clickContinue(page, log)) {
            await emailEl.press("Enter").catch(() => {}); // 继续点不到则回车提交(SPA)
        }
        // 兜底:若点继续触发了浏览器原生 GET 提交(仍在 login 页、未出现验证码/密码框) → 此时 React 已 hydrate,重填邮箱重点一次(SPA 接管进 OTP)
        await page.waitForTimeout(2500);
        if (/auth\/login/.test(page.url()) && !(await page.locator('input[autocomplete="one-time-code"], input[type="password"]').first().isVisible().catch(() => false))) {
            const el2 = page.locator("#email, input[type='email']").first();
            if (await el2.isVisible().catch(() => false)) {
                log("疑似原生 GET 提交(仍在 login)，React 已就绪，重填邮箱重点继续…");
                await el2.click().catch(() => {});
                await el2.fill("").catch(() => {});
                await el2.pressSequentially(email, {delay: 30}).catch(() => {});
                await page.waitForTimeout(1200);
                await clickContinue(page, log);
            }
        }
        // 兜底重试后仍停在 login 首页(社交登录选项在、无 OTP/密码框)=出口 IP 被 chatgpt 降级成原生表单 → 快速失败(别白等),换 IP 重跑
        await page.waitForTimeout(2000);
        if (/auth\/login/.test(page.url())
            && !(await page.locator('input[autocomplete="one-time-code"], input[type="password"]').first().isVisible().catch(() => false))
            && /Continue with (Google|Apple|phone)|使用\s*(Google|Apple|电话)|Log in or sign up|登录或注册/i.test((await page.innerText("body").catch(() => "")).replace(/\s+/g, " "))) {
            throw new Error("出口 IP 被 chatgpt 降级为原生表单(停在登录首页、非 SPA)，此 IP 注册走不通 → 换 IP 重跑");
        }

        // 2) 等下一页出现:验证码框 / 密码框 / 已登录(已注册号密码登录可能免 OTP)。轮询 ~20s,兼容注册/登录/慢渲染。
        const codeSel = 'input[autocomplete="one-time-code"], input[name*="code" i], input[inputmode="numeric"]';
        const pwSel = 'input[type="password"]';
        const detect = async () => {
            if (/^https:\/\/chatgpt\.com\/?($|\?|#)/.test(page.url()) && !/auth\/login/.test(page.url())) return "loggedin";
            if (await page.locator(codeSel).first().isVisible().catch(() => false)) return "code";
            if (await page.locator(pwSel).first().isVisible().catch(() => false)) return "password";
            return "";
        };
        let stage = "";
        for (let i = 0; i < 15 && !stage; i++) { await page.waitForTimeout(2000); stage = await detect(); } // 加长:代理慢时页面进 OTP/密码页更久

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
                stage = (await detect()) || "code"; // 已离开密码页 → 重新判 stage(默认按验证码走)
            }
        }

        // 3) 验证码页 → 取码填入;验证失败(旧码残留/慢)则【排除旧码重取新码】重试(重跑已注册号邮箱有旧 OTP,易填旧码)
        const isLoggedIn = () => /^https:\/\/chatgpt\.com/.test(page.url()) && !/auth\/login/.test(page.url());
        if (stage === "code") {
            let codeOk = false, lastCode = "";
            for (let ctry = 0; ctry < 2 && !codeOk; ctry += 1) {
                log("从 mailcom 取邮箱验证码…");
                const code = await getEmailVerificationCode(email, lastCode ? {excludeCode: lastCode} : undefined);
                lastCode = code;
                log(`收到验证码 ${code}，填入`);
                if (!await fillField(page, [codeSel], code, log, "验证码")) throw new Error("验证码输入框未找到");
                await clickContinue(page, log);
                // 等待离开验证页(慢代理跳转慢,最多~16s):离开 email-verification 或已登录 = 验证通过。
                // ★ 不能用"验证码框是否可见"判断——codeSel 的 inputmode=numeric 会误匹配 about-you 的【年龄】框→把已通过误判成失败!
                for (let w = 0; w < 8 && !codeOk; w += 1) {
                    await page.waitForTimeout(2000);
                    await checkDeactivated(page); // 停用页 → 立即抛(不可重试)
                    codeOk = isLoggedIn() || !/email-verification/i.test(page.url());
                }
                if (!codeOk && ctry === 0) log("验证仍未通过(疑旧码/错码/页面慢)，排除旧码重取新码重试…");
            }
            if (!codeOk) throw new Error("邮箱验证码多次验证失败(可能旧码残留/接码问题/页面慢)");
        } else if (stage === "loggedin") {
            log("提交邮箱后已直接登录(免 OTP)，跳到拿 token");
        } else {
            const body = (await page.innerText("body").catch(() => "")).replace(/\s+/g, " ").slice(0, 200);
            throw new Error(`提交邮箱后未进验证码/密码/登录页(url=${page.url().slice(0, 60)}) 页面:${body}`);
        }

        // 4) 资料页(全名+年龄):仅【全新号注册】有;已注册号登录路径无资料页 → 已登录则跳过(避免找不到框空转、拿到空 token)
        await page.waitForTimeout(1500);
        if (!isLoggedIn()) {
            const name = rand(NAMES) + " " + rand(NAMES);
            const age = String(18 + Math.floor(Math.random() * 22));
            const nameSel = [() => page.getByLabel(/全名|Full name|name/i).first(), 'input[name*="name" i]', 'input[autocomplete="name"]'];
            const ageSel = [() => page.getByLabel(/年龄|Age|old/i).first(), 'input[name*="age" i]', 'input[type="number"]', 'input[inputmode="numeric"]'];
            // ★ 年龄框可能渲染晚(慢/英文环境),没填上→about-you 表单不完整→提交被拒卡住。填不齐就等待重试,确保 name+age 都填好再提交。
            let filled = false;
            for (let t = 0; t < 4 && !filled; t += 1) {
                const nameOk = await fillField(page, nameSel, name, log, "全名");
                let ageOk = await fillField(page, ageSel, age, log, "年龄");
                if (!ageOk) {
                    // 标准选择器找不到年龄框(英文版结构可能不同)→ ①dump 页面可见 input 结构(便于精修) ②兜底:第2个可见 input(通常 全名=1、年龄=2)
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
                if (!filled) { log(`资料字段未齐(全名=${nameOk} 年龄=${ageOk})，等待渲染重试(${t + 1}/4)…`); await page.waitForTimeout(2500); }
            }
            log(`填资料 name=${name} age=${age}${filled ? "" : "(⚠️未完全填上)"}`);
            await page.keyboard.press("Enter").catch(() => {});
            await clickContinue(page, log);
        }

        // 4.5) 等待真正进入登录态(chatgpt.com):慢代理下跳转慢,最多等 ~44s;中途(第16s)再推一次提交,
        //      避免"资料没提交成功却去拿 token"→拿到无 accessToken 的空 session→误判失败重跑。
        for (let i = 0; i < 22 && !isLoggedIn(); i += 1) {
            if (i === 8) { log("尚未进入主界面，再次尝试提交(Enter+继续)…"); await page.keyboard.press("Enter").catch(() => {}); await clickContinue(page, log); }
            await page.waitForTimeout(2000);
        }
        if (!isLoggedIn()) await checkDeactivated(page); // 没进登录态,可能是账号停用页 → 抛不可重试
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
        try { await browser.close(); } catch { /* ignore */ }
    }
}
