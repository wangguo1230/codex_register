// ChatGPT 登录邮箱换绑：走官方 backend-api change_email / add_email。
// 账单页 /payments/checkout/update_email 不是登录邮箱，不要用。
import {CHATGPT_BASE_URL, DEFAULT_USER_AGENT} from "./constants.js";
import {buildProxyDispatcher, decodeJwt} from "./token-check.js";
import {rememberGoogleCred, waitGoogleImapOtp} from "./mail/google-account.js";

const ELIGIBILITY_URL = `${CHATGPT_BASE_URL}/backend-api/accounts/change_email/eligibility`;
const BEGIN_URL = `${CHATGPT_BASE_URL}/backend-api/accounts/change_email/begin`;
const VERIFY_URL = `${CHATGPT_BASE_URL}/backend-api/accounts/change_email/verify`;
const ADD_BEGIN_URL = `${CHATGPT_BASE_URL}/backend-api/accounts/add_email/begin`;
const ADD_VERIFY_URL = `${CHATGPT_BASE_URL}/backend-api/accounts/add_email/verify`;
const PWD_AUTH_WINDOW_MS = 270_000;

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
    try { return text ? JSON.parse(text) : {}; } catch { return {raw: text.slice(0, 240)}; }
}

function errText(body: any, fallback = ""): string {
    if (!body) return fallback;
    if (typeof body === "string") return body.slice(0, 200);
    return String(body.detail || body.message || body.error || body.raw || fallback || JSON.stringify(body)).slice(0, 200);
}

export function needsPwdReauth(accessToken: string, windowMs = PWD_AUTH_WINDOW_MS): boolean {
    const jwt = decodeJwt(accessToken);
    if (!jwt) return true;
    const t = jwt.pwd_auth_time;
    if (t == null) return true;
    const ms = t < 1e12 ? t * 1000 : t;
    const age = Date.now() - ms;
    return age < 0 || age > windowMs;
}

export async function getChangeEmailEligibility(accessToken: string, {accountId = "", proxyUrl = ""} = {}) {
    const dispatcher = buildProxyDispatcher(proxyUrl);
    const res = await fetch(ELIGIBILITY_URL, {
        method: "GET", headers: authHeaders(accessToken, accountId), dispatcher,
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

export async function changeChatgptEmail({
    accessToken,
    accountId = "",
    proxyUrl = "",
    newEmail,
    imapPassword,
    mailPassword = "",
    totpSecret = "",
    socialUser = false,
    useAddEmail = false,
}: {
    accessToken: string;
    accountId?: string;
    proxyUrl?: string;
    newEmail: string;
    imapPassword: string;
    mailPassword?: string;
    totpSecret?: string;
    socialUser?: boolean;
    useAddEmail?: boolean;
}): Promise<{ok: boolean; reason?: string; needReauth?: boolean; alreadyLinked?: boolean; badTarget?: boolean; rateLimited?: boolean; code?: string}> {
    const email = String(newEmail || "").trim().toLowerCase();
    if (!accessToken) return {ok: false, reason: "无 access_token"};
    if (!email.includes("@")) return {ok: false, reason: "新邮箱无效"};
    const isGmail = /@(gmail|googlemail)\.com$/i.test(email);
    if (isGmail && !imapPassword) return {ok: false, reason: "目标 Gmail 无 IMAP 应用专用密码"};
    if (!isGmail && !mailPassword && !imapPassword) return {ok: false, reason: "目标邮箱无密码"};

    const dispatcher = buildProxyDispatcher(proxyUrl);
    const headers = authHeaders(accessToken, accountId);
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
            };
        }
    }

    let social = socialUser;
    try {
        const elig = await getChangeEmailEligibility(accessToken, {accountId, proxyUrl});
        if (elig.needReauth) return {ok: false, needReauth: true, reason: elig.reason};
        if (elig.ok) {
            if (elig.socialUser) social = true;
            if (!elig.eligible && !useAddEmail) {
                return {ok: false, reason: `不可换绑(${elig.eligibilityType})`};
            }
        } else if (elig.status !== 404) {
            return {ok: false, needReauth: elig.status === 401, reason: elig.reason};
        }
    } catch (e: any) {
        return {ok: false, reason: `eligibility: ${String(e?.message || e).slice(0, 160)}`};
    }

    const beginUrl = useAddEmail ? ADD_BEGIN_URL : BEGIN_URL;
    const verifyUrl = useAddEmail ? ADD_VERIFY_URL : VERIFY_URL;
    const beginBody: any = {email};
    if (social && !useAddEmail) beginBody.remove_social_subs = true;

    const sentAt = Date.now();
    let beginRes: Response;
    try {
        beginRes = await fetch(beginUrl, {
            method: "POST", headers, dispatcher, body: JSON.stringify(beginBody),
        } as any);
    } catch (e: any) {
        return {ok: false, reason: `begin: ${String(e?.message || e).slice(0, 160)}`};
    }
    const beginJson = await readJson(beginRes);
    if (beginRes.status === 401) return {ok: false, needReauth: true, reason: "begin 401，需重新登录"};
    if (beginRes.status === 429) return {ok: false, rateLimited: true, reason: "begin 429: 换绑太勤，官方限流"};
    if (!beginRes.ok) {
        const why = errText(beginJson);
        const alreadyLinked = /already linked|already (in )?use|associated with another|已绑定|已被占用/i.test(why);
        return {ok: false, alreadyLinked, reason: `begin ${beginRes.status}: ${why}`};
    }

    let code = "";
    try {
        if (isGmail) {
            code = await waitGoogleImapOtp(cred, {minTimestampMs: sentAt, attempts: 10, intervalMs: 4000});
        } else {
            const {createMailcomProvider, rememberMailcomPassword} = await import("./mail/mailcom.js");
            rememberMailcomPassword(email, mailPassword || imapPassword);
            code = await createMailcomProvider().getEmailVerificationCode(email, {minTimestampMs: sentAt});
        }
    } catch (e: any) {
        const why = String(e?.message || e).slice(0, 200);
        const badTarget = /账密无效|账号已停用|登录被拒|找不到密码|邮箱池中找不到/i.test(why);
        return {ok: false, badTarget, reason: why};
    }
    if (!code) return {ok: false, reason: `未拿到换绑验证码: ${email}`};

    const verifyBody: any = {email, code};
    if (social && !useAddEmail) verifyBody.remove_social_subs = true;
    let verifyRes: Response;
    try {
        verifyRes = await fetch(verifyUrl, {
            method: "POST", headers, dispatcher, body: JSON.stringify(verifyBody),
        } as any);
    } catch (e: any) {
        return {ok: false, reason: `verify: ${String(e?.message || e).slice(0, 160)}`};
    }
    const verifyJson = await readJson(verifyRes);
    if (verifyRes.status === 401) return {ok: false, needReauth: true, reason: "verify 401，需重新登录"};
    if (!verifyRes.ok) return {ok: false, reason: `verify ${verifyRes.status}: ${errText(verifyJson)}`};
    return {ok: true, code};
}
