// @ts-nocheck
// Claude(claude.ai)API 客户端 —— 用比特浏览器注入 sessionKey 过 CF,page.evaluate(fetch) 调 API。
// (纯 HTTP/undici 被 Cloudflare 按指纹拦 403,已实测;必须真浏览器。)
// 提供:withClaudeSession(会话)/queryClaudeInfo(存活+订阅/claude_code)/claudeChat(养号)。
import {chromium} from "playwright-core";
import {createBitWindow, openBitWindow, closeBitWindow, deleteBitWindow} from "./bitbrowser.js";
import {randomUUID} from "node:crypto";

// 从 auth 记录取 cookie 数组(注册 worker 存的全 cookie);丢弃 CF 相关(cf_clearance/__cf_bm/__cflb,绑IP短效,
// 注入过期反而干扰新窗口过 CF)——只留 sessionKey 等业务 cookie,让新比特窗口自己拿新 CF cookie。
function authCookies(auth) {
    const raw = Array.isArray(auth?.cookies) ? auth.cookies : [];
    const cookies = raw
        .filter((c) => c?.value && !/^__cf|cf_clearance|__cflb|^_dd/i.test(c.name))
        .map((c) => ({name: c.name, value: c.value, url: "https://claude.ai"}));
    if (!cookies.some((c) => c.name === "sessionKey") && auth?.sessionKey) cookies.push({name: "sessionKey", value: auth.sessionKey, url: "https://claude.ai"});
    return cookies;
}

/** 起比特会话(注入 cookie + 过 CF),把 {org, call, loggedOut, page} 交给 fn,用完关窗。call=page 内 fetch。 */
export async function withClaudeSession(auth, {proxyUrl = "", log = () => {}} = {}, fn) {
    const cookies = authCookies(auth);
    const org = auth?.orgId || auth?.org_id || "";
    let bitId = null;
    try {
        bitId = await createBitWindow({proxy: proxyUrl, name: "claude-api", remark: "claude-api"});
        const {ws} = await openBitWindow(bitId);
        const browser = await chromium.connectOverCDP(ws);
        const ctx = browser.contexts()[0] || (await browser.newContext());
        for (const c of cookies) { try { await ctx.addCookies([c]); } catch { /* 个别非法跳过 */ } }
        const page = ctx.pages()[0] || (await ctx.newPage());
        page.setDefaultTimeout(30000);
        try { const cdp = await ctx.newCDPSession(page); await cdp.send("Emulation.setTimezoneOverride", {timezoneId: "America/New_York"}); } catch { /* */ } // 时区对齐美国住宅 IP
        await page.goto("https://claude.ai/", {waitUntil: "domcontentloaded", timeout: 60000});
        await page.waitForTimeout(4000);
        const loggedOut = /\/login/.test(page.url());
        log(`claude.ai 打开 URL=${page.url()}${loggedOut ? " (会话失效,跳登录页)" : ""}`);
        const call = (method, path, body) => page.evaluate(async ([m, p, b]) => {
            const r = await fetch(p, {method: m, credentials: "include", headers: {accept: "application/json", "content-type": "application/json", "anthropic-client-platform": "web_claude_ai", "anthropic-client-version": "1.0.0"}, body: b ? JSON.stringify(b) : undefined});
            const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch { /* SSE/非 json */ }
            return {status: r.status, json: j, text: t.slice(0, 4000)};
        }, [method, path, body]);
        return await fn({page, ctx, org, call, loggedOut});
    } finally {
        if (bitId) { try { await closeBitWindow(bitId); await deleteBitWindow(bitId); } catch { /* */ } }
    }
}

/** 从 current_user_access + org 详情推断套餐档。免费:billing_type=null + fast_mode 被 org_tier 锁。 */
export function derivePlan(access, org) {
    const F = access?.features || [];
    const st = (n) => F.find((f) => f.feature === n)?.status;
    const claudeCode = st("claude_code") || "unknown";
    const fastMode = st("claude_code_fast_mode");
    const billingType = org?.billing_type || "";
    const tier = org?.rate_limit_tier || "";
    const paid = !!billingType || fastMode === "available";
    const plan = paid ? (billingType || "Paid") : "Free";
    const tierBlocked = F.filter((f) => f.status === "blocked_by_org_tier").map((f) => f.feature);
    return {plan, tier, billingType, claudeCode, fastMode: fastMode || "", tierBlocked};
}

/** 查存活 + 订阅/claude_code 权限。返回 {alive, plan, tier, claudeCode, ...} 或 {alive:false, reason}。 */
export async function queryClaudeInfo(auth, opts = {}) {
    const {log = () => {}} = opts;
    return withClaudeSession(auth, opts, async ({page, org, call, loggedOut}) => {
        if (loggedOut) return {alive: false, reason: "会话失效(跳登录页)"};
        if (/\/restricted/.test(page.url())) return {alive: false, reason: "账号受限(restricted)"};
        // org 缺失(如受限/新号)→ 活取一次
        let orgId = org;
        if (!orgId) {
            const orgs = await call("GET", "/api/organizations");
            orgId = Array.isArray(orgs.json) && orgs.json[0]?.uuid ? orgs.json[0].uuid : "";
        }
        if (!orgId) return {alive: false, reason: "无可用 org(受限/未激活)"};
        const acc = await call("GET", `/api/bootstrap/${orgId}/current_user_access`);
        if (acc.status !== 200) return {alive: false, reason: `current_user_access HTTP ${acc.status}`};
        const o = await call("GET", `/api/organizations/${orgId}`);
        const info = derivePlan(acc.json, o.json);
        log(`存活 ✓ plan=${info.plan} claude_code=${info.claudeCode} tier=${info.tier}`);
        return {alive: true, orgId, orgName: o.json?.name || "", ...info};
    });
}

/** 养号:新建会话 + 发一条消息(completion 返回 SSE,取到 200 即算账号可聊天)。 */
export async function claudeChat(auth, opts = {}, message = "Hello! Give me a quick productivity tip.") {
    const {log = () => {}} = opts;
    return withClaudeSession(auth, opts, async ({org, call, loggedOut}) => {
        if (loggedOut || !org) return {ok: false, reason: "会话失效"};
        const convId = randomUUID();
        await call("POST", `/api/organizations/${org}/chat_conversations`, {uuid: convId, name: ""}).catch(() => {});
        const r = await call("POST", `/api/organizations/${org}/chat_conversations/${convId}/completion`, {prompt: message, timezone: "America/New_York", locale: "en-US", effort: "medium", thinking_mode: "auto", tools: []});
        const replied = r.status === 200 && /message_start|completion|assistant/i.test(r.text || "");
        log(`养号 completion HTTP ${r.status}${replied ? " ✓已回复" : ""}`);
        return {ok: replied, status: r.status, convId};
    });
}
