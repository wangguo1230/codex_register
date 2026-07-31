// @ts-nocheck
/**
 * 注册后模拟一次真实聊天(养号，降低"注册即封")。
 * 用 Playwright 真 Chrome 打开 chatgpt.com(注入注册后的登录 cookie)，发一条消息、等 AI 回复。
 * 真浏览器 + 真实 sentinel SDK 自然生成所有 token，无需逆向；行为也最像真人。
 *
 * chatOnPage 抽出为可复用:浏览器注册(register-browser)注册完在【当前 page】直接养号，免重开浏览器。
 */
import {chromium} from "playwright-core";

// 聊天默认 headed(有界面)——headless 会被 chatgpt 的 Cloudflare challenge 拦住。
// 无头服务器部署需配 xvfb 虚拟显示；设 CHAT_HEADLESS=1 可强制无头(大概率过不了 challenge)。
const HEADLESS = process.env.CHAT_HEADLESS === "1";

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

// 用 sessionToken 构造 __Secure-next-auth.session-token cookie(登录态)，超 3900 字符自动分片。
function buildSessionCookies(token) {
    const v = String(token || "").trim();
    if (!v) return [];
    const base = {domain: ".chatgpt.com", path: "/", httpOnly: true, secure: true, sameSite: "Lax"};
    if (v.length <= 3900) return [{name: "__Secure-next-auth.session-token", value: v, ...base}];
    const out = [];
    for (let i = 0; i < v.length; i += 3900) out.push({name: `__Secure-next-auth.session-token.${Math.floor(i / 3900)}`, value: v.slice(i, i + 3900), ...base});
    return out;
}

/**
 * 在【已登录 chatgpt 的 page】上发一条消息养号:关首登引导 → 找输入框 → 输入 → 发送 → 等 AI 回复。
 * 供 simulateChat(新开浏览器)和浏览器注册(复用当前 page)共用。返回 replied(bool)。
 */
export async function chatOnPage(page, message, log = (m: string) => {}) {
    // 找输入框：contenteditable 的 <div id="prompt-textarea" role="textbox">，绝不能选到隐藏的 fallback <textarea>。
    const inputSel = "#prompt-textarea, div.ProseMirror[contenteditable='true'], [contenteditable='true'][role='textbox']";
    const input = page.locator(inputSel).first();
    // 首登欢迎引导(You're all set → Continue / 继续 / Okay 等)会挡住输入框，且可能异步弹出、点击后有动画延迟。
    // 把"点引导"和"等输入框"放进同一循环——每轮先点掉引导再检查输入框，直到出现或超时(~90s)。
    const guideNames = [/^继续$/, /^Continue$/i, /Okay.*go/i, /^Okay/i, /Got it/i, /开始/, /Stay logged out/i, /^Next$/i, /^下一步$/, /Skip/i];
    // 找输入框(含点引导)。第一轮找不到 → 刷新页面重试一次(救页面加载不全/卡住的情况)。
    let ready = false;
    for (let attempt = 0; attempt < 2 && !ready; attempt += 1) {
        if (attempt > 0) {
            log("未找到聊天输入框，刷新页面重试一次…");
            await page.reload({waitUntil: "domcontentloaded"}).catch(() => {});
            await page.waitForTimeout(5000);
        }
        for (let i = 0; i < 22 && !ready; i += 1) {
            for (const name of guideNames) {
                try {
                    const byRole = page.getByRole("button", {name});
                    const byText = page.locator("button.btn-primary, dialog button, [role='dialog'] button").filter({hasText: name});
                    const btn = (await byRole.count()) ? byRole : byText;
                    if (await btn.count() && await btn.first().isVisible().catch(() => false)) {
                        await btn.first().click({timeout: 3000}).catch(() => {});
                        await page.waitForTimeout(1200);
                        log(`点掉引导: ${name}`);
                    }
                } catch { /* ignore，下一轮继续 */ }
            }
            try { await input.waitFor({state: "visible", timeout: 2500}); ready = true; }
            catch { /* 还没出现——引导可能刚弹出，继续循环 */ }
        }
    }
    if (!ready) {
        await page.screenshot({path: "/tmp/chat_debug.png", fullPage: true}).catch(() => {});
        const bodyText = (await page.innerText("body").catch(() => "")).replace(/\s+/g, " ").slice(0, 180);
        log(`找不到输入框，页面内容: ${bodyText}`);
        throw new Error(`输入框未出现(url=${page.url().slice(0, 50)})`);
    }
    // 网速慢时:输入框先渲染、引导弹窗(你已准备就绪 <dialog>)后弹出覆盖在上面(modal 会拦截点击) → 输入前再点掉迟到的弹窗
    for (let k = 0; k < 4; k++) {
        const dlg = page.locator('dialog[open] button, [role="dialog"] button').filter({hasText: /^\s*(继续|Continue|开始|Start|Okay|Got it)\s*$/i}).first();
        if (await dlg.count() && await dlg.isVisible().catch(() => false)) {
            await dlg.click({timeout: 3000}).catch(() => {});
            log("点掉迟到的引导弹窗(你已准备就绪)");
            await page.waitForTimeout(1500);
        } else break;
    }
    await input.waitFor({state: "visible", timeout: 5000}).catch(() => {}); // 弹窗关闭后重新确认输入框
    // 输入：ProseMirror 不认 fill()——聚焦后用 insertText 直接写入，并校验真的写进去了
    await input.click();
    await page.waitForTimeout(300);
    await page.keyboard.insertText(message).catch(async () => { await page.keyboard.type(message, {delay: 15}); });
    await page.waitForTimeout(500);
    let typed = (await input.innerText().catch(() => "")).trim();
    if (!typed) {
        await input.click();
        await page.keyboard.type(message, {delay: 25});
        await page.waitForTimeout(500);
        typed = (await input.innerText().catch(() => "")).trim();
    }
    if (!typed) throw new Error("消息未能输入到输入框(ProseMirror 仍为空)");
    log(`已输入(${typed.length}字): ${typed.slice(0, 40)}`);

    // 发送：等发送按钮 enable(有文字才亮)再点；回退 Enter
    let sent = false;
    for (const sel of ["button[data-testid='send-button']", "button[aria-label*='Send']", "button[aria-label*='发送']"]) {
        try {
            const btn = page.locator(sel).first();
            if (await btn.count() && await btn.isEnabled().catch(() => false) && await btn.isVisible().catch(() => false)) {
                await btn.click({timeout: 4000}); sent = true; break;
            }
        } catch { /* try next */ }
    }
    if (!sent) { await input.click().catch(() => {}); await page.keyboard.press("Enter"); }
    await page.waitForTimeout(1500);
    const cleared = !((await input.innerText().catch(() => "")).trim());
    log(`已发送(${sent ? "按钮" : "Enter"}，输入框已清空=${cleared})，等待 AI 回复 ...`);

    // 等 AI 回复：轮询最后一条 assistant 的【实际文本】，非空且连续 2 次长度不变(流结束)才算完成
    let replied = false, lastLen = -1, stable = 0, finalTxt = "";
    for (let i = 0; i < 40; i += 1) { // 最多约 60s
        await page.waitForTimeout(1500);
        const nodes = page.locator("[data-message-author-role='assistant']");
        if ((await nodes.count().catch(() => 0)) === 0) continue;
        const txt = (await nodes.last().innerText().catch(() => "")).trim();
        if (txt.length > 0) {
            replied = true; finalTxt = txt;
            if (txt.length === lastLen) { stable += 1; if (stable >= 2) break; }
            else { stable = 0; lastLen = txt.length; }
        }
    }
    if (replied) log(`✅ 收到 AI 回复(${finalTxt.length}字): ${finalTxt.slice(0, 80).replace(/\n/g, " ")}`);
    else log("⚠️ 未检测到 AI 回复文本(可能被 challenge / 限流 / 超时)");
    return replied;
}

/**
 * auth: Playwright cookie 数组(旧用法) 或 {cookies?, sessionToken?}。proxyUrl: 能过 chatgpt 的代理。
 * 新开浏览器注入 cookie 打开 chatgpt.com,再调 chatOnPage 发消息。
 */
// 把 auth 文件顶层 cookie 字符串("a=b; c=d")解析成 Playwright cookie 数组(注入 CF/会话 cookie 用)
function parseCookieString(s) {
    return String(s || "").split(";").map((x) => x.trim()).filter(Boolean).map((kv) => {
        const i = kv.indexOf("=");
        const name = kv.slice(0, i).trim(), value = kv.slice(i + 1).trim();
        // __Host- 前缀 cookie 不能带 domain(必须 path=/ + secure),用 url 形式
        if (name.startsWith("__Host-")) return {name, value, url: "https://chatgpt.com/", path: "/", secure: true};
        return {name, value, domain: ".chatgpt.com", path: "/", secure: true};
    }).filter((c) => c.name && c.value);
}

/**
 * 打开一个已登录 chatgpt 的真浏览器供人工操作:注入账号 at 会话(sessionToken + CF cookie),不发消息、不关闭。
 * auth: {sessionToken?, cookieString?, cookies?}。返回 browser(调用方持有以防 GC / 后续关闭);用户手动关窗口即断开。
 */
export async function openBrowserWithAuth(auth, proxyUrl, log = (m: string) => {}) {
    let cookies = Array.isArray(auth) ? auth : (auth?.cookies || []);
    if (!Array.isArray(auth) && auth?.cookieString) cookies = [...cookies, ...parseCookieString(auth.cookieString)];
    const sessionToken = Array.isArray(auth) ? "" : (auth?.sessionToken || "");
    if (sessionToken) cookies = [...cookies, ...buildSessionCookies(sessionToken)];
    if (!cookies.length) throw new Error("无可注入的登录凭据(缺 sessionToken/cookies，该号可能未拿到 at)");

    const launchOpts: any = {channel: "chrome", headless: false, args: ["--disable-blink-features=AutomationControlled"]};
    const po = parseProxyOpt(proxyUrl);
    if (po) launchOpts.proxy = po;

    const browser = await chromium.launch(launchOpts);
    const _cleanup1 = () => { try { const p = browser?.process?.(); if (p?.pid) process.kill(p.pid, "SIGKILL"); } catch {} process.exit(1); };
    process.on("SIGTERM", _cleanup1); process.on("SIGINT", _cleanup1);
    try {
        const ctx = await browser.newContext({locale: "zh-CN", viewport: {width: 1280, height: 860}});
        let okc = 0; // 逐个注入,跳过个别非法 cookie(避免一个坏的导致整体失败)
        for (const c of cookies) { try { await ctx.addCookies([c]); okc += 1; } catch { /* skip bad cookie */ } }
        log(`注入 cookie ${okc}/${cookies.length}`);
        const page = await ctx.newPage();
        page.setDefaultTimeout(30000);
        log("打开 chatgpt.com(已注入登录态) …");
        await page.goto("https://chatgpt.com/", {waitUntil: "commit", timeout: 60000});
        await page.waitForTimeout(4500);
        if (/\/auth\/login|\/api\/auth\/login/.test(page.url())) {
            await browser.close().catch(() => {});
            throw new Error(`cookie 未生效落到登录页(at 可能已过期): ${page.url().slice(0, 60)}`);
        }
        log(`已打开: ${page.url().slice(0, 55)}`);
        return browser; // 保持打开,不 close
    } catch (e) {
        try { await browser.close(); } catch { /* ignore */ }
        throw e;
    }
}

export async function simulateChat(auth, message, proxyUrl, log = (m: string) => {}) {
    let cookies = Array.isArray(auth) ? auth : (auth?.cookies || []);
    const sessionToken = Array.isArray(auth) ? "" : (auth?.sessionToken || "");
    if (sessionToken) cookies = [...cookies, ...buildSessionCookies(sessionToken)];

    const launchOpts: any = {channel: "chrome", headless: HEADLESS, args: ["--disable-blink-features=AutomationControlled"]};
    const po = parseProxyOpt(proxyUrl);
    if (po) launchOpts.proxy = po;

    const browser = await chromium.launch(launchOpts);
    const _cleanup2 = () => { try { const p = browser?.process?.(); if (p?.pid) process.kill(p.pid, "SIGKILL"); } catch {} process.exit(1); };
    process.on("SIGTERM", _cleanup2); process.on("SIGINT", _cleanup2);
    try {
        const ctx = await browser.newContext({locale: "en-US", viewport: {width: 1280, height: 800}});
        if (cookies.length) await ctx.addCookies(cookies);
        const page = await ctx.newPage();
        page.setDefaultTimeout(30000);

        log("打开 chatgpt.com ...");
        await page.goto("https://chatgpt.com/", {waitUntil: "commit", timeout: 60000});
        await page.waitForTimeout(6000);
        if (/\/auth\/login|\/api\/auth\/login/.test(page.url())) {
            throw new Error(`cookie 未生效，落到登录页: ${page.url().slice(0, 60)}`);
        }
        log(`已打开: ${page.url().slice(0, 55)} | 标题: ${(await page.title().catch(() => "")).slice(0, 40)}`);
        return await chatOnPage(page, message, log);
    } finally {
        process.removeListener("SIGTERM", _cleanup2); process.removeListener("SIGINT", _cleanup2);
        try { await browser.close(); } catch { /* ignore */ }
    }
}
