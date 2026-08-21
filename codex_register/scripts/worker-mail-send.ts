// @ts-nocheck
// 子进程发信：CATS mailsubmission + Playwright。禁止跑在 :3100 主进程里（本地 socks relay 会把 RSS 打爆）。
import {readFileSync} from "node:fs";
import {sendMailcomMail} from "../src/mail/mailcom.ts";

const jobFile = process.argv[2] || "";
if (!jobFile) {
    process.stdout.write("@@RESULT@@" + JSON.stringify({ok: false, error: "缺少任务文件"}) + "\n");
    process.exit(1);
}

const job = JSON.parse(readFileSync(jobFile, "utf8"));

try {
    const r = await sendMailcomMail(job.email, job.password, {
        to: job.to,
        subject: job.subject,
        html: job.html,
        text: job.text,
        fromName: job.fromName,
        headless: job.headless ?? true,
        proxy: job.proxy,
        jump: job.jump,
        profile: job.profile,
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
