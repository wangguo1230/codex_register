// @ts-nocheck
import {execSync} from "node:child_process";
import net from "node:net";

const PORT_PROBE_TTL_MS = 3000;
const PORT_PROBE_TIMEOUT_MS = 400;
const PORT_WARM_IDLE_MS = 60_000;
const portCache = new Map<number, {at: number; up: boolean; usedAt: number}>();
const portInflight = new Map<number, Promise<boolean>>();

function probeLocalPortOnce(port: number): Promise<boolean> {
    return new Promise((resolve) => {
        let done = false;
        const finish = (up: boolean) => {
            if (done) return;
            done = true;
            try { socket.destroy(); } catch { /* */ }
            resolve(up);
        };
        const socket = net.connect({host: "127.0.0.1", port});
        socket.setTimeout(PORT_PROBE_TIMEOUT_MS);
        socket.on("connect", () => finish(true));
        socket.on("timeout", () => finish(false));
        socket.on("error", () => finish(false));
    });
}

function refreshPort(port: number, usedAt: number) {
    const running = portInflight.get(port);
    if (running) return running;
    const task = probeLocalPortOnce(port).then((up) => {
        const previous = portCache.get(port);
        portCache.set(port, {at: Date.now(), up, usedAt: Math.max(usedAt, previous?.usedAt || 0)});
        portInflight.delete(port);
        return up;
    }, () => {
        portInflight.delete(port);
        return false;
    });
    portInflight.set(port, task);
    return task;
}

/** 异步 TCP 探测带短缓存；同一端口的并发探测共享一个 Promise。 */
export async function localPortListeningAsync(port: number) {
    const normalized = Number(port);
    if (!normalized) return false;
    const now = Date.now();
    const cached = portCache.get(normalized);
    if (cached && now - cached.at < PORT_PROBE_TTL_MS) {
        cached.usedAt = now;
        return cached.up;
    }
    return refreshPort(normalized, now);
}

const portWarmTimer = setInterval(() => {
    const now = Date.now();
    for (const [port, state] of portCache) {
        if (now - state.usedAt > PORT_WARM_IDLE_MS) { portCache.delete(port); continue; }
        if (now - state.at >= PORT_PROBE_TTL_MS - 800) refreshPort(port, state.usedAt).catch(() => {});
    }
}, 1500);
try { portWarmTimer.unref(); } catch { /* */ }

/** 仅供 xray 启停等低频同步路径使用；热路径应使用异步版本。 */
export function localPortListening(port: number) {
    const normalized = Number(port);
    if (!normalized) return false;
    const now = Date.now();
    const cached = portCache.get(normalized);
    if (cached && now - cached.at < PORT_PROBE_TTL_MS) {
        cached.usedAt = now;
        return cached.up;
    }
    let up = false;
    try {
        if (process.platform === "win32") {
            const output = execSync("netstat -ano -p tcp", {stdio: ["ignore", "pipe", "ignore"]}).toString();
            up = new RegExp(`[:.]${normalized}\\s+\\S+\\s+LISTENING`, "i").test(output);
        } else {
            execSync(`lsof -tiTCP:${normalized} -sTCP:LISTEN`, {stdio: "ignore"});
            up = true;
        }
    } catch {
        up = false;
    }
    portCache.set(normalized, {at: now, up, usedAt: now});
    return up;
}

export function waitLocalPort(port, timeoutMs = 2500) {
    const normalized = Number(port);
    const deadline = Date.now() + Math.max(200, timeoutMs);
    return new Promise((resolve) => {
        let settled = false;
        const tryOnce = () => {
            if (settled) return;
            const socket = net.connect({host: "127.0.0.1", port: normalized});
            let attemptDone = false;
            const succeed = () => {
                if (attemptDone || settled) return;
                attemptDone = true;
                settled = true;
                try { socket.destroy(); } catch { /* */ }
                resolve(true);
            };
            const retry = () => {
                if (attemptDone || settled) return;
                attemptDone = true;
                try { socket.destroy(); } catch { /* */ }
                if (Date.now() >= deadline) {
                    settled = true;
                    resolve(false);
                } else {
                    setTimeout(tryOnce, 80);
                }
            };
            socket.setTimeout(250);
            socket.on("connect", succeed);
            socket.on("timeout", retry);
            socket.on("error", retry);
        };
        tryOnce();
    });
}
