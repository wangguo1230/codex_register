// @ts-nocheck
// mail.com 浏览器 worker：一个进程只处理一种短生命周期操作。
import {readFileSync} from "node:fs";
import {
    changeMailcomPassword,
    closeMailcomSessions,
    fetchInboxList,
    fetchMailBodyFor,
    setMailProxy,
    verifyMailcomLogin,
} from "../src/mail/mailcom.ts";

const EVENT_PREFIX = "@@EVENT@@";
const jobFile = process.argv[2] || "";
let stopping = false;

function emit(event) {
    return new Promise((resolve) => {
        try { process.stdout.write(EVENT_PREFIX + JSON.stringify(event) + "\n", () => resolve()); }
        catch { resolve(); }
    });
}

function log(message) {
    const text = String(message || "").replace(/\s+/g, " ").trim();
    if (text) {
        try { process.stdout.write(text.slice(0, 240) + "\n"); } catch { /* */ }
    }
}

process.once("SIGTERM", () => {
    stopping = true;
    void closeMailcomSessions();
});
process.once("SIGINT", () => {
    stopping = true;
    void closeMailcomSessions();
});

async function runTask(job) {
    const kind = String(job?.kind || "");
    const email = String(job?.email || "").trim();
    const password = job?.password;
    if (!email) throw new Error("mail.com worker 缺少邮箱");
    if (job?.proxy) setMailProxy(String(job.proxy));

    if (kind === "verify") {
        return verifyMailcomLogin(email, password, log, job.opts || {});
    }
    if (kind === "change-password") {
        return changeMailcomPassword(
            email,
            password,
            String(job?.newPassword || ""),
            log,
            job.opts || {},
        );
    }
    if (kind === "inbox-list") {
        return {mails: await fetchInboxList(email, String(password || ""), Number(job?.amount) || 20)};
    }
    if (kind === "inbox-body") {
        // worker 没有跨请求会话，先登录建立本进程缓存，再取正文，结束时统一关浏览器。
        await fetchInboxList(email, String(password || ""), 1);
        return {body: await fetchMailBodyFor(email, String(job?.mailId || ""))};
    }
    throw new Error(`mail.com worker 不支持任务类型: ${kind}`);
}

async function finish(status, result = {}, error = "") {
    await closeMailcomSessions();
    await emit({type: "result", status, result: result || {}, error: String(error || "").slice(0, 240), stopped: stopping});
}

if (!jobFile) {
    await finish("failed", {}, "缺少任务文件");
    process.exit(1);
}

try {
    const job = JSON.parse(readFileSync(jobFile, "utf8"));
    const result = await runTask(job);
    await finish(result?.ok === false ? "failed" : "success", result, result?.ok === false ? result?.error || result?.detail : "");
    process.exit(result?.ok === false ? 2 : 0);
} catch (error) {
    await finish("failed", {}, String(error?.message || error));
    process.exit(1);
}
