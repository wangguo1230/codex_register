// @ts-nocheck
// 批量测 token：at(access_token 走 chatgpt.com/backend-api) / rt(refresh_token 走 auth.openai.com 刷新)。
// 独立模块，不依赖 check-auth-quota.ts(那是 CLI)。undici ProxyAgent 支持科学上网代理过 Cloudflare。
import {ProxyAgent} from "undici";
import {DEFAULT_USER_AGENT, CHATGPT_BASE_URL, DEFAULT_CLIENT_ID, AUTH_OAUTH_TOKEN_URLS} from "./constants.js";
import {createProtocolDispatcher} from "./mail/protocol-dispatcher.js";

/**
 * :3100 里禁止用 undici ProxyAgent 吃 socks5。
 * Node 24 的实验 SOCKS 会把流读进主进程，几十秒堆到几十 GB，页面全超时。
 * 本机 10808 是 v2rayN HTTP，也不能当 socks5 喂进去。
 */
export function buildProxyDispatcher(proxyUrl) {
    const raw = String(proxyUrl || "").trim();
    if (!raw) return undefined;
    try {
        const cleaned = raw.replace(/#.*$/, "");
        const u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(cleaned) ? cleaned : `socks5://${cleaned}`);
        const local = u.hostname === "127.0.0.1" || u.hostname === "localhost";
        if (local && String(u.port || "") === "10808") {
            return new ProxyAgent({uri: "http://127.0.0.1:10808"});
        }
        if (u.protocol === "http:" || u.protocol === "https:") {
            return new ProxyAgent({uri: cleaned});
        }
        if (u.protocol.startsWith("socks")) {
            return createProtocolDispatcher(cleaned);
        }
    } catch { /* */ }
    return undefined;
}

function fetchWithTimeout(url, opts, ms = 12000) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), ms);
    return fetch(url, {...opts, signal: ctrl.signal}).finally(() => clearTimeout(t));
}

/** 解 JWT payload(best-effort)，用于从刷新后的 access_token 提 account_id/email/exp */
export function decodeJwt(token) {
    try {
        const seg = String(token || "").split(".")[1];
        if (!seg) return null;
        const b64 = seg.replace(/-/g, "+").replace(/_/g, "/");
        const json = Buffer.from(b64, "base64").toString("utf8");
        return JSON.parse(json);
    } catch { return null; }
}

/**
 * 测 at：用 access_token 调 usage 接口判断有效性。
 *   200 → 有效；401 → 失效(被封/过期)；其它 → 错误(可能是 CF 拦截需代理)。
 * dispatcher 传注册代理(科学上网)以过 chatgpt.com 的 Cloudflare TLS 指纹拦截。
 */
export async function probeAt(accessToken, accountId, dispatcher, timeoutMs = 12000) {
    if (!accessToken) return {ok: false, status: 0, reason: "无 access_token"};
    try {
        const res = await fetchWithTimeout(`${CHATGPT_BASE_URL}/backend-api/wham/usage`, {
            method: "GET",
            headers: {
                authorization: `Bearer ${accessToken}`,
                accept: "application/json",
                "user-agent": DEFAULT_USER_AGENT,
                origin: CHATGPT_BASE_URL,
                referer: `${CHATGPT_BASE_URL}/`,
                ...(accountId ? {"chatgpt-account-id": accountId} : {}),
            },
            dispatcher,
        }, timeoutMs);
        const status = res.status;
        if (status === 200) return {ok: true, status, reason: "有效"};
        if (status === 401) return {ok: false, status, reason: "失效(401 未授权)"};
        if (status === 403) return {ok: false, status, reason: "被拒(403，可能 CF 拦截，检查代理)"};
        const body = (await res.text().catch(() => "")).slice(0, 120);
        return {ok: false, status, reason: `HTTP ${status} ${body}`};
    } catch (e) {
        const msg = String(e?.message ?? e);
        // ECONNRESET 基本是 chatgpt.com 的 CF 拦 Node TLS 指纹 → 需科学上网代理
        const cf = /ECONNRESET|reset|fetch failed|socket/i.test(msg);
        return {ok: false, status: 0, reason: cf ? `连接失败(需科学上网代理过 CF): ${msg}` : msg};
    }
}

function inferPlanType(raw) {
    const s = String(raw || "").toLowerCase();
    if (s.includes("enterprise")) return "enterprise";
    if (s.includes("team")) return "team";
    if (s.includes("pro")) return "pro";
    if (s.includes("plus")) return "plus";
    if (s.includes("free")) return "free";
    return "";
}

export async function probePlan(accessToken, accountId, dispatcher, timeoutMs = 12000, refreshToken?) {
    if (!accessToken && !refreshToken) return {ok: false, plan_type: "", error: "无 access_token"};

    let at = accessToken;
    if (!at) return {ok: false, plan_type: "", error: "无可用 access_token"};

    if (!accountId) {
        const jwt = decodeJwt(at) || {};
        const authInfo = jwt["https://api.openai.com/auth"] || {};
        accountId = authInfo.chatgpt_account_id || "";
    }

    const headers = {
        authorization: `Bearer ${at}`,
        accept: "application/json",
        "user-agent": DEFAULT_USER_AGENT,
        origin: CHATGPT_BASE_URL,
        referer: `${CHATGPT_BASE_URL}/`,
        "oai-language": "zh-CN",
        ...(accountId ? {"chatgpt-account-id": accountId} : {}),
    };

    // 主：/backend-api/subscriptions（/me 对 CDK 充值后的 pro 不可靠）
    try {
        const url = `${CHATGPT_BASE_URL}/backend-api/subscriptions` + (accountId ? `?account_id=${accountId}` : "");
        const res = await fetchWithTimeout(url, {method: "GET", headers, dispatcher}, timeoutMs);
        if (res.status === 200) {
            const data = await res.json();
            const planType = inferPlanType(data.plan_type || "") || "free";
            const hasSub = !!(data.has_active_subscription);
            return {ok: true, plan_type: planType, has_active_subscription: hasSub, _debug: {endpoint: "subscriptions", raw: data.plan_type}};
        }
        if (res.status === 401) return {ok: false, plan_type: "", error: "AT 失效(401)"};
    } catch {}

    // 备：/backend-api/accounts/check/v4-2023-04-27
    try {
        const res = await fetchWithTimeout(`${CHATGPT_BASE_URL}/backend-api/accounts/check/v4-2023-04-27`, {method: "GET", headers, dispatcher}, timeoutMs);
        if (res.status === 200) {
            const data = await res.json();
            const accounts = data.accounts || {};
            for (const key of Object.keys(accounts)) {
                const acc = accounts[key];
                if (!acc || typeof acc !== "object") continue;
                const accPlan = inferPlanType(acc.account?.plan_type || "");
                const hasSub = !!(acc.entitlement?.has_active_subscription);
                if (accPlan) return {ok: true, plan_type: accPlan, has_active_subscription: hasSub, _debug: {endpoint: "accounts/check", raw: acc.account?.plan_type}};
            }
        }
    } catch {}

    return {ok: false, plan_type: "", error: "两个接口均未返回有效套餐"};
}

/**
 * 测 rt：用 refresh_token 走 OAuth token 端点刷新。成功=rt 有效，返回新 token。
 * 走 auth.openai.com，不被 CF 拦，不需特殊代理(dispatcher 可选)。
 * 返回 {ok, status, reason, tokens?} —— tokens 含新的 access_token/refresh_token/id_token(用于续期写回)。
 */
export async function refreshRt(refreshToken, dispatcher, timeoutMs = 15000) {
    if (!refreshToken) return {ok: false, status: 0, reason: "无 refresh_token"};
    const body = new URLSearchParams({
        grant_type: "refresh_token",
        client_id: DEFAULT_CLIENT_ID,
        refresh_token: refreshToken,
    });
    let lastErr = "";
    for (const endpoint of AUTH_OAUTH_TOKEN_URLS) {
        try {
            const res = await fetchWithTimeout(endpoint, {
                method: "POST",
                headers: {
                    accept: "application/json",
                    "content-type": "application/x-www-form-urlencoded",
                    "user-agent": DEFAULT_USER_AGENT,
                },
                body,
                dispatcher,
            }, timeoutMs);
            const text = await res.text().catch(() => "");
            if (res.status === 200) {
                let json = {};
                try { json = JSON.parse(text); } catch { /* ignore */ }
                if (json.access_token) {
                    const claims = decodeJwt(json.access_token) || {};
                    const auth = claims["https://api.openai.com/auth"] || {};
                    return {
                        ok: true, status: 200, reason: "有效(已刷新)",
                        tokens: {
                            access_token: json.access_token,
                            refresh_token: json.refresh_token || refreshToken, // 有些平台不轮换 rt
                            id_token: json.id_token || "",
                            account_id: auth.chatgpt_account_id || "",
                            expires_in: json.expires_in || 0,
                        },
                    };
                }
                lastErr = "200 但无 access_token";
                continue;
            }
            // 401/400 = rt 失效；其它端点可能不对，试下一个
            if (res.status === 400 || res.status === 401) {
                return {ok: false, status: res.status, reason: `rt 失效(HTTP ${res.status}) ${text.slice(0, 100)}`};
            }
            lastErr = `HTTP ${res.status} ${text.slice(0, 80)}`;
        } catch (e) {
            lastErr = String(e?.message ?? e);
        }
    }
    return {ok: false, status: 0, reason: lastErr || "刷新失败"};
}
