// @ts-nocheck
// 独立 vless 代理：把一条 vless:// 链接转成本地 socks 端口(起独立 xray 进程)。
// 用途:注册代理指向本地端口 → xray 用 reality/tls 出站掩盖 Node TLS 指纹,过 chatgpt.com 的 CF 拦截。
// 与用户自己的 v2rayN(如 10808)完全隔离:独立进程、独立端口、独立 config。
import {spawn, execSync} from "node:child_process";
import {writeFileSync, mkdirSync, existsSync} from "node:fs";
import net from "node:net";
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
const DEFAULT_PORT = {reg: 10809, claude: 10810, jump: 10811};
function inst(name) { if (!INSTANCES[name]) INSTANCES[name] = {proc: null, state: {running: false, port: 0, node: "", vless: "", pid: 0, error: ""}}; return INSTANCES[name]; }

export function xrayStatus(name = "reg") { return {...inst(name).state}; }

/** 只有 :3100 主进程能启停跳板 xray。换绑/探活子进程 import scheduler 也会走到 ensureJumpFleet。 */
export function isMainHttpServer() {
    return process.argv.some((a) => /server\/index\.ts$/.test(String(a || "").replace(/\\/g, "/")));
}

/** 起独立 xray(命名实例):解析 vless → config → spawn。opts.name(reg/claude)、opts.localPort、opts.binPath(前端配置路径)。 */
export function startXray(vlessUrl, opts: {name?: string; localPort?: number; binPath?: string} = {}) {
    const name = opts.name || "reg";
    const localPort = opts.localPort || DEFAULT_PORT[name] || 10809;
    const it = inst(name);
    if (it.proc && it.state.running && localPortListening(it.state.port || localPort)) {
        return {ok: true, port: it.state.port || localPort, node: it.state.node, pid: it.state.pid, reused: true};
    }
    if (!isMainHttpServer()) {
        if (localPortListening(localPort)) {
            it.state = {running: true, port: localPort, node: parseVless(vlessUrl).name, vless: vlessUrl, pid: 0, error: ""};
            return {ok: true, port: localPort, node: it.state.node, pid: 0, reused: true};
        }
        throw new Error("子进程不能启停跳板 xray（会把 3100 的跳板杀掉）");
    }
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
    const child = spawn(bin, ["run", "-c", cfgFile], {stdio: ["ignore", "pipe", "pipe"], detached: false});
    it.proc = child;
    it.state = {running: true, port: localPort, node: v.name, vless: vlessUrl, pid: child.pid, error: ""};
    let errBuf = "";
    child.stderr?.on("data", (d) => { errBuf = (errBuf + d.toString()).slice(-500); });
    child.on("error", (e) => { if (it.proc === child) { it.state = {...it.state, running: false, error: `xray 启动失败: ${e?.message || e}`}; it.proc = null; } console.warn(`[xray:${name}] 启动失败(不影响服务): ${e?.message || e}`); });
    child.on("exit", (code) => { if (it.proc === child) { it.state = {...it.state, running: false, error: `xray 退出(code=${code}) ${errBuf.slice(-160)}`}; it.proc = null; } });
    return {ok: true, port: localPort, node: v.name, pid: child.pid};
}

export function stopXray(name = "reg") {
    const it = inst(name);
    if (it.proc) { try { it.proc.kill("SIGTERM"); } catch { /* ignore */ } it.proc = null; }
    it.state = {running: false, port: 0, node: "", vless: it.state.vless, pid: 0, error: ""};
}

export function isVlessUrl(s) {
    return /^vless:\/\//i.test(String(s || "").trim());
}

export function vlessIdentity(raw) {
    const v = parseVless(raw);
    return `${v.uuid}@${v.host}:${v.port}`;
}

function jumpInstanceName(raw) {
    const id = vlessIdentity(raw).replace(/[^a-zA-Z0-9]+/g, "").slice(0, 20);
    return `jump-${id || "x"}`;
}

function isJumpName(name) {
    return name === "jump" || String(name || "").startsWith("jump-");
}

/** 用户自己的 10808、GPT 旧口、Claude 口，跳板 xray 永不占用、不杀。 */
export const JUMP_RESERVED_PORTS = [10808, 10809, 10810];
export const JUMP_PORT_BASE = 10811;

export function listJumpXrays() {
    return Object.keys(INSTANCES).filter(isJumpName).map((name) => ({name, ...inst(name).state}));
}

export function isLocalNoAuthSocks(raw: string) {
    try {
        const cleaned = String(raw || "").trim().replace(/#.*$/, "");
        if (!cleaned) return false;
        const u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(cleaned) ? cleaned : `socks5://${cleaned}`);
        const local = u.hostname === "127.0.0.1" || u.hostname === "localhost";
        return local && u.protocol.startsWith("socks") && !u.username && !u.password;
    } catch {
        return false;
    }
}

// 端口探测绝不能用 execSync。lsof 在本机实测 0.4s/次，而 execSync 会把整个事件循环冻住，
// :3100 在这期间一个请求都不处理。换绑/重登/导出RT 每次都要问好几个端口，liveJumpSocks
// 最坏还要扫 20 个，叠起来就是几秒到十几秒的假死。改成 TCP connect 探测 + 短缓存：
// 单次 ~几毫秒、异步、并且同一个端口的并发提问只探一次。
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
            try { sock.destroy(); } catch { /* */ }
            resolve(up);
        };
        const sock = net.connect({host: "127.0.0.1", port});
        sock.setTimeout(PORT_PROBE_TIMEOUT_MS);
        sock.on("connect", () => finish(true));
        sock.on("timeout", () => finish(false));
        sock.on("error", () => finish(false));
    });
}

function refreshPort(p: number, usedAt: number) {
    const running = portInflight.get(p);
    if (running) return running;
    const task = probeLocalPortOnce(p).then((up) => {
        const prev = portCache.get(p);
        portCache.set(p, {at: Date.now(), up, usedAt: Math.max(usedAt, prev?.usedAt || 0)});
        portInflight.delete(p);
        return up;
    }, () => {
        portInflight.delete(p);
        return false;
    });
    portInflight.set(p, task);
    return task;
}

/** 端口在不在听。异步 + 3 秒缓存；同一端口并发只探一次。 */
export async function localPortListeningAsync(port: number) {
    const p = Number(port);
    if (!p) return false;
    const now = Date.now();
    const hit = portCache.get(p);
    if (hit && now - hit.at < PORT_PROBE_TTL_MS) {
        hit.usedAt = now;
        return hit.up;
    }
    return refreshPort(p, now);
}

// 后台把最近问过的端口焐热。这样热路径基本都是命中缓存（0 延迟），
// 剩下那几个同步调用点（startXray / 读配置）也几乎撞不到冷缓存去跑阻塞 lsof。
// 只跟着实际用过的端口走，不主动全段扫；unref 保证不吊住进程退出。
const portWarmTimer = setInterval(() => {
    const now = Date.now();
    for (const [p, v] of portCache) {
        if (now - v.usedAt > PORT_WARM_IDLE_MS) { portCache.delete(p); continue; }
        if (now - v.at >= PORT_PROBE_TTL_MS - 800) refreshPort(p, v.usedAt).catch(() => {});
    }
}, 1500);
try { portWarmTimer.unref(); } catch { /* */ }

/**
 * 同步版，只给启停 xray / 启动读配置这种低频同步调用留着。
 * 命中缓存就直接返回（热路径会一直把缓存焐热）；缓存冷了才退回一次阻塞探测。
 */
export function localPortListening(port: number) {
    const p = Number(port);
    if (!p) return false;
    const now = Date.now();
    const hit = portCache.get(p);
    if (hit && now - hit.at < PORT_PROBE_TTL_MS) {
        hit.usedAt = now;
        return hit.up;
    }
    let up = false;
    try {
        if (process.platform === "win32") {
            const out = execSync("netstat -ano -p tcp", {stdio: ["ignore", "pipe", "ignore"]}).toString();
            up = new RegExp(`[:.]${p}\\s+\\S+\\s+LISTENING`, "i").test(out);
        } else {
            execSync(`lsof -tiTCP:${p} -sTCP:LISTEN`, {stdio: "ignore"});
            up = true;
        }
    } catch {
        up = false;
    }
    portCache.set(p, {at: now, up, usedAt: now});
    return up;
}

/** 当前真正在听的跳板 socks。settings 里的 10812 常是上次重启留下的死端口。 */
export async function liveJumpSocks() {
    // 已登记的跳板实例优先，按登记顺序保持原来的优先级
    const known = listJumpXrays().filter((r) => r?.running && Number(r?.port || 0) > 0);
    const knownUp = await Promise.all(known.map((r) => localPortListeningAsync(Number(r.port))));
    for (let i = 0; i < known.length; i++) {
        if (knownUp[i]) {
            const r = known[i];
            return String(r.socks || `socks5://127.0.0.1:${r.port}`);
        }
    }
    // 扫描段并发探，20 个端口一起问，总耗时约等于一次探测
    const ports: number[] = [];
    for (let p = JUMP_PORT_BASE; p < JUMP_PORT_BASE + 20; p++) {
        if (JUMP_RESERVED_PORTS.includes(p)) continue;
        ports.push(p);
    }
    const ups = await Promise.all(ports.map((p) => localPortListeningAsync(p)));
    const idx = ups.findIndex(Boolean);
    return idx >= 0 ? `socks5://127.0.0.1:${ports[idx]}` : "";
}

/** 候选按优先级去重后排出来，只留本机无账密 socks。 */
function xrayBrowserCandidatePorts(fallbacks: string[]) {
    const urls: string[] = [];
    for (const f of fallbacks) {
        const u = String(f || "").trim();
        if (u) urls.push(u);
    }
    urls.push("socks5://127.0.0.1:10808");
    for (const r of listJumpXrays()) {
        if (r?.running && r.socks) urls.push(String(r.socks));
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
            const u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(key) ? key : `socks5://${key}`);
            const port = Number(u.port || 1080);
            if (port && !ports.includes(port)) ports.push(port);
        } catch { /* */ }
    }
    return ports;
}

/**
 * 浏览器/比特/Playwright 只走本机 xray 无账密 socks，禁止 JS 转发 kookeey。
 * 候选并发探测，返回优先级最高的那个活口。重登/换绑每一轮都要走这里，不能阻塞事件循环。
 */
export async function pickXrayBrowserProxy(...fallbacks: string[]) {
    const ports = xrayBrowserCandidatePorts(fallbacks);
    const ups = await Promise.all(ports.map((p) => localPortListeningAsync(p)));
    const idx = ups.findIndex(Boolean);
    return idx >= 0 ? `socks5://127.0.0.1:${ports[idx]}` : "";
}

export function stopJumpFleet() {
    for (const name of Object.keys(INSTANCES)) {
        if (isJumpName(name)) stopXray(name);
    }
}

export function waitLocalPort(port, timeoutMs = 2500) {
    const p = Number(port);
    const deadline = Date.now() + Math.max(200, timeoutMs);
    return new Promise((resolve) => {
        const tryOnce = () => {
            const sock = net.connect({host: "127.0.0.1", port: p});
            const done = (ok) => { try { sock.destroy(); } catch { /* */ } resolve(ok); };
            sock.setTimeout(250);
            sock.on("connect", () => done(true));
            sock.on("timeout", () => {
                try { sock.destroy(); } catch { /* */ }
                if (Date.now() >= deadline) resolve(false);
                else setTimeout(tryOnce, 80);
            });
            sock.on("error", () => {
                if (Date.now() >= deadline) resolve(false);
                else setTimeout(tryOnce, 80);
            });
        };
        tryOnce();
    });
}

function pickJumpPort(used) {
    for (let p = JUMP_PORT_BASE; p < JUMP_PORT_BASE + 40; p++) {
        if (JUMP_RESERVED_PORTS.includes(p) || used.has(p)) continue;
        return p;
    }
    throw new Error("跳板本地端口用完了（10811-10850）");
}

/**
 * 多条 vless 各自起一个独立 xray，从 10811 往上排。
 * 同一条 vless 已在跑则复用，不再重启。不碰 10808。
 */
export async function startJumpFleet(vlessUrls, opts: {binPath?: string; basePort?: number} = {}) {
    if (!isMainHttpServer()) {
        const live = await liveJumpSocks();
        if (!live) return [];
        let port = JUMP_PORT_BASE;
        try { port = Number(new URL(live).port || JUMP_PORT_BASE); } catch { /* */ }
        return (vlessUrls || []).filter((s) => isVlessUrl(s)).map((vless) => ({
            vless, socks: live, port,
            node: parseVless(vless).name, name: jumpInstanceName(vless),
            running: true, error: "",
        }));
    }
    const wanted = [];
    const seen = new Set();
    for (const raw of vlessUrls || []) {
        const s = String(raw || "").trim();
        if (!isVlessUrl(s)) continue;
        let key = s;
        try { key = vlessIdentity(s); } catch { continue; }
        if (seen.has(key)) continue;
        seen.add(key);
        wanted.push(s);
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

    const used = new Set(JUMP_RESERVED_PORTS);
    for (const row of listJumpXrays()) if (row.port) used.add(row.port);

    const out = [];
    for (const vless of wanted) {
        const key = vlessIdentity(vless);
        const name = jumpInstanceName(vless);
        const prev = byKey.get(key);
        const already = prev?.running && prev.port && !JUMP_RESERVED_PORTS.includes(prev.port);
        let port = already ? prev.port : 0;
        if (!port) {
            port = prev?.port && !JUMP_RESERVED_PORTS.includes(prev.port) && !used.has(prev.port)
                ? prev.port
                : pickJumpPort(used);
        }
        used.add(port);
        if (already && prev.name === name) {
            out.push({
                vless, socks: `socks5://127.0.0.1:${port}`, port,
                node: prev.node || parseVless(vless).name, name, running: true, error: "",
            });
            continue;
        }
        try {
            startXray(vless, {name, localPort: port, binPath: opts.binPath});
            const up = await waitLocalPort(port, 3000);
            const st = xrayStatus(name);
            out.push({
                vless, socks: `socks5://127.0.0.1:${port}`, port,
                node: st.node || parseVless(vless).name, name,
                running: !!st.running && up, error: up ? (st.error || "") : (st.error || "本地端口没起来"),
            });
        } catch (e) {
            out.push({
                vless, socks: `socks5://127.0.0.1:${port}`, port,
                node: parseVless(vless).name, name, running: false, error: String(e?.message || e),
            });
        }
    }
    return out;
}
