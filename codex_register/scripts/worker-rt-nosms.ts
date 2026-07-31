// @ts-nocheck
// 获取 rt 的 worker(不带接码) —— Pro 号不触发 add-phone，跳过 smsBroker。
// 与 src/worker-rt.ts 相同流程，但不创建接码池，add-phone 会直接抛错。
import {generateRandomDeviceProfile} from "../src/device-profile.js";
import {OpenAIClient} from "../src/openai.js";
import {appConfig} from "../src/config.js";

const EVENT_PREFIX = "@@EVENT@@";
const email = (process.env.REG_EMAIL || "").trim();
const password = appConfig.defaultPassword.trim();

function emit(event) {
    process.stdout.write(EVENT_PREFIX + JSON.stringify(event) + "\n");
}

async function main() {
    if (!email) {
        emit({type: "result", status: "failed", email: "", error: "缺少 REG_EMAIL"});
        process.exit(1);
        return;
    }
    emit({type: "progress", stage: "rt", message: `开始为 ${email} 获取 refresh_token(无接码模式)…`});

    const deviceProfile = generateRandomDeviceProfile();
    // 不传 smsBroker → add-phone 不会被处理,Pro 号不触发则无影响
    const client = new OpenAIClient({email, password, deviceProfile, manualMode: false});

    const result = await client.authLoginHTTP();
    const rec = client.lastSavedAuthRecord || {};
    const rt = rec.refresh_token || "";
    if (!rt) throw new Error("authLoginHTTP 完成但未解析到 refresh_token");
    emit({type: "progress", stage: "rt", message: `✅ 拿到 refresh_token: ${rt.slice(0, 28)}...  codex文件: ${result.authFile}`});

    emit({
        type: "result",
        status: "success",
        email,
        rtFile: result.authFile || "",
        rt,
        phone: "",
        card: "",
    });
}

main()
    .then(() => process.exit(0))
    .catch((error) => {
        emit({type: "result", status: "failed", email, error: String(error?.message ?? error)});
        process.exit(1);
    });
