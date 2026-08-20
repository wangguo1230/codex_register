// @ts-nocheck
import {spawn} from "node:child_process";
import {unlinkSync, writeFileSync} from "node:fs";
import os from "node:os";
import path from "node:path";
import {attachBoundedStdio} from "../bounded-stdio.js";
import {resolveProjectRoot, resolveWorkerCommand} from "../runtime-root.js";
import {cleanSpawnEnv} from "../strip-env-proxy.js";

export function createMailSendWorkerRunner({rootDir, timeoutMs = 180_000, spawnProcess = spawn, clock = globalThis} = {}) {
    const worker = resolveWorkerCommand(
        import.meta.url,
        rootDir,
        "scripts/worker-mail-send.ts",
        "bundle/workers/worker-mail-send.mjs",
    );
    const children = new Set();
    const killTimers = new Map();

    function signal(child, name) {
        try {
            if (process.platform !== "win32" && child.pid) process.kill(-child.pid, name);
            else child.kill(name);
        } catch {
            try { child.kill(name); } catch { /* */ }
        }
    }

    function untrack(child) {
        children.delete(child);
        const timer = killTimers.get(child);
        if (timer) clock.clearTimeout(timer);
        killTimers.delete(child);
    }

    function stopAll() {
        const active = [...children];
        for (const child of active) {
            signal(child, "SIGTERM");
            const timer = clock.setTimeout(() => {
                signal(child, "SIGKILL");
                untrack(child);
            }, 5000);
            timer?.unref?.();
            killTimers.set(child, timer);
        }
        return active.length;
    }

    function run(job, log = () => {}) {
        const jobFile = path.join(os.tmpdir(), `mail-send-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`);
        writeFileSync(jobFile, JSON.stringify(job));
        return new Promise((resolve, reject) => {
            let child;
            try {
                child = spawnProcess(worker.command, [...worker.args, jobFile], {
                    cwd: rootDir,
                    env: cleanSpawnEnv({MAILCOM_HEADLESS: job.headless === false ? "0" : "1"}),
                    stdio: ["ignore", "pipe", "pipe"],
                    detached: process.platform !== "win32",
                });
            } catch (error) {
                try { unlinkSync(jobFile); } catch { /* */ }
                reject(error);
                return;
            }
            children.add(child);
            let settled = false;
            let result = null;
            const tail = [];
            const pending = attachBoundedStdio(child, {
                onLine: (line) => {
                    const text = String(line || "").slice(0, 220);
                    tail.push(text);
                    if (tail.length > 20) tail.shift();
                    log(text);
                },
                onEvent: (event) => {
                    result = event;
                    if (event?.ok === false) {
                        const reason = String(event?.error || event?.reason || "worker 未返回失败原因")
                            .replace(/\s+/g, " ")
                            .slice(0, 240);
                        log(`[发信 worker] 失败 ${reason}`);
                        signal(child, "SIGKILL");
                        finish(reject, new Error(reason));
                    }
                },
            });
            const timer = clock.setTimeout(() => {
                signal(child, "SIGKILL");
                finish(reject, new Error(`发信超时 ${Math.round(timeoutMs / 1000)}s`));
            }, timeoutMs);
            timer?.unref?.();
            const finish = (fn, value) => {
                if (settled) return;
                settled = true;
                clock.clearTimeout(timer);
                untrack(child);
                try { unlinkSync(jobFile); } catch { /* */ }
                fn(value);
            };
            child.once("error", (error) => {
                if (settled) return;
                finish(reject, error);
            });
            child.once("close", (code) => {
                if (settled) return;
                if (!result) {
                    const rest = String(pending() || "").trim();
                    const marker = rest.lastIndexOf("@@RESULT@@");
                    if (marker >= 0) {
                        try { result = JSON.parse(rest.slice(marker + "@@RESULT@@".length)); } catch { /* */ }
                    }
                }
                if (result?.ok) return finish(resolve, result);
                const reason = result?.error || tail.join(" ") || `worker exit ${code}`;
                log(`[发信 worker] 退出 code=${code} ${String(reason).replace(/\s+/g, " ").slice(-240)}`);
                finish(reject, new Error(String(reason).replace(/\s+/g, " ").slice(-240)));
            });
        });
    }

    return {run, stopAll, activeCount: () => children.size};
}

const ROOT = resolveProjectRoot(import.meta.url);
const SEND_WORKER_MS = Math.max(60_000, Number(process.env.MAILCOM_SEND_TIMEOUT_MS || 90_000));
export const mailSendWorkerRunner = createMailSendWorkerRunner({rootDir: ROOT, timeoutMs: SEND_WORKER_MS});
