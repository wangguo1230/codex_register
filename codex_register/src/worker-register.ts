// @ts-nocheck
/**
 * 单邮箱注册 worker —— 由后端调度器 spawn，一个子进程注册一个邮箱。
 *
 * 输入(环境变量)：
 *   REG_EMAIL              要注册的邮箱
 *   REG_PASSWORD           注册用密码(默认取 config.defaultPassword)
 *   MAILCOM_TOKENS_FILE    该邮箱的临时单行池文件(email----password)，供 mailcom provider 收码登录
 *   MAILCOM_HEADLESS=1      收码浏览器无头
 *
 * 输出(stdout)：
 *   普通行              = 注册过程日志(authRegisterHTTP 内部 console.log 原样透出)
 *   `@@EVENT@@{json}`   = 结构化事件(进度/结果)，后端据此更新 DB 状态
 *
 * 子进程模型的好处：日志隔离、崩溃隔离、sentinel(CPU)真并行、Playwright 会话不跨任务污染。
 */
import {generateRandomDeviceProfile} from "./device-profile.js";
import {OpenAIClient} from "./openai.js";
import {appConfig} from "./config.js";
import {simulateChat} from "./simulate-chat.js";
import {createPoolBroker} from "./sms/pool-broker.js";
import {enrollTotp} from "./mfa.js";
import {decodeJwt} from "./token-check.js";
import {readFile} from "node:fs/promises";
import {installWorkerProxyFromEnv} from "./mail/install-worker-proxy.js";

const EVENT_PREFIX = "@@EVENT@@";
const email = (process.env.REG_EMAIL || "").trim();
// ChatGPT 账号密码：调度器按号生成经 GPT_PASSWORD 传入；空则回退 defaultPassword。
// 邮箱密码(池文件里的 email----password)只用于登录 mail.com 收码，两者不能混用！
const password = (process.env.GPT_PASSWORD || "").trim() || appConfig.defaultPassword.trim();
// 养号聊天随机消息(每个号发不同的话，更像真人)
const CHAT_MESSAGES = [
    "hello, how are you?", "what can you do?", "tell me a fun fact",
    "hi there!", "give me a quick productivity tip", "recommend a good book to read",
    "explain black holes in simple terms", "what's a healthy breakfast idea?",
    "suggest a beginner workout", "what's an interesting science fact?",
];

function emit(event) {
    process.stdout.write(EVENT_PREFIX + JSON.stringify(event) + "\n");
}

async function getTokenWithFallback(client, deviceProfile) {
    try {
        return await client.getChatGPTAccessToken();
    } catch (err) {
        emit({type: "progress", stage: "token_fallback", message: `直接拿 token 失败(${err?.message})，重登录重试`});
        const reauth = new OpenAIClient({
            email: client.email,
            password,
            totpSecret: process.env.TOTP_SECRET || "",
            deviceProfile: deviceProfile ?? generateRandomDeviceProfile(),
            manualMode: false,
        });
        try {
            await reauth.authLoginHTTP();
        } catch (loginErr) {
            emit({type: "progress", stage: "relogin_failed", message: String(loginErr?.message ?? loginErr)});
        }
        return reauth.getChatGPTAccessToken();
    }
}

async function main() {
    if (!email) {
        emit({type: "result", status: "failed", email: "", error: "缺少 REG_EMAIL"});
        process.exit(1);
        return;
    }
    if (password.length < 12) {
        emit({type: "result", status: "failed", email, error: `ChatGPT 注册密码需≥12位(当前${password.length}位)，请改 config.json 的 defaultPassword`});
        process.exit(1);
        return;
    }
    const closeProxy = await installWorkerProxyFromEnv();
    try {
    emit({type: "progress", stage: "start", email, message: `开始注册 ${email}`});

    const deviceProfile = generateRandomDeviceProfile();
    const otpSingle = process.env.REG_OTP_SINGLE !== "0"; // 默认单封(只用创建账号时自动发的那封)
    // [按需接码] 仅当启用接码池时注入 smsBroker；注册流程只有走到 add-phone(OpenAI 要求手机验证)才会用它，
    // 不要求手机的账号完全不受影响。号码不可用/收码失败由 broker 自动换号+坏号隔离。
    const smsBroker = process.env.REG_SMS === "1"
        ? createPoolBroker({email, linkTemplate: process.env.SMS_LINK_TEMPLATE || "", maxBind: Number(process.env.SMS_MAX_BIND || 0), log: (m) => emit({type: "progress", stage: "phone", message: m})})
        : null;
    const client = new OpenAIClient({email, password, deviceProfile, manualMode: false, otpSingle, smsBroker});

    await client.authRegisterHTTP();
    emit({type: "progress", stage: "registered", email: client.email, message: "注册流程完成，获取 access_token"});

    const token = await getTokenWithFallback(client, deviceProfile);
    const authFile = await client.saveChatGPTAccessToken(token);

    let totpSecret = "";
    let mfaStatus = "";
    if (process.env.REG_TRY_MFA === "1") {
        emit({type: "progress", stage: "mfa", message: "注册后绑定 TOTP…"});
        try {
            const accountId = decodeJwt(token)?.["https://api.openai.com/auth"]?.chatgpt_account_id || "";
            const mfaCookie = String((client as any).lastSavedAuthRecord?.cookie || (client as any).cookie || "").trim();
            const mfa = await enrollTotp(token, {
                accountId,
                proxyUrl: process.env.PROXY_URL || "",
                cookie: mfaCookie,
                retryAltProxy: true,
                browserFallback: process.env.MFA_NO_BROWSER !== "1",
                log: (m) => emit({type: "progress", stage: "mfa", message: m}),
            });
            if (mfa.ok && mfa.secret) { totpSecret = mfa.secret; mfaStatus = "✅已绑"; emit({type: "progress", stage: "mfa", message: `TOTP 已绑定(${mfa.via || "http"})`}); }
            else if (mfa.ok && mfa.already) { mfaStatus = "⚠已有2FA缺密钥"; emit({type: "progress", stage: "mfa", message: "该号已有 2FA 但本次未拿到 secret"}); }
            else { mfaStatus = "❌" + (mfa.reason || "绑定失败"); emit({type: "progress", stage: "mfa", message: "TOTP 未绑(不影响注册): " + (mfa.reason || "")}); }
        } catch (e: any) {
            mfaStatus = "❌" + String(e?.message || e).slice(0, 80);
            emit({type: "progress", stage: "mfa", message: "TOTP 未绑(不影响注册): " + mfaStatus});
        }
    }

    // [追加·不影响原流程] 注册成功后额外走一次 codex OAuth(client_id=app_EMo... + offline_access)拿可续期 refresh_token。
    // authLoginHTTP 会完整处理 登录/邮箱OTP/add-phone(smsBroker)/选工作区 → 产出含 rt 的 codex auth 文件。
    // rt 依赖手机验证(接码有成本)，失败仅记录、不影响已拿到的网页 token 结果。
    let rtFile = "";
    if (process.env.REG_TRY_RT === "1") {
        try {
            if (!smsBroker) throw new Error("拿 rt 需 add-phone 接码，但未启用接码池(REG_SMS)");
            emit({type: "progress", stage: "rt", message: "走 codex OAuth 获取 refresh_token(重新登录→add-phone 接码) ..."});
            // 关键:不复用注册后的 client——它带登录态，authorize 会跳 /choose-an-account 死路(authLoginHTTP 不处理该页)。
            // 新建干净 client(无 session)走正常登录路径(/log-in→密码→邮箱OTP→add-phone→换 rt)，与 worker-rt 一致。
            const rtClient = new OpenAIClient({email, password, totpSecret, deviceProfile: generateRandomDeviceProfile(), manualMode: false, smsBroker});
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

    // 注册成功后模拟一次聊天养号(可选，失败不影响注册结果)。chatOk: null=未跑, true=回复, false=失败
    let chatOk = null;
    if (process.env.REG_SIMULATE_CHAT === "1") {
        try {
            const raw = (client as any).jar.serializeSync().cookies || [];
            const cookies = raw
                .filter((c: any) => /chatgpt\.com|openai\.com/.test(c.domain || "") && typeof c.value === "string" && c.value && c.key)
                .map((c: any) => ({
                    name: c.key, value: c.value,
                    domain: c.domain || "chatgpt.com", path: c.path || "/",
                    httpOnly: !!c.httpOnly, secure: c.secure !== false, sameSite: "Lax" as const,
                }));
            const msg = CHAT_MESSAGES[Math.floor(Math.random() * CHAT_MESSAGES.length)];
            emit({type: "progress", stage: "chat", message: `模拟聊天养号: "${msg}" (注入 ${cookies.length} cookie) ...`});
            chatOk = await simulateChat(cookies, msg, process.env.PROXY_URL, (m: string) => emit({type: "progress", stage: "chat", message: m}));
            emit({type: "progress", stage: "chat", message: chatOk ? "养号聊天完成 ✅" : "养号聊天未确认回复(不影响注册)"});
        } catch (e: any) {
            chatOk = false;
            emit({type: "progress", stage: "chat", message: "模拟聊天失败(不影响注册): " + (e?.message ?? e)});
        }
    }

    // 从 JWT 解出 plan 等关键信息(best-effort)
    let plan = "";
    try {
        const payload = JSON.parse(Buffer.from(token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"));
        plan = payload?.["https://api.openai.com/auth"]?.chatgpt_plan_type ?? "";
    } catch { /* ignore */ }

    emit({type: "result", status: "success", email: client.email, password, gptPassword: password, totpSecret, mfaStatus, token, authFile, rtFile, chatOk, plan, phone: smsBroker?.boundPhone || "", card: smsBroker?.boundCard || ""});
    } finally {
        try { closeProxy(); } catch { /* */ }
    }
}

main()
    .then(() => process.exit(0))
    .catch((error) => {
        emit({type: "result", status: "failed", email, error: String(error?.message ?? error)});
        process.exit(1);
    });
