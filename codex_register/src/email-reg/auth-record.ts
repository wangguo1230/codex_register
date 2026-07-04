/**
 * 纯邮箱注册产出的 auth 文件记录构造。
 *
 * 输出结构（写到 codex_register/auth/at/<date>-<email>.json）：
 * {
 *   email, session, mailbox, cookie, last_refresh, type
 * }
 * 其中 session 就是 /api/auth/session 的完整原始响应
 * （WARNING_BANNER / user / account / accessToken / sessionToken / rumViewTags ...）。
 *
 * session 优先用刚抓到的原始 payload（accessToken 对得上时）；否则（重登录 fallback
 * 路径，本 client 没自己抓过 session）用 JWT claims 兜底重建一个最小 session 对象，
 * 保证格式一致。
 */
import type {MailboxCredential} from "./mailbox-credential.js";

/** /api/auth/session 的原始响应（只声明会用到的字段，其余原样保留）。 */
export interface SessionPayload {
    accessToken?: string;
    [key: string]: unknown;
}

/** access_token JWT 里 `https://api.openai.com/auth` 命名空间下的 claims。 */
export interface AuthAccessClaims {
    chatgpt_account_id?: string;
    chatgpt_user_id?: string;
    chatgpt_plan_type?: string;
    user_id?: string;
}

interface AccessTokenClaims {
    exp?: number;
    "https://api.openai.com/auth"?: AuthAccessClaims;
}

export interface AuthRecord {
    email: string;
    session: SessionPayload | Record<string, unknown>;
    mailbox: MailboxCredential | null;
    cookie: string;
    last_refresh: string;
    type: "chatgpt";
}

function b64urlDecode(segment: string): string {
    const padded = segment.replace(/-/g, "+").replace(/_/g, "/");
    return Buffer.from(padded, "base64").toString("utf8");
}

/** 解 JWT payload；解不出返回空对象（不抛）。 */
export function decodeJwtPayload<T = Record<string, unknown>>(token: string): T {
    const parts = (token ?? "").split(".");
    if (parts.length < 2) {
        return {} as T;
    }
    try {
        return JSON.parse(b64urlDecode(parts[1])) as T;
    } catch {
        return {} as T;
    }
}

export interface BuildAuthRecordInput {
    accessToken: string;
    email: string;
    /** 最近一次 /api/auth/session 的完整响应；没有就传 null，走 JWT 兜底。 */
    session: SessionPayload | null;
    mailbox: MailboxCredential | null;
    cookie: string;
}

export function buildAuthRecord(input: BuildAuthRecordInput): AuthRecord {
    const {accessToken, email, session, mailbox, cookie} = input;
    const claims = decodeJwtPayload<AccessTokenClaims>(accessToken);
    const authClaims = claims["https://api.openai.com/auth"] ?? {};
    const expiresAt = claims.exp ? new Date(claims.exp * 1000).toISOString() : "";

    const resolvedSession: SessionPayload | Record<string, unknown> =
        session && session.accessToken === accessToken
            ? session
            : {
                  user: {
                      id: authClaims.chatgpt_user_id ?? authClaims.user_id ?? "",
                      email,
                  },
                  expires: expiresAt,
                  account: {
                      id: authClaims.chatgpt_account_id ?? "",
                      planType: authClaims.chatgpt_plan_type ?? "",
                  },
                  accessToken,
                  authProvider: "openai",
              };

    return {
        email,
        session: resolvedSession,
        mailbox,
        cookie,
        last_refresh: new Date().toISOString(),
        type: "chatgpt",
    };
}
