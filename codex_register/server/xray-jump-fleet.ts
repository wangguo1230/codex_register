// @ts-nocheck
import {localPortListeningAsync, waitLocalPort} from "./xray-local-port.js";
import {
    isMainHttpServer,
    listXrayInstances,
    parseVless,
    startXray,
    stopXray,
    xrayStatus,
} from "./xray-process-manager.js";

export const JUMP_RESERVED_PORTS = [10808, 10809, 10810];
export const JUMP_PORT_BASE = 10811;
const JUMP_PORT_POOL_SIZE = 40;

export function isVlessUrl(value) {
    return /^vless:\/\//i.test(String(value || "").trim());
}

export function vlessIdentity(raw) {
    const vless = parseVless(raw);
    return `${vless.uuid}@${vless.host}:${vless.port}`;
}

function jumpInstanceName(raw) {
    const identity = vlessIdentity(raw).replace(/[^a-zA-Z0-9]+/g, "").slice(0, 20);
    return `jump-${identity || "x"}`;
}

function isJumpName(name) {
    return name === "jump" || String(name || "").startsWith("jump-");
}

export function listJumpXrays() {
    return listXrayInstances().filter((row) => isJumpName(row.name));
}

export function isLocalNoAuthSocks(raw: string) {
    try {
        const cleaned = String(raw || "").trim().replace(/#.*$/, "");
        if (!cleaned) return false;
        const parsed = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(cleaned) ? cleaned : `socks5://${cleaned}`);
        const local = parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost";
        return local && parsed.protocol.startsWith("socks") && !parsed.username && !parsed.password;
    } catch {
        return false;
    }
}

/** 返回当前实际监听的跳板 socks，避免使用重启后遗留的死端口。 */
export async function liveJumpSocks() {
    const known = listJumpXrays().filter((row) => row?.running && Number(row?.port || 0) > 0);
    const knownUp = await Promise.all(known.map((row) => localPortListeningAsync(Number(row.port))));
    for (let index = 0; index < known.length; index++) {
        if (knownUp[index]) {
            const row = known[index];
            return String(row.socks || `socks5://127.0.0.1:${row.port}`);
        }
    }
    const ports: number[] = [];
    for (let port = JUMP_PORT_BASE; port < JUMP_PORT_BASE + 20; port++) {
        if (JUMP_RESERVED_PORTS.includes(port)) continue;
        ports.push(port);
    }
    const states = await Promise.all(ports.map((port) => localPortListeningAsync(port)));
    const index = states.findIndex(Boolean);
    return index >= 0 ? `socks5://127.0.0.1:${ports[index]}` : "";
}

export function xrayBrowserCandidatePorts(fallbacks: string[], jumpRows: any[] = []) {
    const urls: string[] = [];
    for (const fallback of fallbacks) {
        const value = String(fallback || "").trim();
        if (value) urls.push(value);
    }
    urls.push("socks5://127.0.0.1:10808");
    for (const row of jumpRows) {
        if (row?.running && Number(row?.port || 0) > 0) {
            urls.push(String(row.socks || `socks5://127.0.0.1:${row.port}`));
        }
    }
    urls.push("socks5://127.0.0.1:10811");
    const seen = new Set<string>();
    const ports: number[] = [];
    for (const raw of urls) {
        if (!isLocalNoAuthSocks(raw)) continue;
        const key = raw.split("#")[0];
        if (seen.has(key)) continue;
        seen.add(key);
        try {
            const parsed = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(key) ? key : `socks5://${key}`);
            const port = Number(parsed.port || 1080);
            if (port && !ports.includes(port)) ports.push(port);
        } catch { /* */ }
    }
    return ports;
}

/** 浏览器类工作只选择实际监听的本机无认证 socks。 */
export async function pickXrayBrowserProxy(...fallbacks: string[]) {
    const ports = xrayBrowserCandidatePorts(fallbacks, listJumpXrays());
    const states = await Promise.all(ports.map((port) => localPortListeningAsync(port)));
    const index = states.findIndex(Boolean);
    return index >= 0 ? `socks5://127.0.0.1:${ports[index]}` : "";
}

export function stopJumpFleet() {
    for (const row of listJumpXrays()) stopXray(row.name);
}

export function normalizeJumpBasePort(value) {
    const port = Number(value);
    return Number.isInteger(port) && port > 0 && port <= 65535 ? port : JUMP_PORT_BASE;
}

export function pickJumpPort(used, configuredBasePort = JUMP_PORT_BASE, reservedPorts = JUMP_RESERVED_PORTS) {
    const basePort = normalizeJumpBasePort(configuredBasePort);
    const reserved = new Set((reservedPorts || []).map(Number).filter(Number.isInteger));
    const endPort = Math.min(basePort + JUMP_PORT_POOL_SIZE, 65536);
    for (let port = basePort; port < endPort; port++) {
        if (reserved.has(port) || used.has(port)) continue;
        return port;
    }
    throw new Error(`跳板本地端口用完了（${basePort}-${endPort - 1}）`);
}

/** 多条 VLESS 各自启动独立 xray；同一节点已运行时复用原端口。 */
export async function startJumpFleet(vlessUrls, opts: {binPath?: string; basePort?: number; reservedPorts?: number[]} = {}) {
    const basePort = normalizeJumpBasePort(opts.basePort);
    const reservedPorts = [...new Set([
        ...JUMP_RESERVED_PORTS,
        ...(opts.reservedPorts || []).map(Number).filter(Number.isInteger),
    ])];
    if (!isMainHttpServer()) {
        const live = await liveJumpSocks();
        if (!live) return [];
        let port = basePort;
        try { port = Number(new URL(live).port || basePort); } catch { /* */ }
        return (vlessUrls || []).filter((value) => isVlessUrl(value)).map((vless) => ({
            vless, socks: live, port,
            node: parseVless(vless).name, name: jumpInstanceName(vless),
            running: true, error: "",
        }));
    }
    const wanted = [];
    const seen = new Set();
    for (const raw of vlessUrls || []) {
        const value = String(raw || "").trim();
        if (!isVlessUrl(value)) continue;
        let key = value;
        try { key = vlessIdentity(value); } catch { continue; }
        if (seen.has(key)) continue;
        seen.add(key);
        wanted.push(value);
    }

    const existing = listJumpXrays();
    const byKey = new Map();
    for (const row of existing) {
        if (!row.vless) continue;
        try { byKey.set(vlessIdentity(row.vless), row); } catch { /* */ }
    }
    for (const row of existing) {
        let keep = false;
        try { keep = row.vless && seen.has(vlessIdentity(row.vless)); } catch { keep = false; }
        if (!keep) stopXray(row.name);
    }

    const used = new Set(reservedPorts);
    for (const row of listJumpXrays()) if (row.port) used.add(row.port);

    const results = new Array(wanted.length);
    const pending = [];
    for (let index = 0; index < wanted.length; index++) {
        const vless = wanted[index];
        const key = vlessIdentity(vless);
        const name = jumpInstanceName(vless);
        const previous = byKey.get(key);
        const inConfiguredPool = previous?.port >= basePort
            && previous.port < Math.min(basePort + JUMP_PORT_POOL_SIZE, 65536);
        const alreadyRunning = previous?.running && inConfiguredPool && !reservedPorts.includes(previous.port);
        let port = alreadyRunning ? previous.port : 0;
        if (!port) {
            port = previous?.port && inConfiguredPool && !reservedPorts.includes(previous.port) && !used.has(previous.port)
                ? previous.port
                : pickJumpPort(used, basePort, reservedPorts);
        }
        used.add(port);
        if (alreadyRunning && previous.name === name) {
            results[index] = {
                vless, socks: `socks5://127.0.0.1:${port}`, port,
                node: previous.node || parseVless(vless).name, name, running: true, error: "",
            };
            continue;
        }
        try {
            startXray(vless, {name, localPort: port, binPath: opts.binPath});
            pending.push({index, vless, name, port});
        } catch (error) {
            results[index] = {
                vless, socks: `socks5://127.0.0.1:${port}`, port,
                node: parseVless(vless).name, name, running: false, error: String(error?.message || error),
            };
        }
    }
    // 所有进程先启动，再并行等待端口，避免节点数量线性放大启动等待时间。
    await Promise.all(pending.map(async ({index, vless, name, port}) => {
        try {
            const up = await waitLocalPort(port, 3000);
            const state = xrayStatus(name);
            results[index] = {
                vless, socks: `socks5://127.0.0.1:${port}`, port,
                node: state.node || parseVless(vless).name, name,
                running: !!state.running && up, error: up ? (state.error || "") : (state.error || "本地端口没起来"),
            };
        } catch (error) {
            results[index] = {
                vless, socks: `socks5://127.0.0.1:${port}`, port,
                node: parseVless(vless).name, name, running: false, error: String(error?.message || error),
            };
        }
    }));
    return results;
}
