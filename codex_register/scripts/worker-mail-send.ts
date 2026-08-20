// @ts-nocheck
// 子进程发信：Playwright + 跳板不能跑在 :3100 里，否则整站卡死，前端看到 500。
import {readFileSync} from "node:fs";
import {sendMailcomSmtp} from "../src/mail/mailcom-smtp.ts";

const jobFile = process.argv[2] || "";
if (!jobFile) {
    process.stdout.write("@@RESULT@@" + JSON.stringify({ok: false, error: "缺少任务文件"}) + "\n");
    process.exit(1);
}

const job = JSON.parse(readFileSync(jobFile, "utf8"));

try {
    const r = await sendMailcomSmtp({
        email: job.email,
        password: job.password,
        to: job.to,
        subject: job.subject,
        html: job.html,
        text: job.text,
        fromName: job.fromName,
        headless: job.headless ?? true,
        proxy: job.proxy,
        jump: job.jump,
        timeoutMs: Number(process.env.MAILCOM_SMTP_TIMEOUT_MS || 30_000),
    });
    process.stdout.write("@@RESULT@@" + JSON.stringify({
        ok: true,
        status: r.status,
        location: r.location || "",
        from: job.email,
        to: job.to,
        subject: job.subject,
        proxySession: r.proxySession || "",
    }) + "\n");
} catch (e) {
    process.stdout.write("@@RESULT@@" + JSON.stringify({
        ok: false,
        error: String((e as Error)?.message || e).slice(0, 300),
    }) + "\n");
    process.exitCode = 1;
}
