// 邮箱整备/换2FA/改密用的代理池。默认 1 个代理同一时刻只绑 1 个比特指纹窗口。
import {execFile} from "node:child_process";
import net from "node:net";
import {promisify} from "node:util";

const execFileAsync = promisify(execFile);

export type MailProxyLease = {
    url: string;
    owner: string;
    release: () => void;
};

export function normalizeProxyUrl(raw: string): string {
    const s = String(raw || "").trim();
    if (!s || s.startsWith("#")) return "";
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) {
        try { new URL(s); return s; } catch { return ""; }
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
    return /代理中断|ERR_PROXY|chrome-error|代理不通|Cloudflare|Unable to load site|出口被|换 session|ERR_TUNNEL|ERR_CONNECTION|ERR_TIMED_OUT|ERR_SSL|ERR_EMPTY_RESPONSE|ERR_NETWORK_CHANGED|ERR_INTERNET_DISCONNECTED|端口不通|Google 不通|出口失败|this site can.?t be reached|No internet|something wrong with the proxy|Checking the proxy address|SSL\/代理|打开目标页失败\(网络|Target closed|has been closed|Browser has been closed/i.test(s);
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

function templateKey(url: string): string {
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

function tcpReach(host: string, port: number, timeoutMs = 5000): Promise<{ok: boolean; reason?: string}> {
    return new Promise((resolve) => {
        const sock = net.connect({host, port, timeout: timeoutMs});
        const done = (ok: boolean, reason?: string) => {
            try { sock.destroy(); } catch { /* */ }
            resolve(ok ? {ok: true} : {ok: false, reason});
        };
        sock.once("connect", () => done(true));
        sock.once("timeout", () => done(false, "tcp timeout"));
        sock.once("error", (e) => done(false, String(e?.message || e).slice(0, 80)));
    });
}

async function tcpReachMaybeJump(host: string, port: number, timeoutMs = 8000, jump = mailProxyJump) {
    if (!jump) return tcpReach(host, port, timeoutMs);
    const {probeJumpTo} = await import("./proxy-chain.js");
    const r = await probeJumpTo(jump, host, port, timeoutMs);
    return r.ok ? {ok: true} : {ok: false, reason: `跳板连不上 ${host}:${port} (${r.reason})`};
}

async function curlVia(proxyUrl: string, target: string, extra: string[] = [], timeoutSec = 12) {
    try {
        const {stdout, stderr} = await execFileAsync("curl", [
            "-sS", "--max-time", String(timeoutSec), "-x", curlSocksArg(proxyUrl), ...extra, target,
        ], {encoding: "utf8", timeout: (timeoutSec + 2) * 1000});
        return {ok: true, stdout: String(stdout || "").trim(), stderr: String(stderr || "").trim()};
    } catch (e: any) {
        return {
            ok: false,
            stdout: String(e?.stdout || "").trim(),
            reason: String(e?.stderr || e?.message || e).replace(/\s+/g, " ").slice(0, 160),
        };
    }
}

/** 开指纹前先测 SOCKS：端口、出口 IP、Google。不通就别去登。 */
export async function probeMailProxy(rawUrl: string, {timeoutSec = 12, jump}: {timeoutSec?: number; jump?: string} = {}): Promise<{
    ok: boolean; ip: string; google: number; accounts: number; ms: number; reason?: string;
}> {
    const url = normalizeProxyUrl(rawUrl) || String(rawUrl || "").trim();
    const started = Date.now();
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
    const tcp = await tcpReachMaybeJump(host, port, 8000, viaJump);
    if (!tcp.ok) {
        const via = viaJump ? "经跳板" : "";
        return {ok: false, ip: "", google: 0, accounts: 0, ms: Date.now() - started, reason: `端口不通${via} ${host}:${port} (${tcp.reason})`};
    }
    let curlUrl = url;
    let relayClose = () => {};
    if (viaJump) {
        const {wrapExitThroughJump} = await import("./proxy-chain.js");
        const wrapped = await wrapExitThroughJump(url, viaJump);
        curlUrl = wrapped.url;
        relayClose = wrapped.close;
    }
    let ipR, gR, aR, ip = "";
    try {
        ipR = await curlVia(curlUrl, "https://api.ipify.org", [], timeoutSec);
        ip = ipR.ok && /^\d{1,3}(\.\d{1,3}){3}$/.test(ipR.stdout) ? ipR.stdout : "";
        gR = await curlVia(curlUrl, "https://www.google.com/generate_204", ["-o", "/dev/null", "-w", "%{http_code}"], timeoutSec);
        aR = await curlVia(curlUrl, "https://accounts.google.com/ServiceLogin?hl=en", ["-o", "/dev/null", "-w", "%{http_code}"], timeoutSec);
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

export async function pickLiveMailProxy(rawUrl: string, {tries = 3, log = (_m: string) => {}, jump}: {tries?: number; log?: (m: string) => void; jump?: string} = {}) {
    let url = normalizeProxyUrl(rawUrl) || String(rawUrl || "").trim();
    if (!url) return {ok: false, url: "", probe: await probeMailProxy("", {jump})};
    let probe = await probeMailProxy(url, {jump});
    for (let i = 1; i < tries && !probe.ok; i++) {
        const next = kookeeySessionOf(url) ? mintStickySession(url) : rotateKookeeySession(url);
        if (!next || next === url) break;
        log(`不通: ${probe.reason}，换 session 再测 (${i + 1}/${tries})`);
        url = next;
        probe = await probeMailProxy(url, {jump});
    }
    return {ok: probe.ok, url, probe};
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

export class MailProxyPool {
    urls: string[] = [];
    leased = new Map<string, {owner: string; at: number}>();
    lastUsed = new Map<string, number>();

    setUrls(list: string[]) {
        this.urls = parseProxyLines((list || []).join("\n"));
        for (const k of [...this.leased.keys()]) {
            if (k !== DIRECT && !this.urls.includes(k)) this.leased.delete(k);
        }
    }

    slots(fallback = ""): string[] {
        if (this.urls.length) return this.urls.slice();
        const fb = normalizeProxyUrl(fallback) || String(fallback || "").trim();
        return fb ? [fb] : [DIRECT];
    }

    snapshot(fallback = "") {
        const slots = this.slots(fallback);
        return {
            total: this.urls.length,
            slots: slots.length,
            leased: [...this.leased.keys()].filter((k) => slots.includes(k)).length,
            free: slots.filter((u) => !this.leased.has(u)).length,
            items: slots.map((url) => {
                const hit = this.leased.get(url);
                return {url: url === DIRECT ? "" : url, masked: maskProxyUrl(url === DIRECT ? "" : url), leased: !!hit, owner: hit?.owner || ""};
            }),
        };
    }

    async lease(owner: string, {fallback = "", timeoutMs = 10 * 60 * 1000, maxPerTemplate = 1, freshSession = false} = {}): Promise<MailProxyLease> {
        const deadline = Date.now() + Math.max(1000, timeoutMs);
        const cap = Math.max(1, Number(maxPerTemplate) || 1);
        while (Date.now() < deadline) {
            const slots = this.slots(fallback);
            const freeExact = slots.filter((u) => !this.leased.has(u))
                .sort((a, b) => (this.lastUsed.get(a) || 0) - (this.lastUsed.get(b) || 0));
            if (freeExact[0]) {
                const url = freeExact[0];
                const live = url !== DIRECT && freshSession && kookeeySessionOf(url) ? mintStickySession(url) : url;
                this.leased.set(url, {owner: String(owner || ""), at: Date.now(), url: live});
                this.lastUsed.set(url, Date.now());
                return {
                    url: live === DIRECT ? "" : (freshSession ? live : ensureKookeeySticky(live)),
                    owner: String(owner || ""),
                    release: () => this.release(url),
                };
            }
            const extraParent = slots.find((u) => kookeeySessionOf(u));
            const extraCount = [...this.leased.keys()].filter((k) => k.startsWith("extra:")).length;
            if (extraParent && extraCount < cap) {
                const live = mintStickySession(extraParent);
                const key = `extra:${live}`;
                this.leased.set(key, {owner: String(owner || ""), at: Date.now(), url: live});
                return {
                    url: live,
                    owner: String(owner || ""),
                    release: () => this.release(key),
                };
            }
            await new Promise((r) => setTimeout(r, 400));
        }
        throw new Error("代理池全忙（1 代理 = 1 指纹），等待超时");
    }

    release(url: string) {
        const key = url || DIRECT;
        this.leased.delete(key);
    }
}

export const mailProxyPool = new MailProxyPool();
export const gptProxyPool = new MailProxyPool();

export const JUMP_MAX_EXITS = 2;

export type JumpHealth = {ok: boolean; at: number; ms: number; ip: string; google: number; reason?: string};

/** 只测跳板本身能不能出网（不经 kookeey）。 */
export async function probeJumpAlive(rawUrl: string, timeoutSec = 10): Promise<JumpHealth> {
    const url = normalizeProxyUrl(rawUrl) || String(rawUrl || "").trim();
    const started = Date.now();
    const empty = {ok: false, at: Date.now(), ms: 0, ip: "", google: 0, reason: "无跳板"};
    if (!url) return empty;
    let host = "", port = 1080;
    try {
        const u = new URL(url);
        host = u.hostname;
        port = Number(u.port || 1080);
    } catch {
        return {...empty, ms: Date.now() - started, reason: "跳板 URL 无效"};
    }
    const tcp = await tcpReach(host, port, 4000);
    if (!tcp.ok) {
        return {ok: false, at: Date.now(), ms: Date.now() - started, ip: "", google: 0, reason: `端口不通 ${host}:${port} (${tcp.reason})`};
    }
    const ipR = await curlVia(url, "https://api.ipify.org", [], timeoutSec);
    const ip = ipR.ok && /^\d{1,3}(\.\d{1,3}){3}$/.test(ipR.stdout) ? ipR.stdout : "";
    const gR = await curlVia(url, "https://www.google.com/generate_204", ["-o", "/dev/null", "-w", "%{http_code}"], timeoutSec);
    const google = Number(gR.stdout || 0) || 0;
    const googleOk = google === 204 || google === 200;
    const ms = Date.now() - started;
    if (!ip && !googleOk) {
        return {ok: false, at: Date.now(), ms, ip: "", google, reason: `跳板出网失败 ${ipR.reason || ipR.stdout || "无IP"} google=${google || gR.reason || "?"}`};
    }
    if (!googleOk) {
        return {ok: false, at: Date.now(), ms, ip, google, reason: `跳板 Google 不通 generate_204=${google || gR.reason || "?"}`};
    }
    return {ok: true, at: Date.now(), ms, ip: ip || "?", google};
}

export type JumpLease = {url: string; owner: string; release: () => void};

export class JumpPool {
    urls: string[] = [];
    leased = new Map<string, {owner: string; at: number}[]>();
    health = new Map<string, JumpHealth>();
    maxPerJump = JUMP_MAX_EXITS;

    setUrls(list: string[]) {
        this.urls = parseProxyLines((list || []).join("\n"));
        for (const k of [...this.leased.keys()]) {
            if (!this.urls.includes(k)) this.leased.delete(k);
        }
        for (const k of [...this.health.keys()]) {
            if (!this.urls.includes(k)) this.health.delete(k);
        }
    }

    addUrl(raw: string) {
        const url = normalizeProxyUrl(raw);
        if (!url || this.urls.includes(url)) return this.urls.slice();
        this.urls.push(url);
        return this.urls.slice();
    }

    load(url: string) {
        return (this.leased.get(url) || []).length;
    }

    snapshot() {
        return {
            total: this.urls.length,
            maxPerJump: this.maxPerJump,
            items: this.urls.map((url) => {
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

    async checkAll() {
        const out = [];
        for (const url of this.urls) out.push(await this.checkOne(url));
        return this.snapshot();
    }

    async lease(owner: string, {timeoutMs = 60_000, maxPerJump = JUMP_MAX_EXITS} = {}): Promise<JumpLease | null> {
        if (!this.urls.length) return null;
        const cap = Math.max(1, Number(maxPerJump) || JUMP_MAX_EXITS);
        const deadline = Date.now() + Math.max(1000, timeoutMs);
        while (Date.now() < deadline) {
            const ranked = this.urls.slice().sort((a, b) => this.load(a) - this.load(b));
            for (const url of ranked) {
                if (this.load(url) >= cap) continue;
                let h = this.health.get(url);
                if (!h || Date.now() - h.at > 90_000) {
                    h = await this.checkOne(url);
                }
                if (!h.ok) continue;
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
            await new Promise((r) => setTimeout(r, 400));
        }
        throw new Error(`跳板池全忙或不可用（1 跳板最多 ${cap} 条出口）`);
    }

    release(url: string, owner: string) {
        const list = this.leased.get(url) || [];
        const next = list.filter((x) => x.owner !== owner);
        if (next.length) this.leased.set(url, next);
        else this.leased.delete(url);
    }
}

export const mailJumpPool = new JumpPool();
/** 邮箱/GPT 共用同一份跳板租约，保证 1 个跳板全局最多 2 条出口。 */
export const gptJumpPool = mailJumpPool;
