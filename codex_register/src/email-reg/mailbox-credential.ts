/**
 * 邮箱「接码凭据」类型与格式化辅助。
 *
 * 接码凭据 = 能重新登录邮箱 / 读收件箱取验证码的那条记录。hotmail 池里一行
 * `loginHint----password----clientId----refreshToken` 就是它。注册用的邮箱常常是
 * 底层账号的别名，真正能接码的是底层账号这条 line。
 *
 * 这里只放「纯数据 + 纯函数」，不依赖任何 provider 内部实现，方便被 mailbox 分发层、
 * hotmail provider、以及 auth 记录构造逻辑共用。
 */

export interface MailboxCredential {
    provider: string;
    email: string;
    login: string;
    password: string;
    client_id: string;
    refresh_token: string;
    /** `login----password----client_id----refresh_token`，可直接喂回卡密池/接码工具。 */
    line: string;
}

/** 把四段拼成 `----` 分隔的卡密行（与 hotmail/tokens.txt 一致）。 */
export function formatCredentialLine(
    login: string,
    password: string,
    clientId: string,
    refreshToken: string,
): string {
    return [login, password ?? "", clientId ?? "", refreshToken ?? ""].join("----");
}

/** 由底层账号字段构造一份完整 MailboxCredential（hotmail 用）。 */
export function buildHotmailCredential(
    email: string,
    account: {loginHint: string; password?: string; clientId?: string; refreshToken?: string},
): MailboxCredential {
    const password = account.password ?? "";
    const clientId = account.clientId ?? "";
    const refreshToken = account.refreshToken ?? "";
    return {
        provider: "hotmail",
        email,
        login: account.loginHint,
        password,
        client_id: clientId,
        refresh_token: refreshToken,
        line: formatCredentialLine(account.loginHint, password, clientId, refreshToken),
    };
}
