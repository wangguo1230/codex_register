#!/usr/bin/env node
// 独立进程盯 :3100 的 RSS。主进程事件循环卡死时 setInterval 不会跑，只能靠这边 SIGKILL。
import {execFileSync} from "node:child_process";

const parent = Number(process.env.WATCH_PID || process.ppid);
const limitMb = Math.max(800, Number(process.env.RSS_RESTART_MB || 3200));
const intervalMs = Math.max(2000, Number(process.env.RSS_WATCH_MS || 4000));

function rssMb(pid) {
    try {
        const out = execFileSync("ps", ["-o", "rss=", "-p", String(pid)], {encoding: "utf8"}).trim();
        const kb = Number(out);
        if (!Number.isFinite(kb) || kb <= 0) return -1;
        return Math.round(kb / 1024);
    } catch {
        return -1;
    }
}

function tick() {
    const mb = rssMb(parent);
    if (mb < 0) process.exit(0);
    if (mb >= limitMb) {
        console.error(`[rss-watch] pid=${parent} RSS=${mb}MB ≥ ${limitMb}MB，SIGKILL`);
        try { process.kill(parent, "SIGKILL"); } catch { /* 已经没了 */ }
        process.exit(0);
    }
}

setInterval(tick, intervalMs);
tick();
