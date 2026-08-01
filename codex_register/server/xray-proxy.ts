// @ts-nocheck
// 独立 vless 代理：把一条 vless:// 链接转成本地 socks 端口(起独立 xray 进程)。
// 用途:注册代理指向本地端口 → xray 用 reality/tls 出站掩盖 Node TLS 指纹,过 chatgpt.com 的 CF 拦截。
// 与用户自己的 v2rayN(如 10808)完全隔离:独立进程、独立端口、独立 config。
import {spawn, execSync} from "node:child_process";
import {writeFileSync, mkdirSync, existsSync} from "node:fs";
import path from "node:path";
import {fileURLToPath} from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CODEX_ROOT = path.resolve(__dirname, "..");
const CFG_DIR = path.resolve(CODEX_ROOT, "..", ".xray-proxy"); // custom-mail/.xray-proxy
const CFG_FILE = path.join(CFG_DIR, "reg-vless.json");

// 探测 xray 二进制:customPath(前端配置) > env XRAY_BIN > 运行中进程 > 常见路径 > PATH
function findXrayBin(customPath?: string) {
    if (customPath && existsSync(customPath)) return customPath;
    if (process.env.XRAY_BIN && existsSync(process.env.XRAY_BIN)) return process.env.XRAY_BIN;
    const isWin = process.platform === "win32";
    if (!isWin) {
        try {
            const line = execSync("ps -eo args= | grep -i '[x]ray run' | head -1", {encoding: "utf8"}).trim();
            const m = line.match(/^(.*?\/xray)\s+run/i);
            if (m && existsSync(m[1])) return m[1];
        } catch { /* ignore */ }
    }
    const home = process.env.HOME || process.env.USERPROFILE || "";
    const cands = isWin ? [
        path.join(home, "AppData", "Local", "v2rayN", "bin", "xray", "xray.exe"),
        path.join(home, "Desktop", "v2rayN-windows-64", "bin", "xray", "xray.exe"),
        "C:\\Program Files\\v2rayN\\bin\\xray\\xray.exe",
    ] : [
        `${home}/Library/Application Support/v2rayN/bin/xray/xray`,
        "/opt/homebrew/bin/xray", "/usr/local/bin/xray",
    ];
    for (const c of cands) if (existsSync(c)) return c;
    return isWin ? "xray.exe" : "xray";
}

/** 解析 vless://uuid@host:port?query#name */
export function parseVless(url) {
    const s = String(url || "").trim();
    if (!/^vless:\/\//i.test(s)) throw new Error("不是 vless:// 链接");
    const u = new URL(s);
    const uuid = decodeURIComponent(u.username || "");
    const host = u.hostname;
    const port = Number(u.port);
    if (!uuid || !host || !port) throw new Error("vless 链接缺 uuid/host/port");
    const q = Object.fromEntries(u.searchParams.entries());
    const name = decodeURIComponent((u.hash || "").replace(/^#/, "")) || `${host}:${port}`;
    return {uuid, host, port, q, name};
}

/** vless 参数 + 本地端口 → xray 配置(支持 reality/tls/none + tcp/ws/grpc) */
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

// 多实例:按名字各跑一个 vless 代理(reg=GPT 注册/10809,claude=Claude 注册/10810,互不干扰)。
const INSTANCES = {}; // name -> {proc, state}
const DEFAULT_PORT = {reg: 10809, claude: 10810};
function inst(name) { if (!INSTANCES[name]) INSTANCES[name] = {proc: null, state: {running: false, port: 0, node: "", vless: "", pid: 0, error: ""}}; return INSTANCES[name]; }

export function xrayStatus(name = "reg") { return {...inst(name).state}; }

/** 起独立 xray(命名实例):解析 vless → config → spawn。opts.name(reg/claude)、opts.localPort、opts.binPath(前端配置路径)。 */
export function startXray(vlessUrl, opts: {name?: string; localPort?: number; binPath?: string} = {}) {
    const name = opts.name || "reg";
    const localPort = opts.localPort || DEFAULT_PORT[name] || 10809;
    stopXray(name);
    const v = parseVless(vlessUrl);
    // 按端口清理跨重启残留的僵尸 xray
    try {
        if (process.platform === "win32") {
            const out = execSync(`netstat -ano | findstr "LISTENING" | findstr ":${localPort} "`, {encoding: "utf8"}).trim();
            const pids = [...new Set(out.split(/\r?\n/).map(l => l.trim().split(/\s+/).pop()).filter(Boolean).filter(p => p !== "0"))];
            for (const pid of pids) { try { execSync(`taskkill /F /PID ${pid} >nul 2>&1`); } catch { /* ignore */ } }
            if (pids.length) console.log(`[xray] 清理端口 ${localPort} 上 ${pids.length} 个残留进程`);
        } else {
            const pids = execSync(`lsof -ti tcp:${localPort} -sTCP:LISTEN 2>/dev/null || true`).toString().trim().split(/\s+/).filter(Boolean);
            for (const pid of pids) { try { execSync(`kill -9 ${pid} 2>/dev/null || true`); } catch { /* ignore */ } }
            if (pids.length) console.log(`[xray] 清理端口 ${localPort} 上 ${pids.length} 个残留进程`);
        }
    } catch { /* 命令不可用则跳过 */ }
    const bin = findXrayBin(opts.binPath);
    mkdirSync(CFG_DIR, {recursive: true});
    const cfgFile = path.join(CFG_DIR, `${name}-vless.json`);
    writeFileSync(cfgFile, JSON.stringify(buildConfig(v, localPort), null, 2), "utf8");
    const it = inst(name);
    const child = spawn(bin, ["run", "-c", cfgFile], {stdio: ["ignore", "pipe", "pipe"], detached: false});
    it.proc = child;
    it.state = {running: true, port: localPort, node: v.name, vless: vlessUrl, pid: child.pid, error: ""};
    let errBuf = "";
    child.stderr?.on("data", (d) => { errBuf = (errBuf + d.toString()).slice(-500); });
    child.on("exit", (code) => { if (it.proc === child) { it.state = {...it.state, running: false, error: `xray 退出(code=${code}) ${errBuf.slice(-160)}`}; it.proc = null; } });
    return {ok: true, port: localPort, node: v.name, pid: child.pid};
}

export function stopXray(name = "reg") {
    const it = inst(name);
    if (it.proc) { try { it.proc.kill("SIGTERM"); } catch { /* ignore */ } it.proc = null; }
    it.state = {running: false, port: 0, node: "", vless: it.state.vless, pid: 0, error: ""};
}
