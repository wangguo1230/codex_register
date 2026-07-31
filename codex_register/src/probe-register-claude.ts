// @ts-nocheck
// Claude 注册 probe(端到端实测,验证录制推断的流程 + CF/凭证等录制看不到的点)。
// 流程(据 Chrome Recorder 录制):claude.ai/login 提交邮箱 → Continue with email → 收邮箱取 magic link
//   → 打开 magic link → 同意条款 → Create account → Use Claude for free → Skip → Continue → 填名 → Continue
//   → 抓 sessionKey cookie + org_id。用【比特浏览器】独立指纹窗口 + 10809 代理池过 CF。
// 用法:MAILCOM_HEADLESS=1 PROXY_URL=socks5://127.0.0.1:10809 npx tsx src/probe-register-claude.ts
import {chromium} from "playwright-core";
import {createBitWindow, openBitWindow, closeBitWindow, deleteBitWindow, bitHealth} from "./bitbrowser.js";
import {findLatestClaudeMagicLink} from "./mail/mailcom.js";

const EMAIL = process.env.CLAUDE_EMAIL || "dominique_laborekb@mail.com";
const EMAIL_PW = process.env.CLAUDE_EMAIL_PW || "pSL1yyh5j";
const PROXY = process.env.PROXY_URL || "socks5://127.0.0.1:10809";
const NAME = process.env.CLAUDE_NAME || "Alex Kim";

const log = (m) => console.log(`[claude] ${new Date().toLocaleTimeString()} ${m}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
    log(`比特健康: ${JSON.stringify(await bitHealth())}`);
    log(`邮箱=${EMAIL}  代理=${PROXY}`);
    const sinceMs = Date.now(); // 只找此后到达的 Claude 邮件
    let bitId = null;
    try {
        bitId = await createBitWindow({proxy: PROXY, name: "claude-reg", remark: "claude-probe"});
        log(`比特窗口 id=${bitId}`);
        const {ws} = await openBitWindow(bitId);
        log(`CDP ws=${ws}`);
        const browser = await chromium.connectOverCDP(ws);
        const ctx = browser.contexts()[0] || (await browser.newContext());
        const page = ctx.pages()[0] || (await ctx.newPage());
        page.setDefaultTimeout(30000);

        // ---- 1) 打开登录页,检测 CF ----
        log("① 打开 claude.ai/login …");
        await page.goto("https://claude.ai/login", {waitUntil: "domcontentloaded", timeout: 60000});
        await sleep(3500);
        log(`   URL=${page.url()}  标题=${await page.title().catch(() => "?")}`);
        if (await page.locator("text=/just a moment|verify you are human|checking your browser/i").count().catch(() => 0)) {
            log("   ⚠️ Cloudflare challenge,等 6s 看能否自动过…"); await sleep(6000);
        }
        await page.screenshot({path: "/tmp/claude-0-login.png"}).catch(() => {});

        // ---- 2) 填邮箱 + Continue with email ----
        const emailInput = page.locator('input[type="email"], input[name="email"]').first();
        await emailInput.waitFor({timeout: 30000});
        await emailInput.fill(EMAIL);
        log(`② 已填邮箱`);
        const cont = page.getByRole("button", {name: /continue with email/i}).or(page.getByRole("button", {name: /^continue$/i}));
        await cont.first().click({timeout: 15000});
        log("   已点 Continue with email");
        await sleep(4500);
        log(`   提交后 URL=${page.url()}`);
        const sent = await page.locator("text=/check your email|we sent|sent you|magic link|verify/i").count().catch(() => 0);
        log(sent ? "   ✅ 页面提示已发送邮件" : "   ⚠️ 未见'已发送'提示(可能有 turnstile / 界面不同,看截图)");
        await page.screenshot({path: "/tmp/claude-1-submitted.png"}).catch(() => {});

        // ---- 3) 轮询邮箱取 magic link ----
        log("③ 轮询 mailcom 收件箱取 magic link…");
        const link = await findLatestClaudeMagicLink(EMAIL, EMAIL_PW, {attempts: 20, intervalMs: 6000, sinceMs, log});
        if (!link) { log("❌ 20 轮未取到 magic link,停止(检查 ② 是否真发了邮件)"); return; }
        log(`   ✅ magic link = ${link}`);

        // ---- 4) 打开 magic link ----
        log("④ 打开 magic link …");
        await page.goto(link, {waitUntil: "domcontentloaded", timeout: 60000});
        await sleep(4500);
        log(`   URL=${page.url()}`);
        await page.screenshot({path: "/tmp/claude-2-magiclink.png"}).catch(() => {});

        // ---- 5) 完成注册(best-effort,每步可选,失败不中断,记录实际出现的步骤) ----
        const tryClick = async (desc, locFn) => {
            try { await locFn().first().click({timeout: 8000}); log(`   ✓ ${desc}`); await sleep(2200); return true; }
            catch { log(`   - 跳过 ${desc}(未出现)`); return false; }
        };
        log("⑤ 完成注册流程…");
        // 同意条款:优先 checkbox,兜底点含 "I agree"/"Terms" 的 label
        if (!(await tryClick("勾选同意条款(checkbox)", () => page.getByRole("checkbox"))))
            await tryClick("勾选同意条款(label)", () => page.locator('label:has-text("agree"), label:has-text("Terms"), label:has-text("18")'));
        await tryClick("Create account", () => page.getByRole("button", {name: /create account/i}));
        await tryClick("Use Claude for free", () => page.getByRole("button", {name: /use claude for free/i}).or(page.getByText(/use claude for free/i)));
        await tryClick("Skip", () => page.getByRole("button", {name: /^skip$/i}));
        await tryClick("Continue", () => page.getByRole("button", {name: /^continue$/i}));
        try { await page.getByRole("textbox", {name: /name/i}).or(page.locator('input[name="name"], input[type="text"]')).first().fill(NAME); log(`   ✓ 填名字 ${NAME}`); await sleep(1200); } catch { log("   - 名字框未出现"); }
        await tryClick("Continue(资料后)", () => page.getByRole("button", {name: /^continue$/i}));
        await sleep(5000);
        log(`   注册后 URL=${page.url()}`);
        await page.screenshot({path: "/tmp/claude-3-done.png"}).catch(() => {});

        // ---- 6) 抓凭证 ----
        log("⑥ 抓凭证…");
        const cookies = await ctx.cookies();
        const sk = cookies.find((c) => /sessionKey|session_key/i.test(c.name));
        log(`   cookie 数=${cookies.length}  名单=[${cookies.map((c) => c.name).join(", ")}]`);
        log(sk ? `   ✅ sessionKey=${String(sk.value).slice(0, 28)}…  domain=${sk.domain}  expires=${sk.expires}` : "   ❌ 未找到 sessionKey cookie");
        try {
            const org = await page.evaluate(async () => {
                const r = await fetch("https://claude.ai/api/organizations", {credentials: "include", headers: {accept: "application/json"}});
                return {status: r.status, body: (await r.text()).slice(0, 400)};
            });
            log(`   org API status=${org.status}  body=${org.body}`);
        } catch (e) { log(`   org API 失败: ${e.message}`); }

        log("✅ probe 结束。截图 /tmp/claude-0..3-*.png");
        await sleep(2000);
    } catch (e) {
        log(`❌ 异常: ${e?.stack || e?.message || e}`);
    } finally {
        if (bitId) { try { await closeBitWindow(bitId); await deleteBitWindow(bitId); log("已关闭+删除比特窗口(释放额度)"); } catch { /* */ } }
    }
}
main();
