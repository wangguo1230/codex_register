// @ts-nocheck
// 触发 OpenAI 给指定邮箱发 OTP（用于测试邮箱收件 API）
import {OpenAIClient} from "../src/openai.js";
import {generateRandomDeviceProfile} from "../src/device-profile.js";
import {appConfig} from "../src/config.js";

const email = process.argv[2];
if (!email) { console.error("用法: tsx scripts/trigger-otp.ts <email>"); process.exit(1); }

const client = new OpenAIClient({
    email,
    password: appConfig.defaultPassword,
    deviceProfile: generateRandomDeviceProfile(),
    manualMode: true, // 到 OTP 步骤会等待手动输入,我们不输入让它超时
});

console.log(`触发 OTP 发送到 ${email}...`);
try {
    await client.authRegisterHTTP();
} catch (e) {
    console.log("预期中断:", e?.message?.slice(0, 120));
}
console.log("OTP 应该已发送，现在查收件箱");
