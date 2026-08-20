// @ts-nocheck
// mail.com 浏览器任务边界：HTTP 主进程只负责派发和接收结果。
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
    "scripts/worker-mailcom-task.ts",
    "bundle/workers/worker-mailcom-task.mjs",
);
const DEFAULT_IDLE_MS = Math.max(60_000, Number(process.env.MAILCOM_WORKER_IDLE_MS || 180_000));
const DEFAULT_MAX_MS = Math.max(DEFAULT_IDLE_MS * 2, Number(process.env.MAILCOM_WORKER_MAX_MS || 600_000));
const DEFAULT_GRACE_MS = Math.max(3_000, Number(process.env.MAILCOM_WORKER_GRACE_MS || 10_000));

function killTree(child, signal = "SIGTERM") {
    try {
        if (process.platform !== "win32" && child?.pid) process.kill(-child.pid, signal);
        else child?.kill?.(signal);
    } catch {
        try { child?.kill?.(signal); } catch { /* 子进程已退出 */ }
    }
}

function taskTimeout(task) {
    const kind = String(task?.kind || "");
    if (kind === "change-password") return Math.max(DEFAULT_IDLE_MS, Number(process.env.MAILCOM_CHANGE_PASSWORD_MAX_MS || 480_000));
    return Math.max(DEFAULT_IDLE_MS, Number(process.env.MAILCOM_INBOX_MAX_MS || 180_000));
}

export function runMailcomBrowserTask(task, {
    log = () => {},
    signal,
    idleMs = DEFAULT_IDLE_MS,
    maxMs = taskTimeout(task),
    graceMs = DEFAULT_GRACE_MS,
} = {}) {
    const jobDir = mkdtempSync(path.join(os.tmpdir(), "mailcom-task-"));
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
            mailcomBrowserWorkerRunner.untrack(child);
            cleanup();
            resolve(value);
        };
        const armIdle = () => {
            if (idleTimer) clearTimeout(idleTimer);
            if (settled || stopping) return;
            idleTimer = setTimeout(() => stop(`连续 ${Math.round(idleMs / 1000)}s 无新步骤`), idleMs);
            idleTimer?.unref?.();
        };
        const stop = (reason) => {
            if (settled || stopping) return;
            stopping = true;
            stopReason = String(reason || "任务停止");
            try { log(`[mailcom-worker] ${stopReason}，SIGTERM 收尾`); } catch { /* */ }
            killTree(child, "SIGTERM");
            graceTimer = setTimeout(() => killTree(child, "SIGKILL"), Math.max(1_000, graceMs));
            graceTimer?.unref?.();
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
                    CODEX_HTTP: "",
                    MAILCOM_WORKER: "1",
                    MAILCOM_HEADLESS: task?.headless === false ? "0" : (process.env.MAILCOM_HEADLESS || "1"),
                }),
                stdio: ["ignore", "pipe", "pipe"],
                detached: process.platform !== "win32",
            });
        } catch (error) {
            if (signal) signal.removeEventListener?.("abort", onAbort);
            cleanup();
            resolve({ok: false, error: `启动 mail.com worker 失败: ${String(error?.message || error)}`});
            return;
        }
        mailcomBrowserWorkerRunner.track(child);
        if (stopping) killTree(child, "SIGTERM");

        const acceptEvent = (event) => {
            if (!event || typeof event !== "object") return;
            armIdle();
            if (event.type === "result") {
                result = event;
                if (resultTimer) clearTimeout(resultTimer);
                resultTimer = setTimeout(() => killTree(child, "SIGTERM"), 5_000);
                resultTimer?.unref?.();
            }
        };
        child.on("error", (error) => finish({
            ok: false,
            error: String(error?.message || error).slice(0, 240),
            stopped: stopping,
        }));
        attachBoundedStdio(child, {
            maxBuf: 2 * 1024 * 1024,
            onLine: (line) => {
                armIdle();
                try { log(String(line).slice(0, 220)); } catch { /* */ }
            },
            onEvent: acceptEvent,
        });
        child.once("close", () => {
            if (signal) signal.removeEventListener?.("abort", onAbort);
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
            finish({ok: false, error: stopReason || "mail.com worker 无结果", stopped: stopping});
        });

        armIdle();
        maxTimer = setTimeout(() => stop(`已跑满 ${Math.round(maxMs / 60_000)} 分钟上限`), maxMs);
        maxTimer?.unref?.();
    });
}

export function createMailcomBrowserWorkerRunner() {
    const children = new Set();
    const killTimers = new Map();

    const untrack = (child) => {
        if (!child) return;
        children.delete(child);
        const timer = killTimers.get(child);
        if (timer) clearTimeout(timer);
        killTimers.delete(child);
    };

    const stopAll = () => {
        const active = [...children];
        for (const child of active) {
            killTree(child, "SIGTERM");
            const timer = setTimeout(() => {
                killTree(child, "SIGKILL");
                children.delete(child);
                killTimers.delete(child);
            }, DEFAULT_GRACE_MS);
            timer?.unref?.();
            killTimers.set(child, timer);
        }
        return active.length;
    };

    return {track: (child) => children.add(child), untrack, stopAll, activeCount: () => children.size};
}

export const mailcomBrowserWorkerRunner = createMailcomBrowserWorkerRunner();
