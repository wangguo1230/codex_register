// @ts-nocheck
// Gmail 浏览器 worker：一个进程只处理一个邮箱的一种操作。
import {readFileSync} from "node:fs";
import {change2faOnPage, changePasswordOnPage} from "../src/mail/google-manage.ts";
import {runGoogleHardenWithBit, withGoogleBitSession} from "../src/mail/google-secure.ts";

const EVENT_PREFIX = "@@EVENT@@";
const jobFile = process.argv[2] || "";
const controller = new AbortController();
let stopping = false;

function emit(event) {
    return new Promise((resolve) => {
        try {
            process.stdout.write(EVENT_PREFIX + JSON.stringify(event) + "\n", () => resolve());
        } catch {
            resolve();
        }
    });
}

function log(message) {
    const text = String(message || "").replace(/\s+/g, " ").trim();
    if (text) {
        try { process.stdout.write(text.slice(0, 240) + "\n"); } catch { /* */ }
    }
}

async function checkpoint(patch) {
    await emit({type: "checkpoint", patch: patch || {}});
}

async function closeWindows() {
    try {
        const {closeTrackedBitWindows} = await import("../src/bitbrowser.ts");
        await closeTrackedBitWindows();
    } catch { /* worker 退出时尽力清理 */ }
}

process.once("SIGTERM", () => {
    stopping = true;
    controller.abort();
    void closeWindows();
});
process.once("SIGINT", () => {
    stopping = true;
    controller.abort();
    void closeWindows();
});

function mailboxFromJob(job) {
    const mb = job?.mailbox || {};
    return {
        email: String(mb.email || ""),
        password: String(mb.password || ""),
        totp_secret: String(mb.totp_secret || mb.mailbox_totp || ""),
        mailbox_totp: String(mb.mailbox_totp || mb.totp_secret || ""),
        recovery_email: String(mb.recovery_email || ""),
        imap_password: String(mb.imap_password || mb.mailbox_imap || ""),
        pw_status: String(mb.pw_status || ""),
        google_state: mb.google_state || {},
    };
}

async function runTask(job) {
    const kind = String(job?.kind || "");
    const mb = mailboxFromJob(job);
    const proxyUrl = String(job?.proxyUrl || "");
    const jumpUrl = String(job?.jumpUrl || "");
    const email = mb.email;
    if (!email) throw new Error("Gmail worker 缺少邮箱");
    if (!["harden", "password", "totp"].includes(kind)) {
        throw new Error(`Gmail worker 不支持任务类型: ${kind}`);
    }

    if (kind === "harden") {
        return runGoogleHardenWithBit(mb, {
            proxyUrl,
            jumpUrl,
            signal: controller.signal,
            log,
            onProxy: (url, ip) => emit({type: "proxy", url, ip}),
            onCheckpoint: async (patch) => checkpoint(patch),
        });
    }

    const name = kind === "password" ? "pw" : "2fa";
    return withGoogleBitSession({
        proxyUrl,
        jumpUrl,
        name: `${name}-${email.split("@")[0].slice(0, 12)}`,
        remark: `gmail-${name}`,
        signal: controller.signal,
        log,
        onProxy: (url, ip) => emit({type: "proxy", url, ip}),
    }, async (page, sess) => {
        if (kind === "password") {
            return changePasswordOnPage(page, {
                email,
                password: mb.password,
                totpSecret: mb.totp_secret,
                recoveryEmail: mb.recovery_email,
                newPassword: String(job?.newPassword || ""),
                log,
                onPersist: async (patch) => checkpoint(patch),
                onLoggedIn: () => sess?.markLoggedIn?.(),
            });
        }
        if (kind === "totp") {
            return change2faOnPage(page, {
                email,
                password: mb.password,
                totpSecret: mb.totp_secret,
                recoveryEmail: mb.recovery_email,
                log,
                onPersist: async (patch) => checkpoint(patch),
                onLoggedIn: () => sess?.markLoggedIn?.(),
            });
        }
    });
}

if (!jobFile) {
    await emit({type: "result", status: "failed", error: "缺少任务文件"});
    process.exit(1);
}

try {
    const job = JSON.parse(readFileSync(jobFile, "utf8"));
    const result = await runTask(job);
    await emit({
        type: "result",
        status: result?.ok === false ? "failed" : "success",
        result: result || {},
        error: result?.ok === false ? String(result?.error || result?.detail || "") : "",
        stopped: stopping,
    });
    process.exit(result?.ok === false ? 2 : 0);
} catch (error) {
    await emit({
        type: "result",
        status: "failed",
        error: String(error?.message || error).slice(0, 240),
        stopped: stopping,
    });
    await closeWindows();
    process.exit(1);
}
