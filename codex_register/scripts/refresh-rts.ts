// 一次性脚本：读取 email----mailPw----gptPw----rt 格式文件，刷新 rt，输出替换后的结果
import {refreshRt, buildProxyDispatcher} from "../src/token-check.js";
import {readFileSync, writeFileSync} from "fs";
import {appConfig} from "../src/config.js";

const INPUT = process.argv[2];
if (!INPUT) { console.error("用法: tsx scripts/refresh-rts.ts <输入文件>"); process.exit(1); }

const lines = readFileSync(INPUT, "utf8").split("\n").map(l => l.trim()).filter(Boolean);
const dispatcher = buildProxyDispatcher(appConfig.defaultProxyUrl);

const results: string[] = [];
for (const line of lines) {
    const parts = line.split("----");
    const email = parts[0];
    const oldRt = parts[3] || "";
    if (!oldRt) { console.log(`${email}: 无旧 rt，跳过`); results.push(line); continue; }

    console.log(`${email}: 刷新 rt...`);
    const r = await refreshRt(oldRt, dispatcher);
    if (r.ok && r.tokens) {
        const newRt = r.tokens.refresh_token || oldRt;
        parts[3] = newRt;
        console.log(`${email}: ✅ 刷新成功`);
        results.push(parts.join("----"));
    } else {
        console.log(`${email}: ❌ 刷新失败 - ${r.reason}`);
        results.push(line);
    }
}

const outFile = INPUT.replace(/\.txt$/, "-refreshed.txt");
writeFileSync(outFile, results.join("\n") + "\n");
console.log(`\n结果已写入: ${outFile}`);
