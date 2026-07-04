// @ts-nocheck
/**
 * 浏览器自动化注册 单号调试入口。
 * 用法: MAILCOM_TOKENS_FILE=<池文件> PROXY_URL=<能过CF的代理> npx tsx src/probe-register-browser.ts <email>
 *   - MAILCOM_TOKENS_FILE: 每行 email----邮箱密码(mailcom provider 收验证码要登录邮箱)
 *   - PROXY_URL: 过 chatgpt.com CF 的代理(科学上网/独立 xray 端口，如 socks5://127.0.0.1:10809)
 *   - HEADLESS=1 无头(大概率被 CF 拦，调试用有头)
 */
import {registerViaBrowser} from "./register-browser.js";
import {appConfig} from "./config.js";

const email = (process.argv[2] || process.env.REG_EMAIL || "").trim();
if (!email) {
    console.error("用法: MAILCOM_TOKENS_FILE=... PROXY_URL=... npx tsx src/probe-register-browser.ts <email>");
    process.exit(1);
}
const proxyUrl = process.env.PROXY_URL || appConfig.defaultProxyUrl;
console.log(`[probe] 浏览器注册 ${email}  代理=${proxyUrl}  headless=${process.env.HEADLESS === "1"}`);

registerViaBrowser(email, {
    password: appConfig.defaultPassword,
    proxyUrl,
    headless: process.env.HEADLESS === "1",
    chatMessage: process.env.REG_SIMULATE_CHAT === "1" ? "hello, how are you?" : "", // 设 REG_SIMULATE_CHAT=1 测注册后养号
    log: (m) => console.log("[reg]", m),
}).then((r) => {
    console.log("=== 结果 ===");
    console.log(JSON.stringify({ok: r.ok, token: r.token ? r.token.slice(0, 20) + "…" : "", error: r.error, url: r.url}, null, 2));
    process.exit(r.ok ? 0 : 1);
});
