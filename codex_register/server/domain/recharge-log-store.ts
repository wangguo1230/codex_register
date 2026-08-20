// @ts-nocheck
// 充值审计日志的内存窗口与延迟落盘，不依赖 HTTP/SSE。
import {existsSync, readFileSync} from "node:fs";
import {writeFile as writeFileAsync} from "node:fs/promises";

export function createRechargeLogStore({
    filePath,
    maxEntries = 2000,
    flushDelayMs = 400,
    onAppend = () => {},
    writeFile = writeFileAsync,
} = {}) {
    let entries = [];
    let flushTimer = null;
    let flushPromise = null;
    let dirty = false;

    function load() {
        try {
            if (!filePath || !existsSync(filePath)) return;
            const rows = readFileSync(filePath, "utf8").split(/\r?\n/).filter(Boolean);
            entries = rows.slice(-maxEntries)
                .map((row) => {
                    try { return JSON.parse(row); } catch { return {ts: 0, line: row}; }
                })
                .filter((entry) => entry && entry.line);
        } catch { /* 损坏日志不影响服务启动 */ }
    }

    function flush() {
        if (flushTimer) clearTimeout(flushTimer);
        flushTimer = null;
        dirty = true;
        if (flushPromise) return flushPromise;
        flushPromise = (async () => {
            do {
                dirty = false;
                const payload = entries.map((entry) => JSON.stringify(entry)).join("\n") + (entries.length ? "\n" : "");
                try {
                    await writeFile(filePath, payload, "utf8");
                } catch { /* 日志落盘失败不阻断业务任务 */ }
            } while (dirty);
        })().finally(() => {
            flushPromise = null;
            if (dirty) void flush();
        });
        return flushPromise;
    }

    function scheduleFlush() {
        if (flushTimer) return;
        if (flushPromise) {
            dirty = true;
            return;
        }
        flushTimer = setTimeout(() => { void flush(); }, flushDelayMs);
        flushTimer?.unref?.();
    }

    function append(line) {
        const entry = {ts: Date.now(), line: String(line || "")};
        entries.push(entry);
        if (entries.length > maxEntries) entries = entries.slice(-maxEntries);
        scheduleFlush();
        try { onAppend(entry); } catch { /* SSE 不影响日志记录 */ }
        return entry;
    }

    function list() {
        return entries.slice();
    }

    function clear() {
        entries = [];
        scheduleFlush();
    }

    return {load, append, list, clear, flush};
}
