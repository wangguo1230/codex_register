// ChatGPT TOTP:绑定走 backend-api(需网页 AT + 注册代理过 CF);算码 RFC 6238。
// 前端仍是 POST /backend-api/accounts/mfa/enroll {factor_type:"totp"} → {session_id,secret}
// 再 POST .../activate_enrollment {factor_type,session_id,code}；状态看 mfa_info.mfa_enabled_v2。
import {createHmac} from "node:crypto";
import {existsSync} from "node:fs";
import {CHATGPT_BASE_URL, DEFAULT_USER_AGENT} from "./constants.js";
import {buildProxyDispatcher} from "./token-check.js";

const ENROLL_URL = `${CHATGPT_BASE_URL}/backend-api/accounts/mfa/enroll`;
const ACTIVATE_URL = `${CHATGPT_BASE_URL}/backend-api/accounts/mfa/user/activate_enrollment`;
const INFO_URL = `${CHATGPT_BASE_URL}/backend-api/accounts/mfa_info`;

/** 前端 enable MFA 用 CA=240s 判 pwd_auth_time 是否过期，略放宽到 220s 留余量。 */
export const MFA_PWD_AUTH_WINDOW_MS = 220_000;

export type EnrollTotpOpts = {
    accountId?: string;
    proxyUrl?: string;
    /** auth 文件里的 cookie 串（含 __cf_bm / oai-did），显著降低 CF 拦 Node */
    cookie?: string;
    /** 网络失败时是否再试直连/换代理顺序，默认 true */
    retryAltProxy?: boolean;
    /** HTTP 全失败时是否用真 Chrome 再绑一次，默认 true */
    browserFallback?: boolean;
    headless?: boolean;
    log?: (msg: string) => void;
    /**
     * enroll 报「必须重新验证密码」时调用：返回新的 AT(+cookie/accountId)。
     * 不要在 mfa 内 import OpenAIClient（会循环依赖），由调用方注入。
     */
    reauth?: () => Promise<{accessToken: string; accountId?: string; cookie?: string} | null | undefined>;
};

export type EnrollTotpResult = {
    ok: boolean;
    already?: boolean;
    secret?: string;
    reason?: string;
    via?: "http" | "browser";
    /** 需密码重新登录后再绑（session 的 pwd_auth_time 过期或 enroll 返回 re-authenticate） */
    needReauth?: boolean;
};

export function isMfaContinueUrl(url: string): boolean {
    // 含 /mfa-challenge/<id>：邮箱 OTP 之后的网页 2FA 页(不能要求 mfa 后必须是 / ? 结尾)
    return /\/(mfa|totp|two-factor|2fa|authenticator)([-/?]|$)/i.test(String(url || ""));
}

export function generateTotpCandidates(secret: string, atMs = Date.now()): string[] {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const delta of [-30000, 0, 30000]) {
        const c = generateTotp(secret, atMs + delta);
        if (c && !seen.has(c)) { seen.add(c); out.push(c); }
    }
    return out;
}

export function totpRemainSec(atMs = Date.now(), step = 30): number {
    return step - (Math.floor(atMs / 1000) % step);
}

/** 窗口剩余太短时等到下一窗，避免刚填完就过期被 Google 判 Wrong code。 */
export async function waitTotpSafeWindow(minRemain = 8, step = 30): Promise<void> {
    const remain = totpRemainSec(Date.now(), step);
    if (remain >= minRemain) return;
    await new Promise((r) => setTimeout(r, (remain + 1) * 1000));
}

export async function waitNextTotpWindow(step = 30): Promise<void> {
    await new Promise((r) => setTimeout(r, (totpRemainSec(Date.now(), step) + 1) * 1000));
}

export function generateTotp(secret: string, atMs = Date.now(), step = 30, digits = 6): string {
    const key = base32Decode(normalizeTotpSecret(secret));
    if (!key.length) return "";
    let counter = Math.floor(atMs / 1000 / step);
    const buf = Buffer.alloc(8);
    for (let i = 7; i >= 0; i--) {
        buf[i] = counter & 0xff;
        counter = Math.floor(counter / 256);
    }
    const hmac = createHmac("sha1", key).update(buf).digest();
    const offset = hmac[hmac.length - 1] & 0x0f;
    const bin = ((hmac[offset] & 0x7f) << 24) | (hmac[offset + 1] << 16) | (hmac[offset + 2] << 8) | hmac[offset + 3];
    return String(bin % 10 ** digits).padStart(digits, "0");
}

export function looksLikeTotpSecret(raw: string): boolean {
    const n = normalizeTotpSecret(raw);
    return n.length >= 16 && !n.includes("@") && !/[^A-Z2-7]/.test(n);
}

export function looksLikeEmail(raw: string): boolean {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(raw || "").trim());
}

/** 导入时 totp/辅助邮箱对调过：totp 里是邮箱、recovery 里才是密钥。 */
export function straightenGoogleCreds(cred: {totpSecret?: string; totp_secret?: string; recoveryEmail?: string; recovery_email?: string} = {}) {
    let totp = String(cred.totpSecret || cred.totp_secret || "").trim();
    let rec = String(cred.recoveryEmail || cred.recovery_email || "").trim();
    let swapped = false;
    if (looksLikeEmail(totp) && looksLikeTotpSecret(rec)) {
        const t = totp;
        totp = rec;
        rec = t;
        swapped = true;
    } else if (looksLikeEmail(totp) && !looksLikeTotpSecret(totp)) {
        if (!looksLikeEmail(rec)) rec = totp;
        totp = "";
        swapped = true;
    } else if (!looksLikeTotpSecret(totp)) {
        totp = "";
    }
    return {totpSecret: totp, recoveryEmail: rec, swapped};
}

/** 导入行落库前纠正 totp/辅助邮箱，避免只在跑任务时内存对调。 */
export function straightenImportRow(r: {totp_secret?: string; recovery_email?: string} = {}) {
    const s = straightenGoogleCreds({totpSecret: r.totp_secret, recoveryEmail: r.recovery_email});
    return {
        ...r,
        totp_secret: s.totpSecret,
        recovery_email: s.recoveryEmail,
        swapped: s.swapped,
    };
}

export function normalizeTotpSecret(raw: string): string {
    const s = String(raw || "").trim();
    if (!s) return "";
    const fromUri = s.match(/[?&]secret=([^&]+)/i);
    const val = fromUri ? decodeURIComponent(fromUri[1]) : s;
    return val.replace(/\s+/g, "").replace(/-/g, "").toUpperCase();
}

function base32Decode(input: string): Buffer {
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
    let bits = "";
    for (const c of input) {
        const v = alphabet.indexOf(c);
        if (v < 0) continue;
        bits += v.toString(2).padStart(5, "0");
    }
    const bytes: number[] = [];
    for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2));
    return Buffer.from(bytes);
}

function cookieDeviceId(cookie: string): string {
    const m = String(cookie || "").match(/(?:^|;\s*)oai-did=([^;]+)/i);
    return m ? decodeURIComponent(m[1].trim()) : "";
}

function authHeaders(accessToken: string, accountId = "", cookie = ""): Record<string, string> {
    const did = cookieDeviceId(cookie);
    return {
        authorization: `Bearer ${accessToken}`,
        accept: "application/json",
        "content-type": "application/json",
        // 代理链路下 br/zstd 偶发不解压 → 以前报 enroll 无 secret 却 dump 一堆二进制
        "accept-encoding": "identity",
        origin: CHATGPT_BASE_URL,
        referer: `${CHATGPT_BASE_URL}/`,
        "user-agent": DEFAULT_USER_AGENT,
        "oai-language": "en-US",
        ...(accountId ? {"chatgpt-account-id": accountId} : {}),
        ...(did ? {"oai-device-id": did} : {}),
        ...(cookie ? {cookie} : {}),
    };
}

function summarizeBody(body: any, max = 160): string {
    if (body == null) return "";
    if (typeof body === "string") {
        if (isBinaryLooking(body)) return "[binary/compressed body]";
        if (/<!doctype html|<html|just a moment|cf-browser-verification|cloudflare/i.test(body)) return "[html/cf challenge]";
        return body.replace(/\s+/g, " ").slice(0, max);
    }
    if (body.raw != null) return summarizeBody(String(body.raw), max);
    if (body.detail || body.error || body.message) {
        return String(body.detail || body.error || body.message).slice(0, max);
    }
    try {
        const s = JSON.stringify(body);
        if (isBinaryLooking(s)) return "[binary/compressed body]";
        return s.slice(0, max);
    } catch {
        return String(body).slice(0, max);
    }
}

function isBinaryLooking(s: string): boolean {
    if (!s) return false;
    // 常见：未解压 br/gzip 正文被当 utf8 读，开头 ESC 等控制符 + 乱码
    let bad = 0;
    const n = Math.min(s.length, 80);
    for (let i = 0; i < n; i++) {
        const c = s.charCodeAt(i);
        if (c < 9 || (c > 13 && c < 32) || c === 0xfffd) bad++;
    }
    return bad >= 3 || /\\u00[0-1][0-9a-f]{2}/i.test(JSON.stringify(s).slice(0, 120));
}

function bodySaysReauth(body: any): boolean {
    const s = summarizeBody(body, 400);
    return /re-authenticate|reauthenticate|must re-auth|pwd_auth|重新验证|重新登录|password.*enroll/i.test(s)
        || /User must re-authenticate to enroll/i.test(JSON.stringify(body || {}));
}

function classifyHttpFailure(status: number, body: any, stage: string): string {
    if (status === 401) {
        if (bodySaysReauth(body)) return "需重新密码登录后再绑2FA(pwd_auth 过期)";
        return "AT 失效,无法绑 2FA";
    }
    if (status === 403) {
        const s = summarizeBody(body);
        if (bodySaysReauth(body)) return "需重新密码登录后再绑2FA(pwd_auth 过期)";
        if (/cf|cloudflare|just a moment|html/i.test(s)) return `${stage} 被 CF 拦截(403)，需代理或浏览器`;
        return `${stage} 403: ${s || "forbidden"}`;
    }
    if (status === 404) return `mfa 不可用(404)`;
    if (status === 429) return `${stage} 429 请求过频，稍后再试`;
    return `${stage} ${status}: ${summarizeBody(body)}`;
}

/** 是否因密码验证窗口过期而必须重新登录才能绑/解 MFA（对齐官网 ~240s）。 */
export function needsMfaEnrollReauth(accessToken: string, windowMs = MFA_PWD_AUTH_WINDOW_MS): boolean {
    try {
        const seg = String(accessToken || "").split(".")[1];
        if (!seg) return true;
        const b64 = seg.replace(/-/g, "+").replace(/_/g, "/");
        const jwt = JSON.parse(Buffer.from(b64, "base64").toString("utf8"));
        const t = jwt?.pwd_auth_time;
        if (t == null) return true;
        const ms = t < 1e12 ? t * 1000 : t;
        const age = Date.now() - ms;
        return age < 0 || age > windowMs;
    } catch {
        return true;
    }
}

function isRetryableReason(reason: string): boolean {
    return /fetch failed|ECONN|ETIMEDOUT|UND_ERR|socket|reset|timeout|aborted|CF 拦截|binary\/compressed|html\/cf|连接失败|proxy/i.test(reason || "");
}

function pickSecret(enrolled: any): string {
    if (!enrolled || typeof enrolled !== "object") return "";
    const direct = enrolled.secret || enrolled.totp_secret || enrolled.shared_secret || enrolled.otp_secret
        || enrolled.totpSecret || enrolled.sharedSecret || "";
    if (direct) return String(direct);
    for (const k of ["data", "factor", "enrollment", "result", "payload"]) {
        const nested = enrolled[k];
        if (nested && typeof nested === "object") {
            const s = nested.secret || nested.totp_secret || nested.shared_secret || nested.otp_secret || "";
            if (s) return String(s);
        }
    }
    // otpauth://totp/...?secret=XXX
    const blob = JSON.stringify(enrolled);
    const m = blob.match(/[?&]secret=([A-Z2-7]{16,})/i) || blob.match(/"secret"\s*:\s*"([A-Z2-7]{16,})"/i);
    return m ? m[1] : "";
}

function pickSessionId(enrolled: any): string {
    if (!enrolled || typeof enrolled !== "object") return "";
    const direct = enrolled.session_id || enrolled.sessionId || enrolled.enrollment_session_id || "";
    if (direct) return String(direct);
    for (const k of ["data", "factor", "enrollment", "result", "payload"]) {
        const nested = enrolled[k];
        if (nested && typeof nested === "object") {
            const s = nested.session_id || nested.sessionId || "";
            if (s) return String(s);
        }
    }
    return "";
}

async function readResponse(res: Response): Promise<{json: any; text: string; binary: boolean}> {
    const buf = Buffer.from(await res.arrayBuffer());
    // 正文里大量 0 控制字节 → 多半是压缩体没解开
    let ctrl = 0;
    for (let i = 0; i < Math.min(buf.length, 64); i++) {
        const b = buf[i];
        if (b < 9 || (b > 13 && b < 32)) ctrl++;
    }
    const binary = ctrl >= 3;
    const text = binary ? "" : buf.toString("utf8");
    if (binary) return {json: {raw: "[binary/compressed body]"}, text: "", binary: true};
    try {
        return {json: text ? JSON.parse(text) : {}, text, binary: false};
    } catch {
        return {json: {raw: text.slice(0, 200)}, text, binary: false};
    }
}

async function fetchMfa(
    url: string,
    init: {method: string; headers: Record<string, string>; body?: string},
    proxyUrl: string,
    timeoutMs = 20000,
): Promise<{ok: boolean; status: number; json: any; binary: boolean; error?: string}> {
    const dispatcher = buildProxyDispatcher(proxyForUndici(proxyUrl));
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
        const res = await fetch(url, {
            method: init.method,
            headers: init.headers,
            body: init.body,
            dispatcher,
            signal: ctrl.signal,
        } as any);
        const {json, binary} = await readResponse(res);
        return {ok: res.ok, status: res.status, json, binary};
    } catch (e: any) {
        const msg = String(e?.message || e);
        const cf = /ECONNRESET|reset|fetch failed|socket|UND_ERR|aborted|timeout/i.test(msg);
        return {
            ok: false,
            status: 0,
            json: {},
            binary: false,
            error: cf ? `连接失败(需代理过 CF 或浏览器): ${msg.slice(0, 100)}` : msg.slice(0, 120),
        };
    } finally {
        clearTimeout(t);
    }
}

async function enrollTotpOnce(
    accessToken: string,
    {accountId = "", proxyUrl = "", cookie = ""} = {},
): Promise<EnrollTotpResult> {
    const headers = authHeaders(accessToken, accountId, cookie);

    const info = await fetchMfa(INFO_URL, {method: "GET", headers}, proxyUrl);
    if (info.error) return {ok: false, reason: info.error};
    if (info.binary) return {ok: false, reason: "mfa_info 返回压缩/二进制体(代理解压异常)"};
    if (info.ok && (info.json?.mfa_enabled_v2 || info.json?.mfa_enabled)) {
        return {ok: true, already: true};
    }
    if (info.status === 401) {
        const reason = classifyHttpFailure(info.status, info.json, "mfa_info");
        return {ok: false, reason, needReauth: bodySaysReauth(info.json) || /AT 失效/.test(reason)};
    }
    if (info.status === 403 || info.status === 404) {
        return {ok: false, reason: classifyHttpFailure(info.status, info.json, "mfa_info")};
    }
    // mfa_info 非 2xx 仍尝试 enroll（有的号 info 弱权限但 enroll 可过）

    const enroll = await fetchMfa(
        ENROLL_URL,
        {method: "POST", headers, body: JSON.stringify({factor_type: "totp"})},
        proxyUrl,
    );
    if (enroll.error) return {ok: false, reason: enroll.error};
    if (enroll.binary) return {ok: false, reason: "enroll 返回压缩/二进制体(代理解压异常，试换代理或浏览器)"};
    if (!enroll.ok) {
        const reason = classifyHttpFailure(enroll.status, enroll.json, "enroll");
        return {
            ok: false,
            reason,
            needReauth: bodySaysReauth(enroll.json) || /需重新密码登录/.test(reason),
        };
    }

    const secret = pickSecret(enroll.json);
    const sessionId = pickSessionId(enroll.json);
    if (!secret || !sessionId) {
        return {ok: false, reason: `enroll 无 secret/session_id: ${summarizeBody(enroll.json)}`};
    }

    await waitTotpSafeWindow(6);
    let lastAct = {ok: false, status: 0, json: {} as any, error: "" as string | undefined};
    for (let round = 0; round < 2; round++) {
        if (round) await waitNextTotpWindow();
        for (const code of generateTotpCandidates(secret)) {
            const act = await fetchMfa(
                ACTIVATE_URL,
                {
                    method: "POST",
                    headers,
                    body: JSON.stringify({factor_type: "totp", session_id: sessionId, code}),
                },
                proxyUrl,
            );
            lastAct = {ok: act.ok, status: act.status, json: act.json, error: act.error};
            if (act.error) break;
            if (act.ok) return {ok: true, secret: normalizeTotpSecret(secret), via: "http"};
            // 错误码明显是码错再试下一窗；其它错误直接停
            if (act.status === 401) return {ok: false, reason: "AT 失效,无法绑 2FA"};
            if (act.status === 429) return {ok: false, reason: "activate 429 请求过频"};
            if (act.status && act.status !== 400 && act.status !== 422) {
                return {ok: false, reason: classifyHttpFailure(act.status, act.json, "activate")};
            }
        }
    }
    if (lastAct.error) return {ok: false, reason: lastAct.error};
    return {ok: false, reason: classifyHttpFailure(lastAct.status, lastAct.json, "activate")};
}

function resolveChromePath(): string {
    const candidates = [
        process.env.CHATGPT_TOKEN_BROWSER_PATH,
        process.env.SENTINEL_BROWSER_PATH,
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
        "/Applications/Chromium.app/Contents/MacOS/Chromium",
        "/usr/bin/google-chrome",
        "/usr/bin/chromium",
        "/usr/bin/chromium-browser",
        "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
        "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
        "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
        "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    ].filter(Boolean) as string[];
    return candidates.find((c) => existsSync(c)) || "";
}

function parseProxyForPlaywright(rawProxy: string): {server: string; username?: string; password?: string} | undefined {
    if (!rawProxy) return undefined;
    try {
        const u = new URL(rawProxy);
        // Playwright 原生支持 socks5://，勿改成 http
        const cfg: {server: string; username?: string; password?: string} = {
            server: `${u.protocol}//${u.host}`,
        };
        if (u.username) cfg.username = decodeURIComponent(u.username);
        if (u.password) cfg.password = decodeURIComponent(u.password);
        return cfg;
    } catch {
        return {server: rawProxy};
    }
}

/** undici ProxyAgent 只吃 HTTP CONNECT；socks5 本地口常另有 http 同端口或需浏览器降级。 */
function proxyForUndici(proxyUrl: string): string {
    const raw = String(proxyUrl || "").trim();
    if (!raw) return "";
    try {
        const u = new URL(raw);
        if (u.protocol.startsWith("socks")) {
            // 本机 xray/mihomo 常见：socks 与 mixed/http 同端口或 10808→http
            if (u.hostname === "127.0.0.1" || u.hostname === "localhost") {
                return `http://${u.host}`;
            }
        }
        return raw;
    } catch {
        return raw;
    }
}

/** 真 Chrome 经 Playwright request 打 backend-api（TLS 指纹过 CF；Cookie 头可直接带）。 */
export async function enrollTotpViaBrowser(
    accessToken: string,
    {accountId = "", proxyUrl = "", cookie = "", headless = true, log = (_m: string) => {}}: EnrollTotpOpts = {},
): Promise<EnrollTotpResult> {
    if (!accessToken) return {ok: false, reason: "无 access_token"};
    const exe = resolveChromePath();
    if (!exe) return {ok: false, reason: "无 Chrome/Edge 可做浏览器绑 2FA"};

    let chromium: any;
    try {
        ({chromium} = await import("playwright-core"));
    } catch (e: any) {
        return {ok: false, reason: `playwright-core 不可用: ${String(e?.message || e).slice(0, 80)}`};
    }

    log("2FA 走真浏览器请求 backend-api…");
    const browser = await chromium.launch({
        headless: headless !== false,
        executablePath: exe,
        proxy: parseProxyForPlaywright(proxyUrl || ""),
        args: ["--disable-blink-features=AutomationControlled"],
    });
    try {
        const context = await browser.newContext({
            userAgent: DEFAULT_USER_AGENT,
            locale: "en-US",
            extraHTTPHeaders: {
                "oai-language": "en-US",
                origin: CHATGPT_BASE_URL,
                referer: `${CHATGPT_BASE_URL}/`,
                ...(accountId ? {"chatgpt-account-id": accountId} : {}),
            },
        });

        const apiHeaders = (extra: Record<string, string> = {}) => ({
            authorization: `Bearer ${accessToken}`,
            accept: "application/json",
            "content-type": "application/json",
            origin: CHATGPT_BASE_URL,
            referer: `${CHATGPT_BASE_URL}/`,
            "oai-language": "en-US",
            ...(accountId ? {"chatgpt-account-id": accountId} : {}),
            ...(cookie ? {cookie} : {}),
            ...extra,
        });

        // 先 GET 首页，让 Chrome 建好对 chatgpt.com 的连接/CF 通道
        await context.request.get(`${CHATGPT_BASE_URL}/`, {timeout: 45000}).catch(() => {});

        const infoRes = await context.request.get(INFO_URL, {headers: apiHeaders(), timeout: 30000});
        const infoText = await infoRes.text();
        let infoJson: any = {};
        try { infoJson = infoText ? JSON.parse(infoText) : {}; } catch { infoJson = {raw: infoText.slice(0, 120)}; }
        if (infoRes.ok() && (infoJson?.mfa_enabled_v2 || infoJson?.mfa_enabled)) {
            return {ok: true, already: true, via: "browser"};
        }
        if (infoRes.status() === 401) return {ok: false, reason: "AT 失效,无法绑 2FA", via: "browser"};

        const enrollRes = await context.request.post(ENROLL_URL, {
            headers: apiHeaders(),
            data: {factor_type: "totp"},
            timeout: 30000,
        });
        const enrollText = await enrollRes.text();
        let enrolled: any = {};
        try { enrolled = enrollText ? JSON.parse(enrollText) : {}; } catch { enrolled = {raw: enrollText.slice(0, 120)}; }
        if (!enrollRes.ok()) {
            return {ok: false, reason: classifyHttpFailure(enrollRes.status(), enrolled, "enroll"), via: "browser"};
        }
        const secret = pickSecret(enrolled);
        const sessionId = pickSessionId(enrolled);
        if (!secret || !sessionId) {
            return {ok: false, reason: `enroll 无 secret/session_id: ${summarizeBody(enrolled)}`, via: "browser"};
        }

        await waitTotpSafeWindow(6);
        let last = {ok: false, status: 0, body: ""};
        for (let round = 0; round < 2; round++) {
            if (round) await waitNextTotpWindow();
            for (const code of generateTotpCandidates(secret)) {
                const actRes = await context.request.post(ACTIVATE_URL, {
                    headers: apiHeaders(),
                    data: {factor_type: "totp", session_id: sessionId, code},
                    timeout: 30000,
                });
                const actText = await actRes.text();
                last = {ok: actRes.ok(), status: actRes.status(), body: actText.slice(0, 160)};
                if (actRes.ok()) {
                    return {ok: true, secret: normalizeTotpSecret(secret), via: "browser"};
                }
            }
        }
        return {ok: false, reason: `activate ${last.status}: ${last.body || "失败"}`, via: "browser"};
    } catch (e: any) {
        return {ok: false, reason: `浏览器绑 2FA 异常: ${String(e?.message || e).slice(0, 120)}`, via: "browser"};
    } finally {
        await browser.close().catch(() => {});
    }
}

/**
 * 绑定 ChatGPT TOTP。
 * 顺序：检查 pwd_auth → 代理 HTTP → 直连 HTTP → 可选 reauth 回调 → 真 Chrome。
 * 官网要求 enroll 前密码验证窗口约 4 分钟（pwd_auth_time）。
 */
export async function enrollTotp(
    accessToken: string,
    opts: EnrollTotpOpts = {},
): Promise<EnrollTotpResult> {
    if (!accessToken) return {ok: false, reason: "无 access_token"};
    const {
        accountId = "",
        proxyUrl = "",
        cookie = "",
        retryAltProxy = true,
        browserFallback = true,
        headless = true,
        log = () => {},
        reauth,
    } = opts;

    let token = accessToken;
    let aid = accountId;
    let ck = cookie;

    const runHttp = async (label: string): Promise<EnrollTotpResult> => {
        const attempts: Array<{proxy: string; label: string}> = [];
        if (proxyUrl) attempts.push({proxy: proxyUrl, label: `${label}/代理`});
        if (!proxyUrl || retryAltProxy) attempts.push({proxy: "", label: `${label}/直连`});
        const seen = new Set<string>();
        const uniq = attempts.filter((a) => {
            const k = a.proxy || "__direct__";
            if (seen.has(k)) return false;
            seen.add(k);
            return true;
        });
        let last: EnrollTotpResult = {ok: false, reason: "未尝试"};
        for (const a of uniq) {
            log(`2FA HTTP(${a.label})…`);
            last = await enrollTotpOnce(token, {accountId: aid, proxyUrl: a.proxy, cookie: ck});
            last.via = last.via || "http";
            if (last.ok) return last;
            if (last.needReauth) return last;
            if (/AT 失效|不可用\(404\)|无 access_token/i.test(last.reason || "")) return last;
            log(`2FA HTTP(${a.label})失败: ${last.reason || ""}`);
        }
        return last;
    };

    // 窗口已过：先 reauth 再 enroll，避免空打 enroll 401
    if (needsMfaEnrollReauth(token) && reauth) {
        log("pwd_auth 已过期，先重新密码登录…");
        try {
            const fresh = await reauth();
            if (fresh?.accessToken) {
                token = fresh.accessToken;
                if (fresh.accountId) aid = fresh.accountId;
                if (fresh.cookie != null) ck = fresh.cookie;
                log("重新登录完成，继续绑 2FA…");
            } else {
                return {ok: false, reason: "需重新密码登录后再绑2FA(重登未拿到 AT)", needReauth: true};
            }
        } catch (e: any) {
            return {ok: false, reason: `重登失败: ${String(e?.message || e).slice(0, 120)}`, needReauth: true};
        }
    } else if (needsMfaEnrollReauth(token) && !reauth) {
        // 仍尝试一次（刚注册可能时钟边界）；失败再标 needReauth
        log("pwd_auth 可能过期，仍尝试 enroll…");
    }

    let last = await runHttp("初试");
    if (last.ok) return last;

    if (last.needReauth && reauth) {
        log("enroll 要求重新验证密码，执行 reauth…");
        try {
            const fresh = await reauth();
            if (!fresh?.accessToken) {
                return {ok: false, reason: "需重新密码登录后再绑2FA(重登未拿到 AT)", needReauth: true};
            }
            token = fresh.accessToken;
            if (fresh.accountId) aid = fresh.accountId;
            if (fresh.cookie != null) ck = fresh.cookie;
            last = await runHttp("重登后");
            if (last.ok) return last;
        } catch (e: any) {
            return {ok: false, reason: `重登失败: ${String(e?.message || e).slice(0, 120)}`, needReauth: true};
        }
    }

    if (last.needReauth) {
        return {ok: false, reason: last.reason || "需重新密码登录后再绑2FA", needReauth: true};
    }

    // 浏览器也绕不过「必须密码 reauth」的 401，仅网络类再降级
    const skipBrowser = /AT 失效|无 access_token|mfa 不可用\(404\)|需重新密码登录/i.test(last.reason || "");
    if (browserFallback && !skipBrowser) {
        const viaBrowser = await enrollTotpViaBrowser(token, {
            accountId: aid, proxyUrl, cookie: ck, headless, log,
        });
        if (viaBrowser.ok) return viaBrowser;
        if (viaBrowser.needReauth || bodySaysReauth(viaBrowser.reason)) {
            return {ok: false, reason: viaBrowser.reason || "需重新密码登录后再绑2FA", needReauth: true, via: "browser"};
        }
        return {
            ok: false,
            reason: `HTTP:${last.reason || "失败"} | 浏览器:${viaBrowser.reason || "失败"}`.slice(0, 200),
            via: "browser",
        };
    }
    return last;
}
