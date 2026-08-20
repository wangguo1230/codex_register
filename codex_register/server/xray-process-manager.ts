// @ts-nocheck
import {execSync, spawn} from "node:child_process";
import {existsSync, mkdirSync, writeFileSync} from "node:fs";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {terminateChildProcess} from "./domain/child-process-control.js";
import {localPortListening} from "./xray-local-port.js";

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(currentDir, "..");
const configDir = path.resolve(projectRoot, "..", ".xray-proxy");
const instances = {};
const defaultPorts = {reg: 10809, claude: 10810, jump: 10811};

function findXrayBin(customPath?: string) {
    if (customPath && existsSync(customPath)) return customPath;
    if (process.env.XRAY_BIN && existsSync(process.env.XRAY_BIN)) return process.env.XRAY_BIN;
    const isWindows = process.platform === "win32";
    if (!isWindows) {
        try {
            const line = execSync("ps -eo args= | grep -i '[x]ray run' | head -1", {encoding: "utf8"}).trim();
            const match = line.match(/^(.*?\/xray)\s+run/i);
            if (match && existsSync(match[1])) return match[1];
        } catch { /* ignore */ }
    }
    const home = process.env.HOME || process.env.USERPROFILE || "";
    const candidates = isWindows ? [
        path.join(home, "AppData", "Local", "v2rayN", "bin", "xray", "xray.exe"),
        path.join(home, "Desktop", "v2rayN-windows-64", "bin", "xray", "xray.exe"),
        "C:\\Program Files\\v2rayN\\bin\\xray\\xray.exe",
    ] : [
        `${home}/Library/Application Support/v2rayN/bin/xray/xray`,
        "/opt/homebrew/bin/xray", "/usr/local/bin/xray",
    ];
    for (const candidate of candidates) if (existsSync(candidate)) return candidate;
    return isWindows ? "xray.exe" : "xray";
}

export function parseVless(url) {
    const value = String(url || "").trim();
    if (!/^vless:\/\//i.test(value)) throw new Error("不是 vless:// 链接");
    const parsed = new URL(value);
    const uuid = decodeURIComponent(parsed.username || "");
    const host = parsed.hostname;
    const port = Number(parsed.port);
    if (!uuid || !host || !port) throw new Error("vless 链接缺 uuid/host/port");
    const query = Object.fromEntries(parsed.searchParams.entries());
    const name = decodeURIComponent((parsed.hash || "").replace(/^#/, "")) || `${host}:${port}`;
    return {uuid, host, port, q: query, name};
}

function buildConfig({uuid, host, port, q}, localPort) {
    const security = (q.security || "none").toLowerCase();
    const network = (q.type || "tcp").toLowerCase();
    const stream = {network, security};
    if (security === "reality") {
        stream.realitySettings = {
            serverName: q.sni || "", fingerprint: q.fp || "chrome",
            publicKey: q.pbk || "", shortId: q.sid || "", spiderX: q.spx || "",
        };
    } else if (security === "tls") {
        stream.tlsSettings = {serverName: q.sni || host, fingerprint: q.fp || "chrome", allowInsecure: false, ...(q.alpn ? {alpn: q.alpn.split(",")} : {})};
    }
    if (network === "ws") stream.wsSettings = {path: q.path || "/", ...(q.host ? {headers: {Host: q.host}} : {})};
    if (network === "grpc") stream.grpcSettings = {serviceName: q.serviceName || q.serviceName || ""};
    const user = {id: uuid, encryption: q.encryption || "none"};
    if (q.flow) user.flow = q.flow;
    return {
        log: {loglevel: "warning"},
        inbounds: [{tag: "socks-in", listen: "127.0.0.1", port: localPort, protocol: "socks", settings: {udp: true, auth: "noauth"}}],
        outbounds: [{tag: "proxy", protocol: "vless", settings: {vnext: [{address: host, port, users: [user]}]}, streamSettings: stream}],
    };
}

function instance(name) {
    if (!instances[name]) {
        instances[name] = {proc: null, state: {running: false, port: 0, node: "", vless: "", pid: 0, error: ""}};
    }
    return instances[name];
}

export function xrayStatus(name = "reg") {
    return {...instance(name).state};
}

/** 仅供跳板编排读取当前进程登记，不暴露可变内部状态。 */
export function listXrayInstances() {
    return Object.keys(instances).map((name) => ({name, ...instance(name).state}));
}

export function isMainHttpServer() {
    // 生产环境通过 bundle/server.mjs 启动，不能依赖开发态入口文件名判断。
    if (process.env.CODEX_HTTP === "1") return true;
    return process.argv.some((arg) => /(?:server\/index\.ts|bundle\/server\.mjs)$/.test(String(arg || "").replace(/\\/g, "/")));
}

export function startXray(vlessUrl, opts: {name?: string; localPort?: number; binPath?: string} = {}) {
    const name = opts.name || "reg";
    const localPort = opts.localPort || defaultPorts[name] || 10809;
    const current = instance(name);
    if (current.proc && current.state.running && Number(current.state.port) === Number(localPort) && localPortListening(localPort)) {
        return {ok: true, port: current.state.port || localPort, node: current.state.node, pid: current.state.pid, reused: true};
    }
    if (!isMainHttpServer()) {
        if (localPortListening(localPort)) {
            current.state = {running: true, port: localPort, node: parseVless(vlessUrl).name, vless: vlessUrl, pid: 0, error: ""};
            return {ok: true, port: localPort, node: current.state.node, pid: 0, reused: true};
        }
        throw new Error("子进程不能启停跳板 xray（会把 3100 的跳板杀掉）");
    }
    stopXray(name);
    const vless = parseVless(vlessUrl);
    try {
        if (process.platform === "win32") {
            const output = execSync(`netstat -ano | findstr "LISTENING" | findstr ":${localPort} "`, {encoding: "utf8"}).trim();
            const pids = [...new Set(output.split(/\r?\n/).map((line) => line.trim().split(/\s+/).pop()).filter(Boolean).filter((pid) => pid !== "0"))];
            for (const pid of pids) { try { execSync(`taskkill /F /PID ${pid} >nul 2>&1`); } catch { /* ignore */ } }
            if (pids.length) console.log(`[xray] 清理端口 ${localPort} 上 ${pids.length} 个残留进程`);
        } else {
            const pids = execSync(`lsof -ti tcp:${localPort} -sTCP:LISTEN 2>/dev/null || true`).toString().trim().split(/\s+/).filter(Boolean);
            for (const pid of pids) { try { execSync(`kill -9 ${pid} 2>/dev/null || true`); } catch { /* ignore */ } }
            if (pids.length) console.log(`[xray] 清理端口 ${localPort} 上 ${pids.length} 个残留进程`);
        }
    } catch { /* 命令不可用则跳过 */ }
    const binary = findXrayBin(opts.binPath);
    mkdirSync(configDir, {recursive: true});
    const configFile = path.join(configDir, `${name}-vless.json`);
    writeFileSync(configFile, JSON.stringify(buildConfig(vless, localPort), null, 2), "utf8");
    const child = spawn(binary, ["run", "-c", configFile], {stdio: ["ignore", "ignore", "pipe"], detached: false});
    current.proc = child;
    current.state = {running: true, port: localPort, node: vless.name, vless: vlessUrl, pid: child.pid, error: ""};
    let errorBuffer = "";
    child.stderr?.on("data", (data) => { errorBuffer = (errorBuffer + data.toString()).slice(-500); });
    child.on("error", (error) => {
        if (current.proc === child) {
            current.state = {...current.state, running: false, error: `xray 启动失败: ${error?.message || error}`};
            current.proc = null;
        }
        console.warn(`[xray:${name}] 启动失败(不影响服务): ${error?.message || error}`);
    });
    child.on("exit", (code) => {
        if (current.proc === child) {
            current.state = {...current.state, running: false, error: `xray 退出(code=${code}) ${errorBuffer.slice(-160)}`};
            current.proc = null;
        }
    });
    return {ok: true, port: localPort, node: vless.name, pid: child.pid};
}

export function stopXray(name = "reg") {
    const current = instance(name);
    if (current.proc) {
        const child = current.proc;
        const cancelForcedKill = terminateChildProcess(child, {graceMs: 5_000});
        child.once?.("close", cancelForcedKill);
        current.proc = null;
    }
    current.state = {running: false, port: 0, node: "", vless: current.state.vless, pid: 0, error: ""};
}
