// @ts-nocheck
// 官方换绑 HTTP：协议 worker，跳板+GPT 池，不进 :3100。
import {readFileSync} from "node:fs";
import {installWorkerProxyFromEnv} from "../src/mail/install-worker-proxy.js";
import {changeChatgptEmail} from "../src/change-email.js";

const jobFile = process.argv[2] || "";
if (!jobFile) {
    process.stdout.write("@@RESULT@@" + JSON.stringify({ok: false, reason: "缺少任务文件"}) + "\n");
    process.exit(1);
}

const job = JSON.parse(readFileSync(jobFile, "utf8"));
await installWorkerProxyFromEnv();

// 阶段实时上报：父进程超时把我杀掉时，靠最后一个 stage 判断官方侧状态确不确定。
let lastStage = "precheck";
const reportStage = (stage) => {
    lastStage = stage;
    process.stdout.write("@@EVENT@@" + JSON.stringify({type: "progress", stage}) + "\n");
};

try {
    const r = await changeChatgptEmail({
        accessToken: job.accessToken || "",
        accountId: job.accountId || "",
        proxyUrl: process.env.PROXY_URL || job.proxyUrl || "",
        newEmail: job.newEmail || "",
        imapPassword: job.imapPassword || "",
        mailPassword: job.mailPassword || "",
        totpSecret: job.totpSecret || "",
        socialUser: !!job.socialUser,
        useAddEmail: !!job.useAddEmail,
        onStage: reportStage,
    });
    process.stdout.write("@@RESULT@@" + JSON.stringify({
        ok: !!r.ok,
        reason: r.reason || "",
        needReauth: !!r.needReauth,
        alreadyLinked: !!r.alreadyLinked,
        badTarget: !!r.badTarget,
        rateLimited: !!r.rateLimited,
        capped24h: !!r.capped24h,
        indeterminate: !!r.indeterminate,
        code: r.code || "",
        stage: r.stage || lastStage,
    }) + "\n");
    process.exit(r.ok ? 0 : 2);
} catch (e) {
    process.stdout.write("@@RESULT@@" + JSON.stringify({
        ok: false,
        reason: String(e?.message || e).slice(0, 240),
        stage: lastStage,
    }) + "\n");
    process.exit(1);
}
