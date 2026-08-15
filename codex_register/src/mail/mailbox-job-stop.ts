// 邮箱管理任务停止旗标 + 独立脚本进度。控制台、整备脚本、比特关窗共用。
import {existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync} from "node:fs";
import path from "node:path";
import {fileURLToPath} from "node:url";

const DATA_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../data");
const STOP_PATH = path.join(DATA_DIR, "mailbox-job.stop");
const PROG_PATH = path.join(DATA_DIR, "mailbox-job.json");

export function mailboxJobStopPath() { return STOP_PATH; }
export function mailboxJobProgressPath() { return PROG_PATH; }

export function requestMailboxJobStop() {
    mkdirSync(path.dirname(STOP_PATH), {recursive: true});
    writeFileSync(STOP_PATH, `${Date.now()}\n`, "utf8");
}

export function mailboxJobStopAgeMs() {
    try {
        const t = Number(String(readFileSync(STOP_PATH, "utf8") || "").trim());
        if (Number.isFinite(t) && t > 0) return Math.max(0, Date.now() - t);
        return existsSync(STOP_PATH) ? Date.now() : 0;
    } catch {
        return 0;
    }
}

/** 改密/换2FA 进行中：停任务也不能立刻关窗，否则 Google 已生效、库还是旧钥匙。 */
let criticalCount = 0;
export function enterMailJobCritical() {
    criticalCount += 1;
    let left = false;
    return () => {
        if (left) return;
        left = true;
        criticalCount = Math.max(0, criticalCount - 1);
    };
}
export function mailJobInCritical() {
    return criticalCount > 0;
}

/** 登录等非改钥步骤：停了约 2.5s 可关。正在改密/换2FA：最多等到 graceMs。 */
export function shouldForceDropWindow(graceMs = 70_000) {
    if (!isMailboxJobStopped()) return false;
    const age = mailboxJobStopAgeMs();
    if (mailJobInCritical()) return age >= graceMs;
    return age >= 2500;
}

export function clearMailboxJobStop() {
    try { unlinkSync(STOP_PATH); } catch { /* no file */ }
}

export function isMailboxJobStopped() {
    return existsSync(STOP_PATH);
}

export function writeMailboxJobProgress(p = {}) {
    mkdirSync(DATA_DIR, {recursive: true});
    writeFileSync(PROG_PATH, JSON.stringify({
        running: !!p.running,
        kind: p.kind || "harden",
        done: Number(p.done || 0),
        total: Number(p.total || 0),
        ok: Number(p.ok || 0),
        fail: Number(p.fail || 0),
        current: Array.isArray(p.current) ? p.current : [],
        lastLine: String(p.lastLine || ""),
        ts: Date.now(),
        source: p.source || "cli",
    }), "utf8");
}

export function readMailboxJobProgress(maxAgeMs = 45 * 60 * 1000) {
    try {
        const j = JSON.parse(readFileSync(PROG_PATH, "utf8"));
        if (!j || Date.now() - Number(j.ts || 0) > maxAgeMs) return null;
        return j;
    } catch {
        return null;
    }
}

export function clearMailboxJobProgress() {
    try { unlinkSync(PROG_PATH); } catch { /* */ }
}
