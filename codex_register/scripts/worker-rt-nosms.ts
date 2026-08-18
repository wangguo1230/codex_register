// @ts-nocheck
// 获取 rt 的 worker(不带接码) —— Pro 号不触发 add-phone，跳过 smsBroker。
// 与 src/worker-rt.ts 相同流程，但不创建接码池，add-phone 会直接抛错。
import {generateRandomDeviceProfile} from "../src/device-profile.js";
import {OpenAIClient} from "../src/openai.js";
import {appConfig} from "../src/config.js";
import {installWorkerProxyFromEnv} from "../src/mail/install-worker-proxy.js";

const EVENT_PREFIX = "@@EVENT@@";
const email = (process.env.REG_EMAIL || "").trim();
const password = (process.env.GPT_PASSWORD || "").trim() || appConfig.defaultPassword.trim();
const totpSecret = (process.env.TOTP_SECRET || "").trim();

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
    emit({type: "progress", stage: "rt", message: `开始为 ${email} 获取 refresh_token(无接码${totpSecret ? "+2FA会话" : ""})…`});

    const deviceProfile = generateRandomDeviceProfile();
    const client = new OpenAIClient({email, password, totpSecret, deviceProfile, manualMode: false});

    let authFile = "";
    let rt = "";
    emit({type: "progress", stage: "rt", message: totpSecret ? "已绑 2FA，先网页登录再会话换 rt" : "先 ChatGPT 登录再会话换 rt（不接码）"});
    try {
        await client.authLoginChatGPTHTTP();
        const sess = await client.authGetRefreshTokenViaSession(email);
        const rec = client.lastSavedAuthRecord || {};
        rt = rec.refresh_token || sess.refresh_token || "";
        authFile = sess.authFile || "";
    } catch (e) {
        emit({type: "progress", stage: "rt", message: `会话换 rt 失败(${String(e?.message || e).slice(0, 80)})，回退 OAuth`});
        const result = await client.authLoginHTTP();
        const rec = client.lastSavedAuthRecord || {};
        rt = rec.refresh_token || "";
        authFile = result.authFile || "";
    }
    if (!rt) throw new Error("未解析到 refresh_token");
    emit({type: "progress", stage: "rt", message: `✅ 拿到 refresh_token: ${rt.slice(0, 28)}...  codex文件: ${authFile}`});

    emit({
        type: "result",
        status: "success",
        email,
        rtFile: authFile,
        rt,
        phone: "",
        card: "",
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
