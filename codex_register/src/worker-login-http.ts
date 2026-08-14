// @ts-nocheck
/**
 * 纯协议重登拿网页 AT(不启动 Chrome/比特)。
 * 邮箱 OTP(mailcom) → 密码(若出现) → TOTP(若已绑) → chatgpt.com /api/auth/session。
 *
 * env: REG_EMAIL / GPT_PASSWORD / TOTP_SECRET / MAILCOM_TOKENS_FILE / PROXY_URL / MAILCOM_PROXY / REG_TRY_MFA
 */
import {generateRandomDeviceProfile} from "./device-profile.js";
import {OpenAIClient} from "./openai.js";
import {appConfig} from "./config.js";
import {enrollTotp} from "./mfa.js";
import {decodeJwt} from "./token-check.js";

const EVENT_PREFIX = "@@EVENT@@";
const email = (process.env.REG_EMAIL || "").trim();
const password = (process.env.GPT_PASSWORD || "").trim() || appConfig.defaultPassword.trim();
const totpSecretEnv = (process.env.TOTP_SECRET || "").trim();

function emit(ev) { process.stdout.write(EVENT_PREFIX + JSON.stringify(ev) + "\n"); }

async function main() {
    if (!email) { emit({type: "result", status: "failed", email: "", error: "缺少 REG_EMAIL"}); process.exit(1); return; }
    emit({type: "progress", stage: "start", email, message: `开始协议登录 ${email}`});

    const client = new OpenAIClient({
        email,
        password,
        totpSecret: totpSecretEnv,
        deviceProfile: generateRandomDeviceProfile(),
        manualMode: false,
    });
    const r = await client.authLoginChatGPTHTTP();
    if (!r?.token || !r.authFile) throw new Error("协议登录未拿到 token");

    let totpSecret = totpSecretEnv;
    let mfaStatus = totpSecretEnv ? "✅已绑" : "";
    if (process.env.REG_TRY_MFA === "1" && !totpSecretEnv) {
        emit({type: "progress", stage: "mfa", message: "登录后绑定 TOTP…"});
        const accountId = decodeJwt(r.token)?.["https://api.openai.com/auth"]?.chatgpt_account_id || "";
        const mfa = await enrollTotp(r.token, {accountId, proxyUrl: process.env.PROXY_URL || ""});
        if (mfa.ok && mfa.secret) { totpSecret = mfa.secret; mfaStatus = "✅已绑"; emit({type: "progress", stage: "mfa", message: "TOTP 已绑定"}); }
        else if (mfa.ok && mfa.already) { mfaStatus = "⚠已有2FA缺密钥"; emit({type: "progress", stage: "mfa", message: "该号已有 2FA 但本次未拿到 secret"}); }
        else { mfaStatus = "❌" + (mfa.reason || "绑定失败"); emit({type: "progress", stage: "mfa", message: "TOTP 绑定失败: " + (mfa.reason || "")}); }
    }

    emit({
        type: "result",
        status: "success",
        email,
        password,
        gptPassword: password,
        totpSecret,
        mfaStatus,
        token: r.token,
        authFile: r.authFile,
    });
}

main()
    .then(() => process.exit(0))
    .catch((error) => {
        emit({type: "result", status: "failed", email, error: String(error?.message ?? error)});
        process.exit(1);
    });
