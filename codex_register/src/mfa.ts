// ChatGPT TOTP:绑定走 backend-api(需网页 AT + 注册代理过 CF);算码 RFC 6238。
import {createHmac} from "node:crypto";
import {CHATGPT_BASE_URL, DEFAULT_USER_AGENT} from "./constants.js";
import {buildProxyDispatcher} from "./token-check.js";

const ENROLL_URL = `${CHATGPT_BASE_URL}/backend-api/accounts/mfa/enroll`;
const ACTIVATE_URL = `${CHATGPT_BASE_URL}/backend-api/accounts/mfa/user/activate_enrollment`;
const INFO_URL = `${CHATGPT_BASE_URL}/backend-api/accounts/mfa_info`;

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

function authHeaders(accessToken: string, accountId?: string): Record<string, string> {
    return {
        authorization: `Bearer ${accessToken}`,
        accept: "application/json",
        "content-type": "application/json",
        origin: CHATGPT_BASE_URL,
        referer: `${CHATGPT_BASE_URL}/`,
        "user-agent": DEFAULT_USER_AGENT,
        ...(accountId ? {"chatgpt-account-id": accountId} : {}),
    };
}

async function readJson(res: Response): Promise<any> {
    const text = await res.text();
    try { return text ? JSON.parse(text) : {}; } catch { return {raw: text.slice(0, 200)}; }
}

export async function enrollTotp(accessToken: string, {accountId = "", proxyUrl = ""} = {}): Promise<{ok: boolean; already?: boolean; secret?: string; reason?: string}> {
    if (!accessToken) return {ok: false, reason: "无 access_token"};
    const dispatcher = buildProxyDispatcher(proxyUrl);
    const headers = authHeaders(accessToken, accountId);
    try {
        const infoRes = await fetch(INFO_URL, {method: "GET", headers, dispatcher} as any);
        const info = await readJson(infoRes);
        if (infoRes.ok && (info.mfa_enabled_v2 || info.mfa_enabled)) {
            return {ok: true, already: true};
        }
        if (infoRes.status === 401) return {ok: false, reason: "AT 失效,无法绑 2FA"};
        if (infoRes.status === 403 || infoRes.status === 404) return {ok: false, reason: `mfa 不可用(${infoRes.status})`};

        const enrollRes = await fetch(ENROLL_URL, {
            method: "POST", headers, dispatcher, body: JSON.stringify({factor_type: "totp"}),
        } as any);
        const enrolled = await readJson(enrollRes);
        if (!enrollRes.ok) return {ok: false, reason: `enroll ${enrollRes.status}: ${JSON.stringify(enrolled).slice(0, 160)}`};
        const secret = enrolled.secret || enrolled.totp_secret || enrolled.shared_secret || enrolled.otp_secret || "";
        const sessionId = enrolled.session_id || enrolled.sessionId || "";
        if (!secret || !sessionId) return {ok: false, reason: `enroll 无 secret/session_id: ${JSON.stringify(enrolled).slice(0, 160)}`};

        const tryActivate = async (code: string) => {
            const actRes = await fetch(ACTIVATE_URL, {
                method: "POST", headers, dispatcher,
                body: JSON.stringify({factor_type: "totp", session_id: sessionId, code}),
            } as any);
            return {ok: actRes.ok, body: await readJson(actRes), status: actRes.status};
        };
        let act = {ok: false, body: {}, status: 0};
        for (const code of generateTotpCandidates(secret)) {
            act = await tryActivate(code);
            if (act.ok) break;
        }
        if (!act.ok) return {ok: false, reason: `activate ${act.status}: ${JSON.stringify(act.body).slice(0, 160)}`};
        return {ok: true, secret: normalizeTotpSecret(secret)};
    } catch (e: any) {
        return {ok: false, reason: String(e?.message || e).slice(0, 160)};
    }
}
