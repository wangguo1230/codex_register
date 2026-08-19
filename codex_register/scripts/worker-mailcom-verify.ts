// 子进程验 mail.com 密码。Playwright 不能挂在 :3100。
import {readFileSync} from "node:fs";
import {verifyMailcomLogin} from "../src/mail/mailcom.ts";

const jobFile = process.argv[2] || "";
if (!jobFile) {
    process.stdout.write("@@RESULT@@" + JSON.stringify({ok: false, reason: "缺少任务文件", wrongPassword: false}) + "\n");
    process.exit(1);
}
const job = JSON.parse(readFileSync(jobFile, "utf8"));
try {
    const r = await verifyMailcomLogin(
        job.email,
        job.password,
        (m) => { process.stdout.write(String(m || "").slice(0, 200) + "\n"); },
        job.opts || {},
    );
    process.stdout.write("@@RESULT@@" + JSON.stringify({
        ok: !!r?.ok,
        reason: String(r?.reason || "").slice(0, 200),
        wrongPassword: !!r?.wrongPassword,
    }) + "\n");
    process.exit(r?.ok ? 0 : 1);
} catch (e) {
    process.stdout.write("@@RESULT@@" + JSON.stringify({
        ok: false,
        reason: String((e as Error)?.message || e).slice(0, 200),
        wrongPassword: false,
    }) + "\n");
    process.exit(1);
}
