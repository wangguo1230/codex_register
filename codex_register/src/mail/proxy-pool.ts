// 邮箱整备/换2FA/改密用的代理池。默认 1 个代理同一时刻只绑 1 个比特指纹窗口。
import {execFile} from "node:child_process";
import net from "node:net";

export type MailProxyLease = {
    url: string;
    owner: string;
    release: () => void | Promise<unknown>;
};

export type ProxyLeaseCandidate = {
    resourceKey: string;
    baseUrl: string;
    leaseKey: string;
    templateKey: string;
    liveUrl: string;
};

export type DistributedProxyLeaseBackend = {
    loadConfiguration?: () => Promise<{
        initialized: boolean;
        exitUrls?: string[];
        exitMailEnabled?: boolean;
        exitGptEnabled?: boolean;
    }>;
    acquire: (options: {
        kind: "exit" | "jump";
        scope?: ProxyPoolScope;
        owner: string;
        candidates: ProxyLeaseCandidate[];
        maxPerTemplate: number;
        leaseMs: number;
        signal?: AbortSignal;
    }) => Promise<{leaseToken: string; url: string; resourceKey: string; leaseKey: string} | null>;
    release: (options: {kind: "exit" | "jump"; leaseToken: string}) => Promise<unknown>;
    renew: (options: {kind: "exit" | "jump"; leaseToken: string; leaseMs: number}) => Promise<boolean>;
    snapshot?: (options: {kind: "exit" | "jump"; scope?: ProxyPoolScope}) => Promise<{
        total: number;
        leased: number;
        items: Array<{resourceKey: string; url: string; leased: number; owners: string[]}>;
    }>;
};

function decodeB64UserPass(raw: string): {user: string; pass: string} | null {
    const compact = String(raw || "").replace(/[^A-Za-z0-9+/]/g, "");
    if (compact.length < 12 || compact.length % 4 === 1) return null;
    try {
        const dec = Buffer.from(compact, "base64").toString("utf8");
        const i = dec.indexOf(":");
        if (i <= 0) return null;
        const user = dec.slice(0, i);
        const pass = dec.slice(i + 1);
        if (!user || !pass || !/^[\x21-\x7e]+$/.test(user) || !/^[\x21-\x7e]+$/.test(pass)) return null;
        if (Buffer.from(compact, "base64").toString("base64").replace(/=+$/, "") !== compact.replace(/=+$/, "")) return null;
        return {user, pass};
    } catch {
        return null;
    }
}

export function normalizeProxyUrl(raw: string): string {
    const s = String(raw || "").trim();
    if (!s || s.startsWith("#")) return "";
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) {
        try {
            const u = new URL(s);
            if (/^vless:/i.test(u.protocol)) return s;
            if (/^socks/i.test(u.protocol)) {
                const userRaw = decodeURIComponent(u.username || "");
                const passRaw = decodeURIComponent(u.password || "");
                const decoded = !passRaw ? decodeB64UserPass(userRaw) : null;
                const user = decoded ? decoded.user : userRaw;
                const pass = decoded ? decoded.pass : passRaw;
                const host = u.hostname;
                const port = u.port || "1080";
                if (!host) return "";
                if (user || pass) {
                    return `socks5://${encodeURIComponent(user)}:${encodeURIComponent(pass)}@${host}:${port}`;
                }
                return `socks5://${host}:${port}`;
            }
            return s;
        } catch { return ""; }
    }
    const parts = s.split(":").map((x) => x.trim());
    if (parts.length === 2 && parts[0] && /^\d+$/.test(parts[1])) return `socks5://${parts[0]}:${parts[1]}`;
    if (parts.length >= 4) {
        const [host, port, user, ...rest] = parts;
        if (!host || !/^\d+$/.test(port)) return "";
        const pass = rest.join(":");
        return `socks5://${encodeURIComponent(user)}:${encodeURIComponent(pass)}@${host}:${port}`;
    }
    return "";
}

export function parseProxyLines(text: string): string[] {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const chunk of String(text || "").split(/[\r\n,;]+/)) {
        const url = normalizeProxyUrl(chunk);
        if (!url || seen.has(url)) continue;
        seen.add(url);
        out.push(url);
    }
    return out;
}

/** 把 socks5 URL 还原成 host:port:user:pass，方便对照导入文本。 */
export function toProxyImportLine(url: string): string {
    const s = String(url || "").trim();
    if (!s) return "";
    try {
        const u = new URL(s);
        const user = decodeURIComponent(u.username || "");
        const pass = decodeURIComponent(u.password || "");
        if (user || pass) return `${u.hostname}:${u.port || (u.protocol.startsWith("socks") ? "1080" : "80")}:${user}:${pass}`;
        if (u.hostname) return `${u.hostname}:${u.port || ""}`.replace(/:$/, "");
    } catch { /* keep raw */ }
    return s;
}

// pass-US-session-5m  或  pass-global-session（后台生成的粘性，无自动换出口）
const KOOK_PASS_RE = /^(.+)-([A-Za-z]{2}|global)-(\d+)(?:-(\d+m))?$/i;

function kookRegion(raw: string) {
    const r = String(raw || "");
    return /^global$/i.test(r) ? "global" : r.toUpperCase();
}

function withKookeeySession(url: string, session: string, duration?: string): string {
    const u = new URL(url);
    const pass = decodeURIComponent(u.password || "");
    const m = pass.match(KOOK_PASS_RE);
    if (!m) return url;
    const hold = duration === undefined ? (m[4] || "") : duration;
    const next = hold
        ? `${m[1]}-${kookRegion(m[2])}-${session}-${hold}`
        : `${m[1]}-${kookRegion(m[2])}-${session}`;
    return `socks5://${encodeURIComponent(decodeURIComponent(u.username || ""))}:${encodeURIComponent(next)}@${u.hostname}:${u.port}`;
}

/** `-5m` 会定时换出口。`global-会话` 本身已是粘性，不再改写。 */
export function ensureKookeeySticky(url: string, minMinutes = 30): string {
    try {
        const pass = decodeURIComponent(new URL(url).password || "");
        const m = pass.match(KOOK_PASS_RE);
        if (!m) return url;
        if (!m[4]) return url;
        const have = Number(String(m[4]).replace(/m$/i, "")) || 0;
        if (have >= minMinutes) return url;
        return withKookeeySession(url, m[3], `${minMinutes}m`);
    } catch {
        return url;
    }
}

function randomSessionId() {
    return String(10000000 + Math.floor(Math.random() * 90000000));
}

export function kookeeySessionOf(url: string): string {
    try {
        const pass = decodeURIComponent(new URL(url).password || "");
        const m = pass.match(KOOK_PASS_RE);
        return m ? m[3] : "";
    } catch { return ""; }
}

export function rotateKookeeySession(url: string): string {
    try {
        const pass = decodeURIComponent(new URL(url).password || "");
        if (!KOOK_PASS_RE.test(pass)) return url;
        return ensureKookeeySticky(withKookeeySession(url, randomSessionId()));
    } catch { return url; }
}

/** 代理/出口挂了：应换 session 重开窗。账密错、已停止不换。 */
export function isProxySessionDead(err: unknown): boolean {
    const s = String((err as {message?: string})?.message || err || "");
    if (!s || /已停止|比特已退出登录/.test(s)) return false;
    return /代理中断|ERR_PROXY|chrome-error|代理不通|Cloudflare|Unable to load site|出口被|换 session|ERR_TUNNEL|ERR_CONNECTION|ERR_TIMED_OUT|ERR_SSL|ERR_EMPTY_RESPONSE|ERR_NETWORK_CHANGED|ERR_INTERNET_DISCONNECTED|端口不通|Google 不通|出口失败|this site can.?t be reached|No internet|something wrong with the proxy|Checking the proxy|正在连接|代理IP自身连通|无法连接网络|SSL\/代理|打开目标页失败\(网络|Target closed|has been closed|Browser has been closed/i.test(s);
}

/** 一号一代理：新开一条粘性 session（不带 -5m），同一账号全程钉死这个出口。 */
export function mintStickySession(url: string): string {
    try {
        const pass = decodeURIComponent(new URL(url).password || "");
        const m = pass.match(KOOK_PASS_RE);
        if (!m) return url;
        return withKookeeySession(url, randomSessionId(), "");
    } catch {
        return url;
    }
}

export function proxyTemplateKey(url: string): string {
    try {
        const u = new URL(url);
        const pass = decodeURIComponent(u.password || "");
        const m = pass.match(KOOK_PASS_RE);
        if (m) return `${u.hostname}:${u.port}:${decodeURIComponent(u.username || "")}:${m[1]}-${m[2]}`;
        return url;
    } catch { return url; }
}

/** 解析批量文本；copies>1 时把 kookeey 这种 session 密码拆成多条独立出口。 */
export function expandProxyImport(text: string, copies = 1): string[] {
    const base = parseProxyLines(text);
    const n = Math.max(1, Math.min(200, Number(copies) || 1));
    if (n === 1) return base;
    const seen = new Set<string>();
    const out: string[] = [];
    for (const url of base) {
        let pass = "";
        try { pass = decodeURIComponent(new URL(url).password || ""); } catch { /* */ }
        if (!KOOK_PASS_RE.test(pass)) {
            if (!seen.has(url)) { seen.add(url); out.push(url); }
            continue;
        }
        for (let i = 0; i < n; i++) {
            let next = "";
            for (let t = 0; t < 8; t++) {
                next = withKookeeySession(url, randomSessionId());
                if (!seen.has(next)) break;
            }
            if (!next || seen.has(next)) continue;
            seen.add(next);
            out.push(next);
        }
    }
    return out;
}

function curlSocksArg(url: string): string {
    const u = new URL(url);
    const auth = u.username
        ? `${decodeURIComponent(u.username)}:${decodeURIComponent(u.password)}@`
        : "";
    return `socks5h://${auth}${u.hostname}:${u.port || 1080}`;
}

let mailProxyJump = String(process.env.MAIL_PROXY_JUMP || "").trim();

export function setMailProxyJump(url: string) {
    mailProxyJump = String(url || "").trim();
    return mailProxyJump;
}

export function getMailProxyJump() {
    return mailProxyJump;
}

function tcpReach(host: string, port: number, timeoutMs = 5000, signal?: AbortSignal): Promise<{ok: boolean; reason?: string}> {
    return new Promise((resolve) => {
        if (signal?.aborted) {
            resolve({ok: false, reason: "aborted"});
            return;
        }
        const sock = net.connect({host, port, timeout: timeoutMs});
        let settled = false;
        const onAbort = () => done(false, "aborted");
        const done = (ok: boolean, reason?: string) => {
            if (settled) return;
            settled = true;
            signal?.removeEventListener("abort", onAbort);
            try { sock.destroy(); } catch { /* */ }
            resolve(ok ? {ok: true} : {ok: false, reason});
        };
        signal?.addEventListener("abort", onAbort, {once: true});
        sock.once("connect", () => done(true));
        sock.once("timeout", () => done(false, "tcp timeout"));
        sock.once("error", (e) => done(false, String(e?.message || e).slice(0, 80)));
    });
}

async function tcpReachMaybeJump(host: string, port: number, timeoutMs = 8000, jump = mailProxyJump, signal?: AbortSignal) {
    if (!jump) return tcpReach(host, port, timeoutMs, signal);
    const {probeJumpTo} = await import("./proxy-chain.js");
    const r = await probeJumpTo(jump, host, port, timeoutMs);
    return r.ok ? {ok: true} : {ok: false, reason: `跳板连不上 ${host}:${port} (${r.reason})`};
}

function curlVia(proxyUrl: string, target: string, extra: string[] = [], timeoutSec = 12, signal?: AbortSignal) {
    return new Promise<{ok: boolean; stdout: string; stderr?: string; reason?: string}>((resolve) => {
        if (signal?.aborted) {
            resolve({ok: false, stdout: "", reason: "aborted"});
            return;
        }
        let settled = false;
        const args = [
            "-sS", "--max-time", String(timeoutSec), "-x", curlSocksArg(proxyUrl), ...extra, target,
        ];
        const finish = (value: {ok: boolean; stdout: string; stderr?: string; reason?: string}) => {
            if (settled) return;
            settled = true;
            signal?.removeEventListener("abort", onAbort);
            resolve(value);
        };
        const onAbort = () => {
            try { child?.kill("SIGKILL"); } catch { /* */ }
            finish({ok: false, stdout: "", reason: "aborted"});
        };
        let child: any;
        try {
            child = execFile("curl", args, {
                encoding: "utf8",
                timeout: (timeoutSec + 2) * 1000,
                signal,
                maxBuffer: 256 * 1024,
            }, (error, stdout, stderr) => {
                const out = String(stdout || "").trim();
                const err = String(stderr || "").replace(/\s+/g, " ").trim();
                if (!error) {
                    finish({ok: true, stdout: out, stderr: err});
                    return;
                }
                finish({
                    ok: false,
                    stdout: out,
                    stderr: err,
                    reason: err || String(error?.message || error).replace(/\s+/g, " ").slice(0, 160),
                });
            });
            signal?.addEventListener("abort", onAbort, {once: true});
        } catch (error: any) {
            finish({ok: false, stdout: "", reason: String(error?.message || error).slice(0, 160)});
        }
    });
}

/** 开指纹前先测 SOCKS：默认检查 Google；传入业务目标时检查指定端点。 */
export async function probeMailProxy(rawUrl: string, {
    timeoutSec = 12,
    jump,
    signal,
    targetHost = "",
    targetPort = 0,
}: {
    timeoutSec?: number;
    jump?: string;
    signal?: AbortSignal;
    targetHost?: string;
    targetPort?: number;
} = {}): Promise<{
    ok: boolean; ip: string; google: number; accounts: number; ms: number; reason?: string;
}> {
    const url = normalizeProxyUrl(rawUrl) || String(rawUrl || "").trim();
    const started = Date.now();
    const curlSec = Math.max(8, Number(timeoutSec) || 12);
    const budgetMs = Math.max(25000, 10_000 + curlSec * 3000);
    const controller = new AbortController();
    let timedOut = false;
    const onAbort = () => controller.abort();
    if (signal?.aborted) controller.abort();
    else signal?.addEventListener("abort", onAbort, {once: true});
    const timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
    }, budgetMs);
    try {
        const result = await probeMailProxyOnce(url, curlSec, jump, started, controller.signal, targetHost, targetPort);
        if (timedOut && !result.ok) result.reason = `探测超时 ${budgetMs}ms`;
        if (signal?.aborted && !timedOut && !result.ok) result.reason = "探测已取消";
        return result;
    } finally {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
    }
}

async function probeMailProxyOnce(
    url: string,
    timeoutSec: number,
    jump: string | undefined,
    started: number,
    signal?: AbortSignal,
    targetHost = "",
    targetPort = 0,
): Promise<{
    ok: boolean; ip: string; google: number; accounts: number; ms: number; reason?: string;
}> {
    if (!url) return {ok: false, ip: "", google: 0, accounts: 0, ms: 0, reason: "无代理"};
    let host = "", port = 1080;
    try {
        const u = new URL(url);
        host = u.hostname;
        port = Number(u.port || 1080);
    } catch {
        return {ok: false, ip: "", google: 0, accounts: 0, ms: Date.now() - started, reason: "代理 URL 无效"};
    }
    const viaJump = jump !== undefined ? String(jump || "").trim() : mailProxyJump;
    const tcp = await tcpReachMaybeJump(host, port, 8000, viaJump, signal);
    if (!tcp.ok) {
        const via = viaJump ? "经跳板" : "";
        return {ok: false, ip: "", google: 0, accounts: 0, ms: Date.now() - started, reason: `端口不通${via} ${host}:${port} (${tcp.reason})`};
    }
    let curlUrl = url;
    let relayClose = () => {};
    const probeHost = String(targetHost || "").trim();
    const parsedProbePort = Number(targetPort) || 0;
    const probePort = Number.isInteger(parsedProbePort) && parsedProbePort > 0 ? parsedProbePort : 0;
    if (probeHost && probePort) {
        const {probeExitViaJump} = await import("./proxy-chain.js");
        const chained = await probeExitViaJump(url, viaJump, probeHost, probePort, Math.min(8000, timeoutSec * 1000));
        if (!chained.ok) {
            return {
                ok: false,
                ip: "",
                google: 0,
                accounts: 0,
                ms: Date.now() - started,
                reason: `出口链路失败 ${chained.reason || "跳板/出口 CONNECT 失败"}`,
            };
        }
        return {
            ok: true,
            ip: "?",
            google: 200,
            accounts: 0,
            ms: Date.now() - started,
        };
    }
    if (viaJump) {
        if (process.env.CODEX_HTTP === "1") {
            const {probeExitViaJump} = await import("./proxy-chain.js");
            const chained = await probeExitViaJump(url, viaJump, "www.google.com", 443, Math.min(8000, timeoutSec * 1000));
            if (!chained.ok) {
                return {
                    ok: false,
                    ip: "",
                    google: 0,
                    accounts: 0,
                    ms: Date.now() - started,
                    reason: `出口链路失败 ${chained.reason || "跳板/出口 CONNECT 失败"}`,
                };
            }
            return {
                ok: true,
                ip: "?",
                google: 200,
                accounts: 0,
                ms: Date.now() - started,
            };
        }
        try {
            const {wrapExitThroughJump} = await import("./proxy-chain.js");
            const wrapped = await wrapExitThroughJump(url, viaJump);
            curlUrl = wrapped.url;
            relayClose = wrapped.close;
        } catch {
            curlUrl = url;
        }
    }
    let ipR, gR, aR, ip = "";
    try {
        [ipR, gR, aR] = await Promise.all([
            curlVia(curlUrl, "https://api.ipify.org", [], timeoutSec, signal),
            curlVia(curlUrl, "https://www.google.com/generate_204", ["-o", "/dev/null", "-w", "%{http_code}"], timeoutSec, signal),
            curlVia(curlUrl, "https://accounts.google.com/ServiceLogin?hl=en", ["-o", "/dev/null", "-w", "%{http_code}"], timeoutSec, signal),
        ]);
        ip = ipR.ok && /^\d{1,3}(\.\d{1,3}){3}$/.test(ipR.stdout) ? ipR.stdout : "";
    } finally {
        relayClose();
    }
    const google = Number(gR.stdout || 0) || 0;
    const accounts = Number(aR.stdout || 0) || 0;
    const googleOk = google === 204 || google === 200 || (accounts >= 200 && accounts < 400);
    const ms = Date.now() - started;
    if (!ip && !googleOk) {
        return {ok: false, ip: "", google, accounts, ms, reason: `出口失败 ${ipR.reason || ipR.stdout || "无IP"} google=${google || gR.reason || "?"}`};
    }
    if (!googleOk) {
        return {ok: false, ip, google, accounts, ms, reason: `Google 不通 generate_204=${google || gR.reason || "?"} accounts=${accounts || aR.reason || "?"}`};
    }
    return {ok: true, ip: ip || "?", google: google || accounts, accounts, ms};
}

export async function pickLiveMailProxy(rawUrl: string, {
    tries = 3,
    rotate = true,
    log = (_m: string) => {},
    jump,
    timeoutSec,
    signal,
    targetHost,
    targetPort,
}: {
    tries?: number;
    rotate?: boolean;
    log?: (m: string) => void;
    jump?: string;
    timeoutSec?: number;
    signal?: AbortSignal;
    targetHost?: string;
    targetPort?: number;
} = {}) {
    let url = normalizeProxyUrl(rawUrl) || String(rawUrl || "").trim();
    const probeOptions = {jump, timeoutSec, signal, targetHost, targetPort};
    if (!url) return {ok: false, url: "", probe: await probeMailProxy("", probeOptions)};
    let probe = await probeMailProxy(url, probeOptions);
    const jumpDead = (p: any) => /ECONNREFUSED|跳板连不上|端口不通经跳板/i.test(String(p?.reason || ""));
    const hostTcpFail = (p: any) => /端口不通(?!经跳板)/.test(String(p?.reason || "")) || /tcp timeout/i.test(String(p?.reason || ""));
    const n = Math.max(1, Number(tries) || 3);
    for (let i = 1; i < n && !probe.ok; i++) {
        if (jumpDead(probe)) {
            log(`不通: ${probe.reason}（跳板口死了，换 kookeey session 没用）`);
            break;
        }
        if (hostTcpFail(probe)) {
            log(`不通: ${probe.reason}，入口死了不空等，换下一条`);
            break;
        }
        if (!rotate) {
            log(`不通: ${probe.reason}，仍用原 session 再测 (${i + 1}/${n})`);
        } else {
            const next = kookeeySessionOf(url) ? mintStickySession(url) : rotateKookeeySession(url);
            if (!next || next === url) break;
            log(`不通: ${probe.reason}，换 session 再测 (${i + 1}/${n})`);
            url = next;
        }
        probe = await probeMailProxy(url, probeOptions);
    }
    return {ok: probe.ok, url, probe};
}

/** 把记住的粘性 session 套回当前池子线路上（同一家网关/账号才套）。 */
export function applyRememberedSession(slotUrl: string, remembered: string): string {
    const mem = String(remembered || "").trim();
    if (!mem) return "";
    try {
        if (proxyTemplateKey(slotUrl) !== proxyTemplateKey(mem)) return "";
        const sess = kookeeySessionOf(mem);
        if (sess && kookeeySessionOf(slotUrl)) return withKookeeySession(slotUrl, sess, "");
        return mem;
    } catch {
        return "";
    }
}

export function maskProxyUrl(url: string): string {
    const s = String(url || "").trim();
    if (!s) return "(直连)";
    try {
        const u = new URL(s);
        if (/^vless:/i.test(u.protocol)) {
            const name = decodeURIComponent((u.hash || "").replace(/^#/, ""));
            return `vless://***@${u.hostname}${u.port ? ":" + u.port : ""}${name ? "#" + name : ""}`;
        }
        const auth = u.username ? `${decodeURIComponent(u.username)}:***@` : "";
        const sess = kookeeySessionOf(s);
        return `${u.protocol}//${auth}${u.hostname}${u.port ? ":" + u.port : ""}${sess ? "#s" + sess : ""}`;
    } catch {
        return s.replace(/:[^:@/]+@/, ":***@").slice(0, 80);
    }
}

const DIRECT = "__direct__";

function leaseAbortError() {
    const error = new Error("任务已取消");
    error.name = "AbortError";
    return error;
}

function waitForLeaseRetry(ms: number, signal?: AbortSignal) {
    return new Promise<void>((resolve, reject) => {
        if (signal?.aborted) return reject(leaseAbortError());
        const timer = setTimeout(done, ms);
        const onAbort = () => {
            clearTimeout(timer);
            signal?.removeEventListener("abort", onAbort);
            reject(leaseAbortError());
        };
        function done() {
            signal?.removeEventListener("abort", onAbort);
            resolve();
        }
        signal?.addEventListener("abort", onAbort, {once: true});
    });
}

export type ProxyPoolScope = "mail" | "gpt";

export class MailProxyPool {
    urls: string[] = [];
    leased = new Map<string, {owner: string; at: number; url?: string; base?: string; token?: string}>();
    lastUsed = new Map<string, number>();
    private leaseBackend: DistributedProxyLeaseBackend | null = null;
    private remoteConfigAt = 0;

    setLeaseBackend(backend: DistributedProxyLeaseBackend | null) {
        this.leaseBackend = backend;
        this.remoteConfigAt = 0;
    }

    async refreshConfiguration() {
        if (!this.leaseBackend?.loadConfiguration) return null;
        if (Date.now() - this.remoteConfigAt < 2_000) return null;
        const config = await this.leaseBackend.loadConfiguration();
        this.remoteConfigAt = Date.now();
        if (config?.initialized && Array.isArray(config.exitUrls)) this.setUrls(config.exitUrls);
        return config;
    }

    setUrls(list: string[]) {
        this.urls = parseProxyLines((list || []).join("\n"));
        // 配置替换不能回收运行中的租约，否则新任务可能立刻复用旧任务的出口。
        // 被移除的 URL 会在原任务 release 后自然清理；重新加回时仍会被旧租约阻塞。
    }

    slots(fallback = "", allowedUrls?: string[]): string[] {
        const allowed = allowedUrls === undefined
            ? this.urls
            : this.urls.filter((url) => allowedUrls.includes(url));
        if (allowed.length) return allowed.slice();
        const fb = normalizeProxyUrl(fallback) || String(fallback || "").trim();
        return fb ? [fb] : [DIRECT];
    }

    snapshot(fallback = "", allowedUrls?: string[]) {
        const slots = this.slots(fallback, allowedUrls);
        const slotSet = new Set(slots);
        const recordsFor = (slot: string) => [...this.leased.entries()]
            .filter(([key, lease]) => (lease.base || key) === slot)
            .map(([, lease]) => lease);
        const leasedRecords = [...this.leased.entries()]
            .filter(([key, lease]) => slotSet.has(lease.base || key));
        return {
            total: allowedUrls === undefined ? this.urls.length : this.urls.filter((url) => allowedUrls.includes(url)).length,
            slots: slots.length,
            leased: leasedRecords.length,
            free: slots.filter((u) => recordsFor(u).length === 0).length,
            items: slots.map((url) => {
                const records = recordsFor(url);
                const hit = records[0];
                return {url: url === DIRECT ? "" : url, masked: maskProxyUrl(url === DIRECT ? "" : url), leased: !!hit, owner: hit?.owner || ""};
            }),
        };
    }

    activeTemplateCount(template: string) {
        let count = 0;
        for (const [key, lease] of this.leased.entries()) {
            const base = lease.base || (key.startsWith("extra:") ? "" : key);
            if (base && proxyTemplateKey(base) === template) count += 1;
        }
        return count;
    }

    async lease(owner: string, {
        fallback = "",
        timeoutMs = 10 * 60 * 1000,
        maxPerTemplate = 1,
        freshSession = false,
        preferUrl = "",
        allowedUrls,
        signal,
        scope = "mail",
        leaseMs = 10 * 60 * 1000,
    }: {
        fallback?: string;
        timeoutMs?: number;
        maxPerTemplate?: number;
        freshSession?: boolean;
        preferUrl?: string;
        allowedUrls?: string[];
        signal?: AbortSignal;
        scope?: ProxyPoolScope;
        leaseMs?: number;
    } = {}): Promise<MailProxyLease> {
        const deadline = Date.now() + Math.max(1000, timeoutMs);
        const cap = Math.max(1, Number(maxPerTemplate) || 1);
        const prefer = String(preferUrl || "").trim();
        while (Date.now() < deadline) {
            if (signal?.aborted) throw leaseAbortError();
            await this.refreshConfiguration();
            const slots = this.slots(fallback, allowedUrls);
            const configuredSlots = allowedUrls === undefined
                ? this.urls
                : this.urls.filter((url) => allowedUrls.includes(url));
            if (this.leaseBackend && configuredSlots.length && slots.some((url) => url !== DIRECT)) {
                const candidates: ProxyLeaseCandidate[] = [];
                const seen = new Set<string>();
                const add = (baseUrl: string, liveUrl: string, leaseKey: string) => {
                    if (baseUrl === DIRECT || seen.has(leaseKey)) return;
                    seen.add(leaseKey);
                    candidates.push({
                        resourceKey: baseUrl,
                        baseUrl,
                        leaseKey,
                        templateKey: proxyTemplateKey(baseUrl),
                        liveUrl,
                    });
                };
                if (prefer) {
                    for (const baseUrl of slots.filter((url) => url !== DIRECT && applyRememberedSession(url, prefer))) {
                        add(baseUrl, applyRememberedSession(baseUrl, prefer) || prefer, baseUrl);
                    }
                    for (const baseUrl of slots.filter((url) => url !== DIRECT && applyRememberedSession(url, prefer))) {
                        add(baseUrl, prefer, `extra:${proxyTemplateKey(baseUrl)}:${kookeeySessionOf(prefer) || prefer}`);
                    }
                } else {
                    const exact = slots.filter((url) => url !== DIRECT)
                        .sort((a, b) => (this.lastUsed.get(a) || 0) - (this.lastUsed.get(b) || 0));
                    for (const baseUrl of exact) {
                        const live = freshSession && kookeeySessionOf(baseUrl) ? mintStickySession(baseUrl) : baseUrl;
                        add(baseUrl, live, baseUrl);
                    }
                    for (const baseUrl of exact.filter((url) => kookeeySessionOf(url))) {
                        const live = mintStickySession(baseUrl);
                        add(baseUrl, live, `extra:${proxyTemplateKey(baseUrl)}:${kookeeySessionOf(live) || live}`);
                    }
                }
                const remote = await this.leaseBackend.acquire({
                    kind: "exit",
                    scope,
                    owner: String(owner || ""),
                    candidates,
                    maxPerTemplate: cap,
                    leaseMs: Math.max(30_000, Number(leaseMs) || 10 * 60 * 1000),
                    signal,
                });
                if (remote) {
                    const key = remote.leaseKey || remote.resourceKey;
                    const ownerValue = String(owner || "");
                    this.leased.set(key, {owner: ownerValue, at: Date.now(), url: remote.url, base: remote.resourceKey, token: remote.leaseToken});
                    this.lastUsed.set(remote.resourceKey, Date.now());
                    return this.createDistributedLease("exit", key, remote.leaseToken, remote.url, ownerValue, Math.max(30_000, Number(leaseMs) || 10 * 60 * 1000));
                }
                await waitForLeaseRetry(400, signal);
                continue;
            }
            if (prefer) {
                const compatible = slots.filter((u) => u !== DIRECT && applyRememberedSession(u, prefer));
                if (compatible.length) {
                    const match = compatible.find((u) => !this.leased.has(u));
                    if (match) {
                        const live = applyRememberedSession(match, prefer) || prefer;
                        this.leased.set(match, {owner: String(owner || ""), at: Date.now(), url: live, base: match});
                        this.lastUsed.set(match, Date.now());
                        return {url: live, owner: String(owner || ""), release: () => this.release(match)};
                    }
                    const template = proxyTemplateKey(match);
                    const extraKey = `extra:${template}:${kookeeySessionOf(prefer) || prefer}`;
                    if (!this.leased.has(extraKey) && this.activeTemplateCount(template) < cap) {
                        this.leased.set(extraKey, {owner: String(owner || ""), at: Date.now(), url: prefer, base: match});
                        return {url: prefer, owner: String(owner || ""), release: () => this.release(extraKey)};
                    }
                    await waitForLeaseRetry(400, signal);
                    continue;
                }
            }
            const freeExact = slots.filter((u) => !this.leased.has(u))
                .sort((a, b) => (this.lastUsed.get(a) || 0) - (this.lastUsed.get(b) || 0));
            if (freeExact[0]) {
                const url = freeExact[0];
                const live = url !== DIRECT && freshSession && kookeeySessionOf(url) ? mintStickySession(url) : url;
                this.leased.set(url, {owner: String(owner || ""), at: Date.now(), url: live, base: url});
                this.lastUsed.set(url, Date.now());
                return {
                    url: live === DIRECT ? "" : (freshSession ? live : ensureKookeeySticky(live)),
                    owner: String(owner || ""),
                    release: () => this.release(url),
                };
            }
            const extraParent = slots
                .filter((u) => u !== DIRECT && kookeeySessionOf(u))
                .sort((a, b) => {
                    const count = this.activeTemplateCount(proxyTemplateKey(a)) - this.activeTemplateCount(proxyTemplateKey(b));
                    return count || (this.lastUsed.get(a) || 0) - (this.lastUsed.get(b) || 0);
                })
                .find((u) => this.activeTemplateCount(proxyTemplateKey(u)) < cap);
            if (extraParent) {
                const live = mintStickySession(extraParent);
                const key = `extra:${proxyTemplateKey(extraParent)}:${kookeeySessionOf(live) || live}`;
                if (this.leased.has(key)) {
                    await waitForLeaseRetry(50, signal);
                    continue;
                }
                this.leased.set(key, {owner: String(owner || ""), at: Date.now(), url: live, base: extraParent});
                return {
                    url: live,
                    owner: String(owner || ""),
                    release: () => this.release(key),
                };
            }
            await waitForLeaseRetry(400, signal);
        }
        throw new Error("代理池全忙（1 代理 = 1 指纹），等待超时");
    }

    release(url: string) {
        const key = url || DIRECT;
        const record = this.leased.get(key);
        this.leased.delete(key);
        if (record?.token && this.leaseBackend) {
            return this.leaseBackend.release({kind: "exit", leaseToken: record.token}).catch(() => {});
        }
    }

    private createDistributedLease(kind: "exit" | "jump", key: string, token: string, url: string, owner: string, leaseMs: number): MailProxyLease {
        const intervalMs = Math.max(10_000, Math.floor(leaseMs / 3));
        const timer = this.leaseBackend
            ? setInterval(() => {
                void this.leaseBackend?.renew({kind, leaseToken: token, leaseMs}).catch(() => {});
            }, intervalMs)
            : null;
        timer?.unref?.();
        let released = false;
        return {
            url: url === DIRECT ? "" : url,
            owner,
            release: async () => {
                if (released) return;
                released = true;
                if (timer) clearInterval(timer);
                await this.release(key);
            },
        };
    }
}

/**
 * 两个业务域共享同一个底层租约池。视图只负责范围开关，避免同一代理被
 * 邮箱和 GPT 同时占用成两条独立租约。
 */
class ScopedProxyPool {
    constructor(private readonly shared: MailProxyPool, private readonly scope: ProxyPoolScope) {}
    enabled = true;
    get urls() { return this.enabled ? this.shared.urls.slice() : []; }
    get leased() { return this.shared.leased; }
    setUrls(list: string[]) { this.shared.setUrls(list); }
    snapshot(fallback = "") { return this.shared.snapshot(fallback, this.urls); }
    lease(owner: string, options: any = {}) {
        return this.shared.refreshConfiguration().then((config) => {
            if (config?.initialized) {
                this.enabled = this.scope === "mail" ? config.exitMailEnabled !== false : config.exitGptEnabled !== false;
            }
            return this.shared.lease(owner, {...options, allowedUrls: this.urls, scope: this.scope});
        });
    }
    setScopeEnabled(enabled: boolean) { this.enabled = !!enabled; }
    getScope() { return this.scope; }
}

export const proxyPool = new MailProxyPool();
export const mailProxyPool = new ScopedProxyPool(proxyPool, "mail");
export const gptProxyPool = new ScopedProxyPool(proxyPool, "gpt");

export function setProxyPoolScopeEnabled(scope: ProxyPoolScope, enabled: boolean) {
    (scope === "mail" ? mailProxyPool : gptProxyPool).setScopeEnabled(enabled);
}

export function isProxyPoolScopeEnabled(scope: ProxyPoolScope) {
    return (scope === "mail" ? mailProxyPool : gptProxyPool).enabled;
}

export const JUMP_MAX_EXITS = 4;

export type JumpHealth = {ok: boolean; at: number; ms: number; ip: string; google: number; reason?: string};

/** 只测跳板本身能不能出网。本地 xray 用 SOCKS 探测，curl -x 常误报超时。 */
export async function probeJumpAlive(rawUrl: string, timeoutSec = 10): Promise<JumpHealth> {
    const url = normalizeProxyUrl(rawUrl) || String(rawUrl || "").trim();
    const started = Date.now();
    const empty = {ok: false, at: Date.now(), ms: 0, ip: "", google: 0, reason: "无跳板"};
    if (!url) return empty;
    let host = "", port = 1080;
    try {
        const u = new URL(url.includes("://") ? url.split("#")[0] : `socks5://${url}`);
        host = u.hostname;
        port = Number(u.port || 1080);
    } catch {
        return {...empty, ms: Date.now() - started, reason: "跳板 URL 无效"};
    }
    const tcp = await tcpReach(host, port, 4000);
    if (!tcp.ok) {
        return {ok: false, at: Date.now(), ms: Date.now() - started, ip: "", google: 0, reason: `端口不通 ${host}:${port} (${tcp.reason})`};
    }
    const {probeJumpTo} = await import("./proxy-chain.js");
    const waitMs = Math.max(4000, Number(timeoutSec || 10) * 1000);
    const g = await probeJumpTo(url, "www.google.com", 443, waitMs);
    const ms = Date.now() - started;
    if (!g.ok) {
        return {ok: false, at: Date.now(), ms, ip: "", google: 0, reason: `跳板连不上 Google (${g.reason || "?"})`};
    }
    return {ok: true, at: Date.now(), ms, ip: host === "127.0.0.1" || host === "localhost" ? "local" : "?", google: 204};
}

export type JumpLease = {url: string; owner: string; release: () => void};

export class JumpPool {
    urls: string[] = [];
    leased = new Map<string, {owner: string; at: number; token?: string; resourceKey?: string}[]>();
    health = new Map<string, JumpHealth>();
    maxPerJump = JUMP_MAX_EXITS;
    resourceKeys = new Map<string, string>();
    private leaseBackend: DistributedProxyLeaseBackend | null = null;

    setLeaseBackend(backend: DistributedProxyLeaseBackend | null) {
        this.leaseBackend = backend;
    }

    setUrls(list: string[], {keys = new Map<string, string>()} = {}) {
        this.urls = parseProxyLines((list || []).join("\n"));
        this.resourceKeys = new Map(this.urls.map((url) => [url, keys.get(url) || url]));
        // 和出口池一样，配置变更只影响新租约，不能让活动租约失去释放和占用状态。
        for (const k of [...this.health.keys()]) {
            if (!this.urls.includes(k)) this.health.delete(k);
        }
    }

    addUrl(raw: string) {
        const url = normalizeProxyUrl(raw);
        if (!url || this.urls.includes(url)) return this.urls.slice();
        this.urls.push(url);
        this.resourceKeys.set(url, url);
        return this.urls.slice();
    }

    load(url: string) {
        return (this.leased.get(url) || []).length;
    }

    snapshot(allowedUrls?: string[]) {
        const urls = allowedUrls === undefined
            ? this.urls
            : this.urls.filter((url) => allowedUrls.includes(url));
        return {
            total: urls.length,
            maxPerJump: this.maxPerJump,
            items: urls.map((url) => {
                const h = this.health.get(url);
                const owners = (this.leased.get(url) || []).map((x) => x.owner);
                return {
                    url,
                    masked: maskProxyUrl(url),
                    leased: owners.length,
                    cap: this.maxPerJump,
                    owners,
                    ok: h ? h.ok : null,
                    ip: h?.ip || "",
                    google: h?.google || 0,
                    ms: h?.ms || 0,
                    reason: h?.reason || "",
                    checkedAt: h?.at || 0,
                };
            }),
        };
    }

    async checkOne(url: string) {
        const h = await probeJumpAlive(url);
        this.health.set(url, h);
        return h;
    }

    async checkAll({concurrency = 4} = {}) {
        const urls = this.urls.slice();
        let cursor = 0;
        const worker = async () => {
            while (cursor < urls.length) {
                const index = cursor++;
                await this.checkOne(urls[index]);
            }
        };
        const count = Math.min(Math.max(1, Number(concurrency) || 4), urls.length);
        await Promise.all(Array.from({length: count}, () => worker()));
        return this.snapshot();
    }

    async lease(owner: string, {
        timeoutMs = 60_000,
        maxPerJump = JUMP_MAX_EXITS,
        signal,
        scope = "mail",
        leaseMs = 10 * 60 * 1000,
    }: {
        timeoutMs?: number;
        maxPerJump?: number;
        signal?: AbortSignal;
        scope?: ProxyPoolScope;
        leaseMs?: number;
    } = {}): Promise<JumpLease | null> {
        if (!this.urls.length) return null;
        const cap = Math.max(1, Number(maxPerJump) || JUMP_MAX_EXITS);
        const deadline = Date.now() + Math.max(1000, timeoutMs);
        while (Date.now() < deadline) {
            if (signal?.aborted) throw leaseAbortError();
            const ranked = this.urls.slice().sort((a, b) => this.load(a) - this.load(b));
            const healthy: Array<{url: string; health: JumpHealth}> = [];
            for (const url of ranked) {
                if (this.load(url) >= cap) continue;
                let h = this.health.get(url);
                const staleMs = h?.ok ? 90_000 : 15_000;
                if (!h || Date.now() - h.at > staleMs) {
                    h = await this.checkOne(url);
                }
                if (signal?.aborted) throw leaseAbortError();
                if (!h.ok) continue;
                healthy.push({url, health: h});
            }
            if (this.leaseBackend && healthy.length) {
                const remote = await this.leaseBackend.acquire({
                    kind: "jump",
                    scope,
                    owner: String(owner || ""),
                    candidates: healthy.map(({url}) => ({
                        resourceKey: this.resourceKeys.get(url) || url,
                        baseUrl: url,
                        leaseKey: this.resourceKeys.get(url) || url,
                        templateKey: this.resourceKeys.get(url) || url,
                        liveUrl: url,
                    })),
                    maxPerTemplate: cap,
                    leaseMs: Math.max(30_000, Number(leaseMs) || 10 * 60 * 1000),
                    signal,
                });
                if (!remote) {
                    await waitForLeaseRetry(400, signal);
                    continue;
                }
                const url = remote.url;
                const row = {owner: String(owner || ""), at: Date.now(), token: remote.leaseToken, resourceKey: remote.resourceKey};
                const list = this.leased.get(url) || [];
                list.push(row);
                this.leased.set(url, list);
                return this.createDistributedLease(url, row, Math.max(30_000, Number(leaseMs) || 10 * 60 * 1000));
            }
            for (const {url} of healthy) {
                const row = {owner: String(owner || ""), at: Date.now()};
                const list = this.leased.get(url) || [];
                list.push(row);
                this.leased.set(url, list);
                return {
                    url,
                    owner: row.owner,
                    release: () => this.release(url, row.owner),
                };
            }
            await waitForLeaseRetry(400, signal);
        }
        throw new Error(`跳板池全忙或不可用（1 跳板最多 ${cap} 条出口）`);
    }

    release(url: string, owner: string, token = "") {
        const list = this.leased.get(url) || [];
        const released = token ? list.find((x) => x.token === token) : null;
        const next = token ? list.filter((x) => x.token !== token) : list.filter((x) => x.owner !== owner);
        if (next.length) this.leased.set(url, next);
        else this.leased.delete(url);
        if (released?.token && this.leaseBackend) {
            return this.leaseBackend.release({kind: "jump", leaseToken: released.token}).catch(() => {});
        }
    }

    private createDistributedLease(url: string, row: {owner: string; token?: string}, leaseMs: number): JumpLease {
        const timer = row.token && this.leaseBackend
            ? setInterval(() => {
                void this.leaseBackend?.renew({kind: "jump", leaseToken: row.token!, leaseMs}).catch(() => {});
            }, Math.max(10_000, Math.floor(leaseMs / 3)))
            : null;
        timer?.unref?.();
        let released = false;
        return {
            url,
            owner: row.owner,
            release: async () => {
                if (released) return;
                released = true;
                if (timer) clearInterval(timer);
                await this.release(url, row.owner, row.token || "");
            },
        };
    }
}

export const jumpPool = new JumpPool();

class ScopedJumpPool {
    constructor(private readonly shared: JumpPool, private readonly scope: ProxyPoolScope) {}
    enabled = true;
    get urls() { return this.enabled ? this.shared.urls.slice() : []; }
    setUrls(list: string[], options = {}) { this.shared.setUrls(list, options); }
    addUrl(raw: string) { return this.shared.addUrl(raw); }
    snapshot() { return this.shared.snapshot(this.urls); }
    checkAll() { return this.enabled ? this.shared.checkAll() : Promise.resolve(this.snapshot()); }
    lease(owner: string, options: any = {}) {
        return this.enabled ? this.shared.lease(owner, {...options, scope: this.scope}) : Promise.resolve(null);
    }
    setScopeEnabled(enabled: boolean) { this.enabled = !!enabled; }
    getScope() { return this.scope; }
}

/** 兼容旧调用方；两个域共用同一跳板租约和健康状态。 */
export const mailJumpPool = new ScopedJumpPool(jumpPool, "mail");
export const gptJumpPool = new ScopedJumpPool(jumpPool, "gpt");

export function setJumpPoolScopeEnabled(scope: ProxyPoolScope, enabled: boolean) {
    (scope === "mail" ? mailJumpPool : gptJumpPool).setScopeEnabled(enabled);
}

export function isJumpPoolScopeEnabled(scope: ProxyPoolScope) {
    return (scope === "mail" ? mailJumpPool : gptJumpPool).enabled;
}

/** 由 HTTP 主进程注入数据库协调器；worker/单测不注入时继续使用进程内实现。 */
export function configureProxyPoolBackend(backend: DistributedProxyLeaseBackend | null) {
    proxyPool.setLeaseBackend(backend);
    jumpPool.setLeaseBackend(backend);
}
