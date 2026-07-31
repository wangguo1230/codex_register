// @ts-nocheck
/**
 * Claude 注册 worker —— 调度器为 pending claude_account spawn，一个子进程注册一个邮箱。
 * 流程(probe 验证):比特浏览器(独立指纹)+ PROXY_URL 过 CF → claude.ai/login 提交邮箱 → Continue with email
 *   → mailcom 收邮箱取 magic link → 打开完成注册(同意条款→Create account→Use Claude for free→Skip→Continue→填名→Continue)
 *   → 抓 sessionKey(sk-ant-sid02-…) + org_id + 全 cookie。产出 auth/claude/<date>-<email>.json。
 * env: REG_EMAIL / REG_PASSWORD(邮箱密码,收信用) / PROXY_URL(过CF) / BITBROWSER(=1) / CLAUDE_NAME
 * stdout: @@EVENT@@{type:progress|result}(调度器统一处理)
 */
import {chromium} from "playwright-core";
import {createBitWindow, openBitWindow, closeBitWindow, deleteBitWindow} from "./bitbrowser.js";
import {findLatestClaudeMagicLink} from "./mail/mailcom.js";
import {writeFile, mkdir} from "node:fs/promises";
import path from "node:path";
import {fileURLToPath} from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const AUTH_DIR = path.resolve(__dirname, "..", "auth", "claude");
const EVENT_PREFIX = "@@EVENT@@";
// 姓名随机库:900 种组合,打散"批量同名(全 Alex Kim)"的机器注册特征
const FIRST_NAMES = ["James", "Olivia", "Liam", "Emma", "Noah", "Ava", "William", "Sophia", "Benjamin", "Isabella", "Lucas", "Mia", "Henry", "Charlotte", "Alexander", "Amelia", "Daniel", "Harper", "Michael", "Evelyn", "Jack", "Abigail", "Owen", "Emily", "Samuel", "Ella", "Ethan", "Grace", "Nathan", "Chloe"];
const LAST_NAMES = ["Smith", "Johnson", "Williams", "Brown", "Jones", "Garcia", "Miller", "Davis", "Rodriguez", "Martinez", "Wilson", "Anderson", "Taylor", "Thomas", "Moore", "Jackson", "Martin", "Lee", "Thompson", "White", "Harris", "Clark", "Lewis", "Walker", "Hall", "Young", "King", "Wright", "Hill", "Green"];
const randomName = () => `${FIRST_NAMES[Math.floor(Math.random() * FIRST_NAMES.length)]} ${LAST_NAMES[Math.floor(Math.random() * LAST_NAMES.length)]}`;
const email = (process.env.REG_EMAIL || "").trim();
const password = (process.env.REG_PASSWORD || "").trim();
const PROXY = (process.env.PROXY_URL || "").trim();
// 显式指定则用;否则每号随机(不再固定 Alex Kim)
const NAME = (process.env.CLAUDE_NAME || "").trim() || randomName();
const emit = (ev) => process.stdout.write(EVENT_PREFIX + JSON.stringify(ev) + "\n");
const log = (message) => emit({type: "progress", message});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// ---- 拟人化:随机延时 + 逐字打字 + 鼠标轨迹点击(缓解行为特征检测) ----
const rand = (a, b) => Math.floor(a + Math.random() * (b - a));
const sleepR = (a, b) => sleep(rand(a, b));
async function humanType(page, text) { for (const ch of String(text)) { await page.keyboard.type(ch); await sleep(rand(45, 165)); } }
async function humanClick(page, loc, {timeout = 8000} = {}) {
    const el = loc.first();
    await el.scrollIntoViewIfNeeded({timeout: 4000}).catch(() => {});
    const box = await el.boundingBox().catch(() => null);
    if (box) { await page.mouse.move(box.x + box.width * (0.3 + Math.random() * 0.4), box.y + box.height * (0.3 + Math.random() * 0.4), {steps: rand(6, 18)}); await sleepR(120, 460); }
    await el.click({timeout, delay: rand(40, 130)});
}

function authFileName(email) {
    const safe = email.replace(/[^a-zA-Z0-9._-]/g, "_");
    return `${new Date().toISOString().slice(0, 10)}-${safe}.json`;
}

// 首条养号消息:扩到 24 条并每号随机,避免批量账号发相同句子形成内容指纹
const CHAT_MESSAGES = [
    "Hi! Give me a quick productivity tip.", "What's a fun fact about space?", "Recommend a good book to read.",
    "Explain black holes simply.", "What's a healthy breakfast idea?", "Tell me a short joke.",
    "How can I stay focused while working?", "Suggest a beginner-friendly hobby.", "What's a good stretch for back pain?",
    "Give me a simple pasta recipe.", "How do I make better coffee at home?", "What's an easy way to learn a language?",
    "Summarize how photosynthesis works.", "Recommend a relaxing weekend activity.", "What's a quick tip for better sleep?",
    "Explain compound interest in one paragraph.", "Suggest a movie for a rainy day.", "How can I organize my desk better?",
    "What's a good way to start journaling?", "Give me a fun icebreaker question.", "How do plants survive winter?",
    "What's a simple breathing exercise for stress?", "Recommend a podcast about science.", "How do I water succulents properly?",
];

// 注册后养号:在同一比特窗口的聊天框发一条消息(Claude 输入框是 contenteditable ProseMirror)。留真实使用痕迹,缓解风控。
async function chatOnPage(page, message, log) {
    const findBox = () => page.getByRole("textbox", {name: /write your prompt|reply to|message claude/i}).or(page.locator('div[contenteditable="true"]')).first();
    try {
        let box = findBox();
        if (!(await box.count().catch(() => 0))) { await page.goto("https://claude.ai/new", {waitUntil: "domcontentloaded", timeout: 30000}); await sleep(3000); box = findBox(); }
        await box.waitFor({timeout: 15000});
        await humanClick(page, box); await sleepR(300, 800);
        await humanType(page, message); // 逐字拟人输入
        await sleepR(500, 1200);
        await page.keyboard.press("Enter");
        log(`养号:已发送 "${message.slice(0, 30)}"`);
        await sleep(8000); // 等回复开始
        return true;
    } catch (e) { log(`养号未成功: ${String(e?.message || e).slice(0, 60)}`); return false; }
}

async function main() {
    if (!email || !password) { emit({type: "result", status: "failed", email, error: "缺少 REG_EMAIL/REG_PASSWORD"}); process.exit(1); return; }
    log(`开始 Claude 注册 ${email}`);
    const sinceMs = Date.now();
    let bitId = null;
    try {
        bitId = await createBitWindow({proxy: PROXY, name: "claude-reg", remark: "claude"});
        const {ws} = await openBitWindow(bitId);
        const browser = await chromium.connectOverCDP(ws);
        const ctx = browser.contexts()[0] || (await browser.newContext());
        const page = ctx.pages()[0] || (await ctx.newPage());
        page.setDefaultTimeout(30000);
        // 时区/地理已由比特浏览器按代理出口 IP 自动对齐(openBitWindow extractIp:true),不再手动硬编码,
        // 避免"IP在西部却报纽约时区"这类矛盾信号。

        // 1) 提交邮箱触发 magic link
        log("打开 claude.ai/login…");
        await page.goto("https://claude.ai/login", {waitUntil: "domcontentloaded", timeout: 60000});
        await sleepR(2500, 4500);
        await page.mouse.wheel(0, rand(80, 380)).catch(() => {}); await sleepR(400, 1200); // 拟人:落地随机滚动+停顿
        if (await page.locator("text=/just a moment|verify you are human|checking your browser/i").count().catch(() => 0)) { log("遇 CF challenge,等 6s…"); await sleep(6000); }
        const emailInput = page.locator('input[type="email"], input[name="email"]').first();
        await emailInput.waitFor({timeout: 30000});
        await humanClick(page, emailInput); await sleepR(200, 600);
        await humanType(page, email); await sleepR(300, 900);         // 逐字拟人输入
        await humanClick(page, page.getByRole("button", {name: /continue with email/i}).or(page.getByRole("button", {name: /^continue$/i})), {timeout: 15000});
        log("已提交邮箱,等待 Claude 发送 magic link…");
        await sleepR(3500, 5500);

        // 2) 收邮箱取 magic link
        const link = await findLatestClaudeMagicLink(email, password, {attempts: 20, intervalMs: 6000, sinceMs, log});
        if (!link) throw new Error("未取到 Claude magic link(邮件未到或收信失败)");
        log("已取到 magic link,打开完成注册…");

        // 3) 打开 magic link + 完成注册(best-effort)
        await page.goto(link, {waitUntil: "domcontentloaded", timeout: 60000});
        await sleepR(3500, 5500);
        // 拟人点击:鼠标轨迹 + 随机按压间隔 + 步间随机停顿(不再瞬时机械点击)
        const tryClick = async (desc, locFn) => { try { await humanClick(page, locFn()); log(`✓ ${desc}`); await sleepR(1400, 3200); return true; } catch { return false; } };
        if (!(await tryClick("同意条款(checkbox)", () => page.getByRole("checkbox"))))
            await tryClick("同意条款(label)", () => page.locator('label:has-text("agree"), label:has-text("Terms"), label:has-text("18")'));
        await tryClick("Create account", () => page.getByRole("button", {name: /create account/i}));
        await tryClick("Use Claude for free", () => page.getByRole("button", {name: /use claude for free/i}).or(page.getByText(/use claude for free/i)));
        await tryClick("Skip", () => page.getByRole("button", {name: /^skip$/i}));
        await tryClick("Continue", () => page.getByRole("button", {name: /^continue$/i}));
        try { const nb = page.getByRole("textbox", {name: /name/i}).or(page.locator('input[name="name"], input[type="text"]')).first(); await humanClick(page, nb); await sleepR(200, 500); await humanType(page, NAME); log(`✓ 填名字 ${NAME}`); await sleepR(800, 1600); } catch { /* 无名字步骤 */ }
        await tryClick("Continue(资料后)", () => page.getByRole("button", {name: /^continue$/i}));
        await sleep(2500);

        // 选职业页(onboarding "What kind of work do you do?"):★不处理会卡住 → org 拿不到、聊天/养号进不去。
        // 优先"Set up later"跳过;没有则打开职业下拉选一个角色再 Continue。
        if (!(await tryClick("Set up later(跳过选职业)", () => page.getByRole("button", {name: /set up later/i})))) {
            if (await tryClick("打开职业下拉", () => page.locator('[data-testid="role-selector-dropdown"]').or(page.getByRole("button", {name: /select your role/i})))) {
                await tryClick("选职业(任一)", () => page.getByRole("menuitem").or(page.getByRole("option")).first());
                await tryClick("Continue(职业后)", () => page.getByRole("button", {name: /^continue$/i}));
            }
        }
        await sleepR(3500, 5500);
        log(`注册后 URL=${page.url()}`);

        // 4) 注册收尾:在聊天框发一条消息(★注册流程固有的一环——真人注册完自然会用一下)。失败不影响注册结果。
        log("注册收尾:在聊天框发一条消息…");
        await sleepR(4000, 8000); // 拟人:到聊天页后停顿几秒再打字
        const chatOk = await chatOnPage(page, CHAT_MESSAGES[rand(0, CHAT_MESSAGES.length)], log);

        // 5) 抓凭证
        const cookies = await ctx.cookies();
        const sk = cookies.find((c) => /^sessionKey$/i.test(c.name)) || cookies.find((c) => /sessionKey/i.test(c.name));
        if (!sk?.value) throw new Error(`未拿到 sessionKey(cookie: ${cookies.map((c) => c.name).join(",")})`);
        // 顺手抓 org 详情 + 订阅/claude_code 权限(活会话最可靠)。onboarding 直后 org 可能未就绪→重试几次。
        let orgId = "", plan = "", claudeCode = "", tier = "";
        try {
            const info = await page.evaluate(async () => {
                const g = async (p) => { const r = await fetch(p, {credentials: "include", headers: {accept: "application/json", "anthropic-client-platform": "web_claude_ai"}}); return r.ok ? await r.json() : null; };
                let uuid = "";
                for (let i = 0; i < 6 && !uuid; i++) { // org 未就绪重试(每次等 2.5s)
                    const orgs = await g("/api/organizations");
                    uuid = Array.isArray(orgs) && orgs[0]?.uuid ? orgs[0].uuid : "";
                    if (!uuid) await new Promise((r) => setTimeout(r, 2500));
                }
                const acc = uuid ? await g(`/api/bootstrap/${uuid}/current_user_access`) : null;
                const org = uuid ? await g(`/api/organizations/${uuid}`) : null;
                return {uuid, acc, org};
            });
            orgId = info.uuid || "";
            const F = info.acc?.features || [];
            claudeCode = F.find((f) => f.feature === "claude_code")?.status || "";
            const fastMode = F.find((f) => f.feature === "claude_code_fast_mode")?.status;
            const billingType = info.org?.billing_type || "";
            tier = info.org?.rate_limit_tier || "";
            plan = (billingType || fastMode === "available") ? (billingType || "Paid") : "Free";
        } catch { /* 拿不到不阻塞注册结果 */ }

        // 6) 存 auth 文件(全 cookie + 凭证 + 订阅信息)
        await mkdir(AUTH_DIR, {recursive: true});
        const authFile = path.join(AUTH_DIR, authFileName(email));
        await writeFile(authFile, JSON.stringify({email, sessionKey: sk.value, orgId, plan, claudeCode, tier, cookies, type: "claude", savedAt: Date.now()}) + "\n", "utf8");
        log(`✅ 注册成功 sessionKey=${sk.value.slice(0, 20)}… org=${orgId || "?"} 发消息=${chatOk ? "✓" : "✗"}`);

        emit({type: "result", status: "success", email, sessionKey: sk.value, orgId, authFile, plan: "free", chatOk});
    } catch (e) {
        emit({type: "result", status: "failed", email, error: String(e?.message || e).slice(0, 300)});
    } finally {
        if (bitId) { try { await closeBitWindow(bitId); await deleteBitWindow(bitId); } catch { /* */ } }
    }
    process.exit(0);
}
main();
