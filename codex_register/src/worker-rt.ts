// @ts-nocheck
/**
 * 按需获取 refresh_token(rt) 的 worker —— 由后端 test-rt 在【无 rt / rt 过期】时 spawn。
 * 复用 authLoginHTTP() 走 codex OAuth(client_id=app_EMo... + offline_access)，
 * 完整处理 登录→邮箱OTP→2FA(mfa-challenge/TOTP)→add-phone(接码)→选工作区→换 token，
 * 产出含 refresh_token 的 codex auth 文件(auth/<name>.json)。
 *
 * 输入(环境变量)：
 *   REG_EMAIL            账号邮箱
 *   MAILCOM_TOKENS_FILE  该邮箱临时单行池文件(email----邮箱密码)，供 mailcom provider 收邮箱 OTP
 *   MAILCOM_HEADLESS=1   收码浏览器无头
 *   SMS_LINK_TEMPLATE    接码收码链接模板
 *   RT_PREFER_PHONE      优先复用的已绑定接码号(rt 过期重取时传，同号再收一次码)
 *   PROXY_URL / MAILCOM_PROXY / REG_DB_PATH  同注册 worker
 *
 * 输出(stdout)：普通行=日志；`@@EVENT@@{json}`=结构化事件(进度/结果)。
 *
 * 注：ChatGPT 账号密码统一用 config.defaultPassword(≥12 位)，与邮箱密码(收码用)分开。
 */
import {generateRandomDeviceProfile} from "./device-profile.js";
import {OpenAIClient} from "./openai.js";
import {appConfig} from "./config.js";
import {createPoolBroker} from "./sms/pool-broker.js";
import {installWorkerProxyFromEnv} from "./mail/install-worker-proxy.js";

const EVENT_PREFIX = "@@EVENT@@";
const email = (process.env.REG_EMAIL || "").trim();
const password = (process.env.GPT_PASSWORD || "").trim() || appConfig.defaultPassword.trim();
const totpSecret = (process.env.TOTP_SECRET || "").trim();
const preferPhone = (process.env.RT_PREFER_PHONE || "").trim();

function emit(event) {
    process.stdout.write(EVENT_PREFIX + JSON.stringify(event) + "\n");
}

async function main() {
    if (!email) {
        emit({type: "result", status: "failed", email: "", error: "缺少 REG_EMAIL"});
        process.exit(1);
        return;
    }
    const closeProxy = await installWorkerProxyFromEnv();
    try {
    emit({type: "progress", stage: "rt", message: `开始为 ${email} 获取 refresh_token${preferPhone ? `(复用绑定号 +${preferPhone})` : ""}`});

    const deviceProfile = generateRandomDeviceProfile();
    let authFile = "";
    let rt = "";
    let phone = "";
    let card = "";

    if (totpSecret) {
        try {
            emit({type: "progress", stage: "rt", message: "已绑 2FA，先网页登录再会话换 rt（不接码）"});
            const sessionClient = new OpenAIClient({email, password, totpSecret, deviceProfile, manualMode: false});
            await sessionClient.authLoginChatGPTHTTP();
            const sess = await sessionClient.authGetRefreshTokenViaSession(email);
            const rec = sessionClient.lastSavedAuthRecord || {};
            rt = rec.refresh_token || sess.refresh_token || "";
            authFile = sess.authFile || "";
        } catch (e) {
            emit({type: "progress", stage: "rt", message: `会话换 rt 失败(${String(e?.message || e).slice(0, 80)})，回退 OAuth+接码`});
        }
    }

    if (!rt) {
        const smsBroker = createPoolBroker({
            email,
            linkTemplate: process.env.SMS_LINK_TEMPLATE || "",
            preferPhone,
            maxBind: Number(process.env.SMS_MAX_BIND || 0),
            log: (m) => emit({type: "progress", stage: "phone", message: m}),
        });
        const client = new OpenAIClient({email, password, totpSecret, deviceProfile, manualMode: false, smsBroker});
        const result = await client.authLoginHTTP();
        const rec = client.lastSavedAuthRecord || {};
        rt = rec.refresh_token || "";
        authFile = result.authFile || "";
        phone = smsBroker.boundPhone || "";
        card = smsBroker.boundCard || "";
    }
    if (!rt) throw new Error("未解析到 refresh_token");
    emit({type: "progress", stage: "rt", message: `✅ 拿到 refresh_token: ${rt.slice(0, 28)}...  codex文件: ${authFile}`});

    emit({
        type: "result",
        status: "success",
        email,
        rtFile: authFile,
        rt,
        phone,
        card,
    });
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
