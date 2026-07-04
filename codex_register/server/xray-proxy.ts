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

// 探测 xray 二进制:env XRAY_BIN > 运行中的 xray 进程 > v2rayN 常见路径 > PATH
function findXrayBin() {
    if (process.env.XRAY_BIN && existsSync(process.env.XRAY_BIN)) return process.env.XRAY_BIN;
    try {
        const line = execSync("ps -eo args= | grep -i '[x]ray run' | head -1", {encoding: "utf8"}).trim();
        const m = line.match(/^(.*?\/xray)\s+run/i);
        if (m && existsSync(m[1])) return m[1];
    } catch { /* ignore */ }
    const home = process.env.HOME || "";
    const cands = [
        `${home}/Library/Application Support/v2rayN/bin/xray/xray`,
        "/opt/homebrew/bin/xray", "/usr/local/bin/xray",
    ];
    for (const c of cands) if (existsSync(c)) return c;
    return "xray"; // 兜底靠 PATH
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

// 模块级单例:一次只跑一个注册专用 vless 代理
let proc = null;     // 子进程
let state = {running: false, port: 0, node: "", vless: "", pid: 0, error: ""};

export function xrayStatus() { return {...state}; }

/** 起独立 xray:解析 vless → 生成 config → spawn → 返回 {ok, port, node}。localPort 默认 10809。 */
export function startXray(vlessUrl, localPort = 10809) {
    stopXray(); // 先停旧的(单例)
    const v = parseVless(vlessUrl); // 解析失败直接抛，路由捕获
    const bin = findXrayBin();
    mkdirSync(CFG_DIR, {recursive: true});
    writeFileSync(CFG_FILE, JSON.stringify(buildConfig(v, localPort), null, 2), "utf8");
    proc = spawn(bin, ["run", "-c", CFG_FILE], {stdio: ["ignore", "pipe", "pipe"], detached: false});
    state = {running: true, port: localPort, node: v.name, vless: vlessUrl, pid: proc.pid, error: ""};
    let errBuf = "";
    proc.stderr?.on("data", (d) => { errBuf = (errBuf + d.toString()).slice(-500); });
    proc.on("exit", (code) => {
        // 非主动 stop 退出 → 标记失败(用户可看错误)
        if (state.pid === proc?.pid) state = {...state, running: false, error: `xray 退出(code=${code}) ${errBuf.slice(-160)}`};
        proc = null;
    });
    return {ok: true, port: localPort, node: v.name, pid: proc.pid};
}

export function stopXray() {
    if (proc) { try { proc.kill("SIGTERM"); } catch { /* ignore */ } proc = null; }
    state = {running: false, port: 0, node: "", vless: state.vless, pid: 0, error: ""};
}
