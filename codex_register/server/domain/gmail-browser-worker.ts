// @ts-nocheck
// Gmail 浏览器任务边界：主进程只负责租约和状态，CDP/代理链全部在子进程。
import {mkdtempSync, rmSync, writeFileSync} from "node:fs";
import {spawn} from "node:child_process";
import os from "node:os";
import path from "node:path";
import {attachBoundedStdio} from "../bounded-stdio.js";
import {resolveProjectRoot, resolveWorkerCommand} from "../runtime-root.js";
import {cleanSpawnEnv} from "../strip-env-proxy.js";

const ROOT = resolveProjectRoot(import.meta.url);
const WORKER = resolveWorkerCommand(
    import.meta.url,
    ROOT,
    "scripts/worker-gmail-task.ts",
    "bundle/workers/worker-gmail-task.mjs",
);

const DEFAULT_IDLE_MS = Math.max(60_000, Number(process.env.GMAIL_WORKER_IDLE_MS || 180_000));
const DEFAULT_MAX_MS = Math.max(DEFAULT_IDLE_MS * 2, Number(process.env.GMAIL_WORKER_MAX_MS || 1_200_000));
const DEFAULT_GRACE_MS = Math.max(3_000, Number(process.env.GMAIL_WORKER_GRACE_MS || 12_000));

function killTree(child, signal = "SIGTERM") {
    try {
        if (process.platform !== "win32" && child?.pid) {
            process.kill(-child.pid, signal);
        } else {
            child?.kill?.(signal);
        }
    } catch {
        try { child?.kill?.(signal); } catch { /* 子进程已退出 */ }
    }
}

function taskTimeout(kind) {
    if (kind === "harden") return Math.max(DEFAULT_IDLE_MS, Number(process.env.GMAIL_HARDEN_MAX_MS || 1_200_000));
    if (kind === "totp") return Math.max(DEFAULT_IDLE_MS, Number(process.env.GMAIL_TOTP_MAX_MS || 600_000));
    return Math.max(DEFAULT_IDLE_MS, Number(process.env.GMAIL_PASSWORD_MAX_MS || 480_000));
}

/**
 * 派一个 Gmail 浏览器任务。
 * - 普通日志只向上游传短行；
 * - checkpoint 先落库再继续；
 * - idle/max 超时会 SIGTERM，宽限期后 SIGKILL，不留下孤儿 Chrome/relay；
 * - 外部 abort 只停止本任务，不影响其它邮箱任务。
 */
export function runGmailBrowserTask(task, {
    log = () => {},
    onCheckpoint = async () => {},
    onProxy = () => {},
    signal,
    idleMs = DEFAULT_IDLE_MS,
    maxMs = taskTimeout(task?.kind),
    graceMs = DEFAULT_GRACE_MS,
} = {}) {
    const jobDir = mkdtempSync(path.join(os.tmpdir(), "gmail-task-"));
    const jobFile = path.join(jobDir, "job.json");
    writeFileSync(jobFile, JSON.stringify(task || {}), "utf8");

    return new Promise((resolve) => {
        let child = null;
        let result = null;
        let settled = false;
        let stopping = false;
        let stopReason = "";
        let idleTimer = null;
        let maxTimer = null;
        let graceTimer = null;
        let resultTimer = null;
        let checkpointChain = Promise.resolve();

        const clearTimers = () => {
            for (const timer of [idleTimer, maxTimer, graceTimer, resultTimer]) {
                if (timer) clearTimeout(timer);
            }
            idleTimer = maxTimer = graceTimer = resultTimer = null;
        };
        const cleanup = () => {
            clearTimers();
            try { rmSync(jobDir, {recursive: true, force: true}); } catch { /* */ }
        };
        const finish = (value) => {
            if (settled) return;
            settled = true;
            cleanup();
            resolve(value);
        };
        const armIdle = () => {
            if (idleTimer) clearTimeout(idleTimer);
            if (settled || stopping) return;
            idleTimer = setTimeout(() => stop(`连续 ${Math.round(idleMs / 1000)}s 无新步骤`), idleMs);
        };
        const stop = (reason) => {
            if (settled || stopping) return;
            stopping = true;
            stopReason = String(reason || "任务停止");
            try { log(`[gmail-worker] ${stopReason}，SIGTERM 收尾`); } catch { /* */ }
            killTree(child, "SIGTERM");
            graceTimer = setTimeout(() => killTree(child, "SIGKILL"), Math.max(1_000, graceMs));
        };
        const touch = () => {
            armIdle();
        };
        const acceptEvent = (event) => {
            touch();
            if (!event || typeof event !== "object") return;
            if (event.type === "checkpoint") {
                checkpointChain = checkpointChain
                    .then(() => onCheckpoint(event.patch || {}))
                    .catch((error) => {
                        try { log(`[gmail-worker] checkpoint 写回失败: ${String(error?.message || error).slice(0, 120)}`); } catch { /* */ }
                    });
                return;
            }
            if (event.type === "proxy") {
                try { onProxy(String(event.url || ""), String(event.ip || "")); } catch { /* */ }
                return;
            }
            if (event.type === "progress") {
                try { log(String(event.message || "").slice(0, 220)); } catch { /* */ }
                return;
            }
            if (event.type === "result") {
                result = event;
                if (resultTimer) clearTimeout(resultTimer);
                // RESULT 已经包含业务结果；给 worker 一小段时间自行关闭浏览器。
                resultTimer = setTimeout(() => {
                    if (!settled) killTree(child, "SIGTERM");
                }, 5_000);
            }
        };

        const onAbort = () => stop("收到取消信号");
        if (signal) {
            if (signal.aborted) onAbort();
            else signal.addEventListener("abort", onAbort, {once: true});
        }

        try {
            child = spawn(WORKER.command, [...WORKER.args, jobFile], {
                cwd: ROOT,
                env: cleanSpawnEnv({
                    // worker 允许自己创建 relay；主进程的 CODEX_HTTP 禁止规则不能继承。
                    CODEX_HTTP: "",
                    GMAIL_WORKER: "1",
                    MAILCOM_WORKER: "1",
                }),
                stdio: ["ignore", "pipe", "pipe"],
                detached: process.platform !== "win32",
            });
        } catch (error) {
            if (signal) signal.removeEventListener?.("abort", onAbort);
            cleanup();
            resolve({ok: false, error: `启动 Gmail worker 失败: ${String(error?.message || error)}`});
            return;
        }
        if (stopping) killTree(child, "SIGTERM");

        child.on("error", (error) => {
            if (settled) return;
            finish({
                ok: false,
                error: String(error?.message || error).slice(0, 240),
                stopped: stopping,
            });
        });
        attachBoundedStdio(child, {
            maxBuf: 512 * 1024,
            onLine: (line) => {
                touch();
                try { log(String(line).slice(0, 220)); } catch { /* */ }
            },
            onEvent: acceptEvent,
        });
        child.once("close", async () => {
            if (signal) signal.removeEventListener?.("abort", onAbort);
            await checkpointChain;
            if (result) {
                finish({
                    ...result.result,
                    ok: result.status === "success" ? true : !!result.result?.ok,
                    error: result.error || result.result?.error || "",
                    workerStatus: result.status || "",
                    stopped: stopping,
                });
                return;
            }
            finish({
                ok: false,
                error: stopReason || "Gmail worker 无结果",
                stopped: stopping,
            });
        });

        armIdle();
        maxTimer = setTimeout(() => stop(`已跑满 ${Math.round(maxMs / 60_000)} 分钟上限`), maxMs);
    });
}
