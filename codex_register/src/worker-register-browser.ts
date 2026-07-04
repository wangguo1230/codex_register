// @ts-nocheck
/**
 * 浏览器引擎注册 worker —— 由调度器在"注册引擎=浏览器"时 spawn，一个子进程注册一个邮箱。
 * 用真 Chrome(registerViaBrowser)过 CF 完成 chatgpt.com/auth/login 注册,产出网页 auth 文件(与 HTTP 引擎一致)。
 *
 * env: REG_EMAIL / MAILCOM_TOKENS_FILE(收码登录) / MAILCOM_HEADLESS / PROXY_URL(过CF代理) / REG_SIMULATE_CHAT
 * stdout: 普通行=日志; @@EVENT@@{json}=进度/结果(同 worker-register，调度器统一处理)
 */
import {registerViaBrowser} from "./register-browser.js";
import {createBitWindow, openBitWindow, closeBitWindow, deleteBitWindow} from "./bitbrowser.js";
import {buildAuthRecord} from "./email-reg/auth-record.js";
import {getMailboxCredential} from "./mailbox.js";
import {appConfig} from "./config.js";
import {OpenAIClient} from "./openai.js";
import {generateRandomDeviceProfile} from "./device-profile.js";
import {createPoolBroker} from "./sms/pool-broker.js";
import {writeFile, mkdir} from "node:fs/promises";
import path from "node:path";

const EVENT_PREFIX = "@@EVENT@@";
const email = (process.env.REG_EMAIL || "").trim();
const password = appConfig.defaultPassword.trim();
const CHAT_MESSAGES = ["hello, how are you?", "what can you do?", "tell me a fun fact", "hi there!", "give me a quick productivity tip", "recommend a good book", "explain black holes simply", "what's a healthy breakfast idea?"];
function emit(ev) { process.stdout.write(EVENT_PREFIX + JSON.stringify(ev) + "\n"); }

function buildAuthFileName(email) {
    const safe = email.replace(/[^a-zA-Z0-9._-]/g, "_");
    const d = new Date().toISOString().slice(0, 10);
    return `${d}-${safe}.json`;
}
function cookieString(cookies) {
    return (cookies || [])
        .filter((c) => /chatgpt\.com|openai\.com/.test(c.domain || "") && c.value)
        .map((c) => `${c.name}=${c.value}`).join("; ");
}
function planFromToken(token) {
    try {
        const p = JSON.parse(Buffer.from(token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"));
        return p?.["https://api.openai.com/auth"]?.chatgpt_plan_type ?? "";
    } catch { return ""; }
}

async function main() {
    if (!email) { emit({type: "result", status: "failed", email: "", error: "缺少 REG_EMAIL"}); process.exit(1); return; }
    emit({type: "progress", stage: "start", email, message: `开始浏览器注册 ${email}`});

    // 养号:注册完在同一浏览器页直接发一条消息(REG_SIMULATE_CHAT=1)，免重开浏览器
    const chatMessage = process.env.REG_SIMULATE_CHAT === "1" ? CHAT_MESSAGES[Math.floor(Math.random() * CHAT_MESSAGES.length)] : "";
    // 比特浏览器(BITBROWSER=1):每号动态创建一个【独立随机指纹】窗口(绑 PROXY_URL 代理),用完关闭+删除,循环用会员额度。
    const useBit = process.env.BITBROWSER === "1";
    let bitId = null, cdpEndpoint = "";
    if (useBit) {
        try {
            emit({type: "progress", stage: "bit", message: "创建比特浏览器窗口(独立指纹)…"});
            bitId = await createBitWindow({proxy: process.env.PROXY_URL || ""});
            const {ws} = await openBitWindow(bitId);
            cdpEndpoint = ws;
            emit({type: "progress", stage: "bit", message: `比特窗口已打开(${String(bitId).slice(0, 8)}…)`});
        } catch (e) {
            emit({type: "result", status: "failed", email, error: "比特窗口创建/打开失败: " + (e?.message ?? e)});
            if (bitId) await deleteBitWindow(bitId);
            process.exit(1); return;
        }
    }
    let r;
    try {
        r = await registerViaBrowser(email, {
            password,
            proxyUrl: process.env.PROXY_URL || "",
            headless: process.env.CHAT_HEADLESS === "1", // 默认 headed(过 CF);无头服务器需 xvfb
            chatMessage,
            cdpEndpoint, // 有=连接比特窗口;无=launch 临时 Chrome
            log: (m) => emit({type: "progress", stage: "browser", message: m}),
        });
    } finally {
        if (bitId) { await closeBitWindow(bitId); await deleteBitWindow(bitId); emit({type: "progress", stage: "bit", message: "已关闭并删除比特窗口(释放额度)"}); }
    }
    if (!r.ok || !r.token) {
        emit({type: "result", status: "failed", email, error: r.error || "浏览器注册未拿到 token"});
        process.exit(1); return;
    }

    // 存网页 auth 文件(auth/at/<date>-<email>.json)，格式与 HTTP 引擎一致
    let mailbox = null;
    try { mailbox = await getMailboxCredential(email); } catch { /* 取不到忽略 */ }
    const record = buildAuthRecord({accessToken: r.token, email, session: r.session, mailbox, cookie: cookieString(r.cookies)});
    const atDir = path.resolve(process.cwd(), "auth", "at");
    await mkdir(atDir, {recursive: true});
    const authFile = path.join(atDir, buildAuthFileName(email));
    await writeFile(authFile, JSON.stringify(record) + "\n", "utf8");
    emit({type: "progress", stage: "registered", email, message: `注册完成，auth 文件: ${authFile}`});

    // [注册后取 rt] 同 HTTP 引擎:REG_TRY_RT=1 → 新建干净 client 走 codex OAuth(authLoginHTTP,HTTP,不碰浏览器)拿可续期 rt。
    // 复用邮箱OTP(mailcom)+add-phone(接码)。失败仅记录、不影响已拿到的网页 token。
    let rtFile = "";
    if (process.env.REG_TRY_RT === "1") {
        try {
            const smsBroker = createPoolBroker({
                email,
                linkTemplate: process.env.SMS_LINK_TEMPLATE || "",
                maxBind: Number(process.env.SMS_MAX_BIND || 0),
                log: (m) => emit({type: "progress", stage: "rt", message: m}),
            });
            emit({type: "progress", stage: "rt", message: "走 codex OAuth 获取 refresh_token(邮箱OTP + add-phone 接码) ..."});
            const rtClient = new OpenAIClient({email, password, deviceProfile: generateRandomDeviceProfile(), manualMode: false, smsBroker});
            const rtResult = await rtClient.authLoginHTTP();
            rtFile = rtResult.authFile || "";
            const rt = (rtClient as any).lastSavedAuthRecord?.refresh_token || "";
            emit({type: "progress", stage: "rt", message: rt
                ? `✅ 拿到 refresh_token(可续期): ${rt.slice(0, 28)}...  codex文件: ${rtFile}`
                : "authLoginHTTP 完成但未解析到 refresh_token"});
        } catch (e: any) {
            emit({type: "progress", stage: "rt", message: `refresh_token 获取失败(可能需手机验证/接码不足): ${String(e?.message ?? e).slice(0, 150)}`});
        }
    }

    emit({type: "result", status: "success", email, password, token: r.token, authFile, rtFile, plan: planFromToken(r.token)});
}

main().then(() => process.exit(0)).catch((e) => {
    emit({type: "result", status: "failed", email, error: String(e?.message ?? e)});
    process.exit(1);
});
