// ChatGPT 登录邮箱换绑：走官方 backend-api change_email / add_email。
// 账单页 /payments/checkout/update_email 不是登录邮箱，不要用。
import {CHATGPT_BASE_URL, CHATGPT_OAI_CLIENT_VERSION, DEFAULT_USER_AGENT} from "./constants.js";
import {decodeJwt} from "./token-check.js";
import {defaultDeviceProfile, getDeviceClientHints} from "./device-profile.js";
import {createProtocolDispatcher} from "./mail/protocol-dispatcher.js";
import {rememberGoogleCred, waitGoogleImapOtp} from "./mail/google-account.js";

const ELIGIBILITY_URL = `${CHATGPT_BASE_URL}/backend-api/accounts/change_email/eligibility`;
const BEGIN_URL = `${CHATGPT_BASE_URL}/backend-api/accounts/change_email/begin`;
const VERIFY_URL = `${CHATGPT_BASE_URL}/backend-api/accounts/change_email/verify`;
const ADD_BEGIN_URL = `${CHATGPT_BASE_URL}/backend-api/accounts/add_email/begin`;
const ADD_VERIFY_URL = `${CHATGPT_BASE_URL}/backend-api/accounts/add_email/verify`;
const ME_URL = `${CHATGPT_BASE_URL}/backend-api/me`;
const PWD_AUTH_WINDOW_MS = 270_000;
/**
 * begin 一发就计入官方 24h 换绑上限，而 verify 必须落在 pwd_auth 窗口内。
 * 所以 begin 之前不能只问"过期了没"，要问"剩下的额度够不够跑完取码 + verify"。
 * 额度不够就先重登：否则这次 begin 必然换来 verify 401，配额白烧一次，
 * 上层再重登重试又是一次 begin —— 这正是把号推到 24h 上限的那个循环。
 */
export const REBIND_OTP_MIN_BUDGET_MS = Math.max(30_000, Number(process.env.REBIND_OTP_MIN_BUDGET_MS || 90_000));
/** 取码拿到码之后还要发 verify，给它留出的余量。 */
const VERIFY_RESERVE_MS = 20_000;
/**
 * 取码的绝对上限。刻意【不】按 pwd_auth 剩余额度来切：动态代理很慢，收码经常
 * 要等好几分钟，而 begin 早就烧掉了，此时提前放弃没有任何好处——拿到码去试
 * verify 哪怕窗口已过也只是多一个请求，成功了就是白赚。所以这里放宽到能等，
 * 窗口过期改成在 verify 之后据实分流（见 pwdWindowExpired）。
 * 上限要留在父进程 CHANGE_EMAIL_TIMEOUT_MS(480s) 之内：预检 ~60s + 本值 + verify ~20s。
 */
const OTP_MAX_WAIT_MS = Math.max(60_000, Number(process.env.REBIND_OTP_MAX_WAIT_MS || 300_000));

/**
 * 换绑阶段。父进程据此判断官方侧状态是否确定：
 * verify 之前失败 = 官方一定没改；verify 已发出但没拿到应答 = 不确定，必须对账。
 */
export type ChangeEmailStage = "precheck" | "eligibility" | "begin" | "otp" | "verify" | "done";

function cookieDeviceId(cookie: string): string {
    const m = String(cookie || "").match(/(?:^|;\s*)oai-did=([^;]+)/i);
    return m ? decodeURIComponent(m[1].trim()) : "";
}

function cookieAccountId(cookie: string): string {
    const m = String(cookie || "").match(/(?:^|;\s*)_account=([^;]+)/i);
    return m ? decodeURIComponent(m[1].trim()) : "";
}

/** 对齐官网 HAR：Bearer + oai-* + CF/session cookie + Client Hints。 */
function authHeaders(accessToken: string, accountId?: string, cookie = ""): Record<string, string> {
    const hints = getDeviceClientHints(defaultDeviceProfile());
    const did = cookieDeviceId(cookie);
    const accId = String(accountId || cookieAccountId(cookie) || "").trim();
    return {
        authorization: `Bearer ${accessToken}`,
        accept: "*/*",
        "content-type": "application/json",
        "accept-encoding": "identity",
        origin: CHATGPT_BASE_URL,
        referer: `${CHATGPT_BASE_URL}/`,
        "user-agent": DEFAULT_USER_AGENT,
        "accept-language": "zh-CN,zh;q=0.9,en;q=0.8,en-GB;q=0.7,en-US;q=0.6",
        "oai-language": "zh-CN",
        "oai-client-version": CHATGPT_OAI_CLIENT_VERSION,
        "sec-ch-ua": hints.secChUa,
        "sec-ch-ua-mobile": hints.secChUaMobile,
        "sec-ch-ua-platform": hints.secChUaPlatform,
        "sec-fetch-dest": "empty",
        "sec-fetch-mode": "cors",
        "sec-fetch-site": "same-origin",
        ...(accId ? {"chatgpt-account-id": accId} : {}),
        ...(did ? {"oai-device-id": did} : {}),
        ...(cookie ? {cookie} : {}),
    };
}

async function readJson(res: Response): Promise<any> {
    const text = await res.text();
    try { return text ? JSON.parse(text) : {}; } catch { return {raw: text.slice(0, 240)}; }
}

function fetchErr(e: any): string {
    const parts = [e?.message, e?.cause?.message, e?.cause?.code].filter(Boolean).map(String);
    return [...new Set(parts)].join(" / ").slice(0, 200) || "fetch failed";
}

function errText(body: any, fallback = ""): string {
    if (!body) return fallback;
    if (typeof body === "string") return body.slice(0, 200);
    const pick = body.detail ?? body.message ?? body.error ?? body.raw;
    if (typeof pick === "string") return pick.slice(0, 200);
    if (pick && typeof pick === "object") {
        const s = pick.message || pick.detail || pick.code || "";
        if (s) return String(s).slice(0, 200);
        try { return JSON.stringify(pick).slice(0, 200); } catch { /* */ }
    }
    try { return JSON.stringify(body).slice(0, 200); } catch { return fallback; }
}

/** pwd_auth 窗口还剩多少毫秒。拿不到 pwd_auth_time 一律当 0（要重登）。 */
export function pwdAuthLeftMs(accessToken: string, windowMs = PWD_AUTH_WINDOW_MS): number {
    const jwt = decodeJwt(accessToken);
    if (!jwt) return 0;
    const t = jwt.pwd_auth_time;
    if (t == null) return 0;
    const ms = t < 1e12 ? t * 1000 : t;
    const age = Date.now() - ms;
    if (age < 0) return 0;
    return Math.max(0, windowMs - age);
}

export function needsPwdReauth(accessToken: string, windowMs = PWD_AUTH_WINDOW_MS): boolean {
    return pwdAuthLeftMs(accessToken, windowMs) <= 0;
}

/** 子进程里目标邮箱预检（mail.com 要开 Playwright）可能吃掉的时间。 */
const REBIND_PRECHECK_ALLOWANCE_MS = 60_000;

/**
 * 上层 spawn 换绑子进程之前用的新鲜度判断：额度必须够跑完
 * 目标邮箱预检 → begin → 取码 → verify。
 * 一个还剩 1 秒的 AT 能过 needsPwdReauth，但拿它去 begin 是纯浪费 24h 配额，
 * 所以宁可多重登一次，也不要烧掉一个换绑名额。
 */
export function rebindNeedsFreshLogin(accessToken: string): boolean {
    if (!accessToken) return true;
    return pwdAuthLeftMs(accessToken)
        < REBIND_OTP_MIN_BUDGET_MS + VERIFY_RESERVE_MS + REBIND_PRECHECK_ALLOWANCE_MS;
}

/** 从库里的 auth_data / session JSON 取出 accessToken。 */
export function accessTokenFromAuth(authData: any): string {
    if (!authData || typeof authData !== "object") return "";
    const s = authData.session && typeof authData.session === "object" ? authData.session : {};
    return String(s.accessToken || authData.access_token || "").trim();
}

/**
 * session JSON 还能不能用：只看 AT 和 JWT exp / session.expires。
 * 不管 pwd_auth_time（换绑敏感接口要新密码验证时，先拿旧 session 打官方，401 再重登）。
 */
export function isSessionJsonAlive(authData: any, {now = Date.now(), skewMs = 60_000} = {}) {
    const accessToken = accessTokenFromAuth(authData);
    if (!accessToken) return {ok: false, accessToken: "", expMs: 0, leftMs: 0};
    const jwt = decodeJwt(accessToken);
    const jwtExp = Number(jwt?.exp || 0);
    const jwtMs = jwtExp > 0 ? (jwtExp < 1e12 ? jwtExp * 1000 : jwtExp) : 0;
    const s = authData.session && typeof authData.session === "object" ? authData.session : authData;
    const sessExp = Date.parse(String(s?.expires || authData?.expires || ""));
    const expMs = jwtMs || (Number.isFinite(sessExp) && sessExp > 0 ? sessExp : 0);
    if (!expMs) return {ok: true, accessToken, expMs: 0, leftMs: 0};
    const leftMs = expMs - now;
    return {ok: leftMs > skewMs, accessToken, expMs, leftMs};
}

export async function getChangeEmailEligibility(accessToken: string, {accountId = "", proxyUrl = "", cookie = ""} = {}) {
    const dispatcher = createProtocolDispatcher(proxyUrl);
    const res = await fetch(ELIGIBILITY_URL, {
        method: "GET", headers: authHeaders(accessToken, accountId, cookie), dispatcher,
    } as any);
    const body = await readJson(res);
    if (res.status === 401) return {ok: false, status: 401, needReauth: true, reason: "AT 失效(401)", body};
    if (!res.ok) return {ok: false, status: res.status, reason: errText(body, `eligibility ${res.status}`), body};
    const type = String(body.eligibility_type || (body.eligible === true ? "eligible" : "ineligible"));
    return {
        ok: true,
        status: res.status,
        eligible: body.eligible === true,
        eligibilityType: type,
        socialUser: type === "social" || type === "social_password",
        body,
    };
}

/**
 * 读官方当前登录邮箱，用于换绑对账（我们不确定 verify 到底成没成时的唯一真相来源）。
 * 返回 email 为空且 ok=true 时表示接口通了但没给邮箱，调用方不要据此下结论。
 */
export async function fetchCurrentLoginEmail(accessToken: string, {accountId = "", proxyUrl = "", cookie = ""} = {}): Promise<{
    ok: boolean; email: string; status: number; needReauth?: boolean; reason?: string;
}> {
    if (!accessToken) return {ok: false, email: "", status: 0, reason: "无 access_token"};
    const dispatcher = createProtocolDispatcher(proxyUrl);
    try {
        const res = await fetch(ME_URL, {
            method: "GET", headers: authHeaders(accessToken, accountId, cookie), dispatcher,
        } as any);
        const body = await readJson(res);
        if (res.status === 401) {
            const revoked = /token_revoked/i.test(errText(body));
            return {
                ok: false, email: "", status: 401, needReauth: true,
                reason: revoked ? "AT 已吊销(token_revoked，换绑成功后官网会这样)" : "AT 失效(401)",
            };
        }
        if (!res.ok) return {ok: false, email: "", status: res.status, reason: errText(body, `me ${res.status}`)};
        const email = String(body?.email || body?.user?.email || "").trim().toLowerCase();
        return {ok: true, email, status: res.status};
    } catch (e: any) {
        return {ok: false, email: "", status: 0, reason: `me: ${fetchErr(e)}`};
    }
}

export async function changeChatgptEmail({
    accessToken,
    accountId = "",
    cookie = "",
    proxyUrl = "",
    imapProxyUrl = "",
    newEmail,
    imapPassword,
    mailPassword = "",
    totpSecret = "",
    socialUser = false,
    useAddEmail = false,
    onStage,
}: {
    accessToken: string;
    accountId?: string;
    cookie?: string;
    proxyUrl?: string;
    imapProxyUrl?: string;
    newEmail: string;
    imapPassword: string;
    mailPassword?: string;
    totpSecret?: string;
    socialUser?: boolean;
    useAddEmail?: boolean;
    onStage?: (stage: ChangeEmailStage) => void;
}): Promise<{ok: boolean; reason?: string; needReauth?: boolean; alreadyLinked?: boolean; badTarget?: boolean; rateLimited?: boolean; capped24h?: boolean; pwdWindowExpired?: boolean; indeterminate?: boolean; code?: string; stage: ChangeEmailStage}> {
    let stage: ChangeEmailStage = "precheck";
    const enter = (s: ChangeEmailStage) => {
        stage = s;
        try { onStage?.(s); } catch { /* 上报失败不影响换绑 */ }
    };
    enter("precheck");
    const email = String(newEmail || "").trim().toLowerCase();
    if (!accessToken) return {ok: false, reason: "无 access_token", stage};
    if (!email.includes("@")) return {ok: false, reason: "新邮箱无效", stage};
    const isGmail = /@(gmail|googlemail)\.com$/i.test(email);
    if (isGmail && !imapPassword) return {ok: false, reason: "目标 Gmail 无 IMAP 应用专用密码", stage};
    if (!isGmail && !mailPassword && !imapPassword) return {ok: false, reason: "目标邮箱无密码", stage};

    const dispatcher = createProtocolDispatcher(proxyUrl);
    const headers = authHeaders(accessToken, accountId, cookie);
    const cred = rememberGoogleCred({
        email, password: mailPassword, totpSecret, imapPassword,
    });

    // 先确认目标邮箱能登，再打官方 begin。废号先 begin 会白白烧掉限流额度。
    if (!isGmail) {
        const {verifyMailcomLogin, rememberMailcomPassword} = await import("./mail/mailcom.js");
        rememberMailcomPassword(email, mailPassword || imapPassword);
        const pre = await verifyMailcomLogin(email, mailPassword || imapPassword);
        if (!pre.ok) {
            return {
                ok: false,
                badTarget: !!pre.wrongPassword,
                reason: pre.wrongPassword ? (pre.reason || "目标 mail.com 账密无效") : `目标邮箱预检失败: ${pre.reason || "未知"}`,
                stage,
            };
        }
    }

    let social = socialUser;
    enter("eligibility");
    try {
        const elig = await getChangeEmailEligibility(accessToken, {accountId, proxyUrl, cookie});
        if (elig.needReauth) return {ok: false, needReauth: true, reason: elig.reason, stage};
        if (elig.ok) {
            if (elig.socialUser) social = true;
            if (!elig.eligible && !useAddEmail) {
                return {ok: false, reason: `不可换绑(${elig.eligibilityType})`, stage};
            }
        } else if (elig.status === 429) {
            return {ok: false, rateLimited: true, reason: elig.reason || "eligibility 429", stage};
        } else if (elig.status !== 404) {
            return {ok: false, needReauth: elig.status === 401, reason: elig.reason, stage};
        }
    } catch (e: any) {
        return {ok: false, reason: `eligibility: ${fetchErr(e)}`, stage};
    }

    // begin 之前最后一道闸：额度不够跑完取码 + verify 就别发 begin。
    // 这里返回 needReauth，让上层先重登再进来，而不是白烧一次 24h 配额换一个必然的 verify 401。
    const leftMs = pwdAuthLeftMs(accessToken);
    if (leftMs < REBIND_OTP_MIN_BUDGET_MS + VERIFY_RESERVE_MS) {
        return {
            ok: false,
            needReauth: true,
            reason: `pwd_auth 仅剩 ${Math.round(leftMs / 1000)}s，不够取码+verify（需 ≥${Math.round((REBIND_OTP_MIN_BUDGET_MS + VERIFY_RESERVE_MS) / 1000)}s），先重登再 begin`,
            stage,
        };
    }
    // 取码只受绝对上限约束，不受 pwd_auth 剩余额度约束（慢代理要能等，理由见 OTP_MAX_WAIT_MS）
    const otpDeadlineMs = Date.now() + OTP_MAX_WAIT_MS;

    const beginUrl = useAddEmail ? ADD_BEGIN_URL : BEGIN_URL;
    const verifyUrl = useAddEmail ? ADD_VERIFY_URL : VERIFY_URL;
    const beginBody: any = {email};
    if (social && !useAddEmail) beginBody.remove_social_subs = true;

    const sentAt = Date.now();
    enter("begin");
    let beginRes: Response;
    try {
        beginRes = await fetch(beginUrl, {
            method: "POST", headers, dispatcher, body: JSON.stringify(beginBody),
        } as any);
    } catch (e: any) {
        return {ok: false, reason: `begin: ${String(e?.message || e).slice(0, 160)}`, stage};
    }
    const beginJson = await readJson(beginRes);
    if (beginRes.status === 401) return {ok: false, needReauth: true, reason: "begin 401，需重新登录", stage};
    if (beginRes.status === 429) return {ok: false, rateLimited: true, reason: "begin 429: 换绑太勤，官方限流", stage};
    if (!beginRes.ok) {
        const why = errText(beginJson);
        // 只认官方换绑文案。HTML/TLS 残片里的 in use、已被占用不能当废号。
        const alreadyLinked = /already linked|already associated with another|associated with another account|this email is already (in use|linked)/i.test(why);
        // 24h 换绑次数上限：限的是【这个 ChatGPT 号】，跟目标邮箱和出口都无关。
        // 换出口、换目标、重登一律没用，只能等，所以要单独标出来让上层冷却源账号。
        const capped24h = /changed your email too many times|too many times in the last 24 hours|email change limit/i.test(why);
        return {ok: false, alreadyLinked, capped24h, reason: `begin ${beginRes.status}: ${why}`, stage};
    }

    let code = "";
    enter("otp");
    try {
        if (isGmail) {
            code = await waitGoogleImapOtp(cred, {
                minTimestampMs: sentAt,
                attempts: 10,
                intervalMs: 4000,
                deadlineMs: otpDeadlineMs,
                proxy: imapProxyUrl,
                skipDirect: !!imapProxyUrl,
                includeLocals: !imapProxyUrl,
            });
        } else {
            const {createMailcomProvider, rememberMailcomPassword} = await import("./mail/mailcom.js");
            rememberMailcomPassword(email, mailPassword || imapPassword);
            code = await createMailcomProvider().getEmailVerificationCode(email, {
                minTimestampMs: sentAt, deadlineMs: otpDeadlineMs,
            });
        }
    } catch (e: any) {
        const why = String(e?.message || e).slice(0, 200);
        const badTarget = /账密无效|账号已停用|登录被拒|找不到密码|邮箱池中找不到/i.test(why);
        return {ok: false, badTarget, reason: why, stage};
    }
    if (!code) return {ok: false, reason: `未拿到换绑验证码: ${email}`, stage};

    const verifyBody: any = {email, code};
    if (social && !useAddEmail) verifyBody.remove_social_subs = true;
    // 取码可能已经把 270s 密码验证窗口耗光了。窗口过期也照样发 verify：
    // begin 反正已经烧了，试一次成本只是一个请求，成了就是白赚。
    const otpTookMs = Date.now() - sentAt;
    const pwdLeftAtVerify = pwdAuthLeftMs(accessToken);
    // 一旦进入 verify，官方侧可能已经改掉了邮箱。这之后的任何失联（超时/被杀/网络断）
    // 都必须当"状态不确定"处理，不能直接判失败把目标邮箱放回池。
    enter("verify");
    let verifyRes: Response;
    try {
        verifyRes = await fetch(verifyUrl, {
            method: "POST", headers, dispatcher, body: JSON.stringify(verifyBody),
        } as any);
    } catch (e: any) {
        return {
            ok: false,
            indeterminate: true,
            reason: `verify: ${String(e?.message || e).slice(0, 160)}`,
            stage,
        };
    }
    const verifyJson = await readJson(verifyRes);
    if (verifyRes.status === 401) {
        const why = errText(verifyJson);
        // 官网 HAR：verify 成功后旧 AT 立刻 token_revoked。verify 本身若回吊销，
        // 可能已经改完，不能当普通需重登失败，交给对账。
        if (/token_revoked/i.test(why)) {
            return {ok: false, indeterminate: true, reason: "verify 401 token_revoked（官网换绑后会吊销旧 AT）", stage};
        }
        // 取码把密码验证窗口拖过了：重登再来一轮会在同一个地方同样失败，
        // 只是再烧一次 24h 配额。标成 pwdWindowExpired 让上层直接停手并报清楚原因。
        if (pwdLeftAtVerify <= 0) {
            return {
                ok: false,
                pwdWindowExpired: true,
                reason: `verify 401：取码花了 ${Math.round(otpTookMs / 1000)}s，已超出官方约 270s 密码验证窗口（重试会同样失败，需要更快的收码通道）`,
                stage,
            };
        }
        return {ok: false, needReauth: true, reason: "verify 401，需重新登录", stage};
    }
    if (!verifyRes.ok) {
        const why = errText(verifyJson);
        const netty = /fetch failed|timeout|timed out|ECONN|ENOTFOUND|EPIPE|socket|TLS|disconnected|Proxy connection/i.test(why);
        return {ok: false, indeterminate: netty, reason: `verify ${verifyRes.status}: ${why}`, stage};
    }
    enter("done");
    return {ok: true, code, stage};
}
