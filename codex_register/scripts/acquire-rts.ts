// @ts-nocheck
// 一次性脚本：用邮箱+密码走 codex OAuth 获取全新 rt
// 输入格式: email----mailPw----gptPw----oldRt
import {readFileSync, writeFileSync, mkdtempSync} from "fs";
import path from "path";
import os from "os";
import {appConfig} from "../src/config.js";

const INPUT = process.argv[2];
if (!INPUT) { console.error("用法: tsx scripts/acquire-rts.ts <输入文件>"); process.exit(1); }

const lines = readFileSync(INPUT, "utf8").split("\n").map(l => l.trim()).filter(Boolean);

// 把所有邮箱密码写到一个池文件，供 mailcom provider 收 OTP 用
const tmpDir = mkdtempSync(path.join(os.tmpdir(), "rt-all-"));
const poolFile = path.join(tmpDir, "pool.txt");
const poolLines = lines.map(l => { const p = l.split("----"); return `${p[0]}----${p[1]}`; });
writeFileSync(poolFile, poolLines.join("\n") + "\n");
process.env.MAILCOM_TOKENS_FILE = poolFile;
process.env.MAILCOM_HEADLESS = "1";
process.env.PROXY_URL = appConfig.defaultProxyUrl || "";
process.env.MAILCOM_PROXY = appConfig.mailProxyUrl || "";

// 动态导入(在设好环境变量后)
const {OpenAIClient} = await import("../src/openai.js");
const {generateRandomDeviceProfile} = await import("../src/device-profile.js");

const results: string[] = [];
for (const line of lines) {
    const parts = line.split("----");
    const email = parts[0];
    const gptPw = parts[2] || appConfig.defaultPassword;

    console.log(`\n${email}: 走 OAuth 获取新 rt...`);
    try {
        const deviceProfile = generateRandomDeviceProfile();
        const client = new OpenAIClient({email, password: gptPw, deviceProfile, manualMode: false});
        const result = await client.authLoginHTTP();
        const rec = client.lastSavedAuthRecord || {};
        const rt = rec.refresh_token || "";
        if (rt) {
            parts[3] = rt;
            console.log(`${email}: ✅ 获取成功 rt=${rt.slice(0, 30)}...`);
            results.push(parts.join("----"));
        } else {
            console.log(`${email}: ❌ 完成但无 rt`);
            results.push(line);
        }
    } catch (e) {
        console.log(`${email}: ❌ 失败 - ${e?.message || e}`);
        results.push(line);
    }
}

const outFile = INPUT.replace(/\.txt$/, "-new-rt.txt");
writeFileSync(outFile, results.join("\n") + "\n");
console.log(`\n结果已写入: ${outFile}`);
