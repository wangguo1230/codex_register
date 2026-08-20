// @ts-nocheck
// 换绑认证准备：保证 session/pwd_auth 新鲜，并在官方要求时完成 2FA 和再次重登。

function formatSessionLeft(leftMs) {
    const minutes = Math.max(0, Math.round(Number(leftMs || 0) / 60_000));
    if (minutes < 2) return "不到 2 分钟";
    if (minutes < 60) return `${minutes} 分钟`;
    const hours = Math.round(minutes / 60);
    if (hours < 48) return `${hours} 小时`;
    return `${Math.round(hours / 24)} 天`;
}

export function createGmailRebindAuthService({
    getAccount,
    updateAccount,
    getAuthData,
    extractTokens,
    isSessionAlive,
    needsFreshLogin,
    pwdAuthLeftMs,
    needsPwdReauth,
    isGoogleMailbox,
    rememberGoogleCredentials,
    rememberMailcomPassword,
    relogin,
    reloginIdleMs,
    enrollTotp,
    rechargeProxy,
    browserFallback,
    log = () => {},
} = {}) {
    const cancelled = (operation) => operation?.signal?.aborted;
    const cancelledResult = () => ({ok: false, cancelled: true, reason: "已取消换绑"});

    async function prepare(account, fallbackAuthData, operation = {}) {
        if (cancelled(operation)) return cancelledResult();
        let fresh = account;
        const authData = getAuthData(fresh) || fallbackAuthData;
        let token = extractTokens(authData);
        let accessToken = token?.accessToken || "";
        const session = isSessionAlive(authData);
        const pwdTight = !!(accessToken && needsFreshLogin(accessToken));
        if (!accessToken || !session.ok || pwdTight) {
            const reason = !accessToken
                ? "无 session JSON"
                : !session.ok
                    ? "session JSON 已过期"
                    : `pwd_auth 仅剩 ${Math.round(pwdAuthLeftMs(accessToken) / 1000)}s，不够跑完换绑`;
            log(`换绑 ${account.email}: ${reason}，先重登再换绑`);
            if (isGoogleMailbox(fresh)) {
                rememberGoogleCredentials({
                    email: fresh.email,
                    password: fresh.password,
                    totpSecret: fresh.mailbox_totp || fresh.totp_secret || "",
                    recoveryEmail: fresh.recovery_email || "",
                    imapPassword: fresh.mailbox_imap || fresh.imap_password || "",
                });
            } else {
                rememberMailcomPassword(account.email, account.password);
            }
            const result = await relogin(fresh, {
                preferPool: true,
                timeoutMs: reloginIdleMs(fresh),
                allowBrowser: false,
                skipMfa: true,
                onChild: operation.onChild,
                onProgress: (message) => log(`换绑 ${account.email}: 重登 ${String(message || "").slice(0, 160)}`),
            });
            if (cancelled(operation)) return cancelledResult();
            if (!result.ok) return {ok: false, reason: `重登失败: ${String(result.reason || "").slice(0, 120)}`};
            fresh = await getAccount(account.id) || fresh;
            token = extractTokens(getAuthData(fresh));
            accessToken = token?.accessToken || "";
            if (!accessToken) return {ok: false, reason: "重登后仍无 access_token"};
        } else {
            const left = session.leftMs > 0 ? formatSessionLeft(session.leftMs) : "";
            log(`换绑 ${account.email}: 复用新鲜 session JSON${left ? `（约 ${left} 后过期）` : ""}`);
        }
        return {ok: true, fresh, token, accessToken};
    }

    async function reauthenticate(account, context, operation = {}) {
        if (cancelled(operation)) return cancelledResult();
        let {fresh, token, accessToken} = context;
        if (!(fresh.totp_secret || "").trim() && accessToken && !needsPwdReauth(accessToken)) {
            log(`换绑 ${account.email}: 无 GPT 2FA，先用现有 AT 绑验证器（避开 mail.com 收码）`);
            const mfa = await enrollTotp(accessToken, {
                accountId: token?.accountId || "",
                proxyUrl: rechargeProxy(),
                cookie: String(getAuthData(fresh)?.cookie || getAuthData(account)?.cookie || "").trim(),
                retryAltProxy: true,
                browserFallback: browserFallback(),
                log: (message) => log(`换绑 ${account.email}: ${message}`),
                reauth: async () => {
                    if (cancelled(operation)) throw new Error("已取消换绑");
                    log(`换绑 ${account.email}: 绑 2FA 需重登刷新 pwd_auth`);
                    const result = await relogin(fresh, {
                        preferPool: true,
                        allowBrowser: false,
                        skipMfa: true,
                        onChild: operation.onChild,
                        onProgress: (message) => log(`换绑 ${account.email}: 重登 ${String(message || "").slice(0, 120)}`),
                    });
                    if (!result?.ok) throw new Error(result?.reason || "重登失败");
                    fresh = await getAccount(account.id) || fresh;
                    const nextToken = extractTokens(getAuthData(fresh));
                    if (!nextToken?.accessToken) throw new Error("重登后无 AT");
                    return {
                        accessToken: nextToken.accessToken,
                        accountId: nextToken.accountId || "",
                        cookie: String(getAuthData(fresh)?.cookie || "").trim(),
                    };
                },
            });
            if (cancelled(operation)) return cancelledResult();
            if (mfa.ok && mfa.secret) {
                await updateAccount(account.id, {totp_secret: mfa.secret, mfa_status: "✅已绑"});
                fresh = {...fresh, totp_secret: mfa.secret};
                log(`换绑 ${account.email}: GPT 2FA 已绑(${mfa.via || "http"})，重登走验证器`);
            } else {
                log(`换绑 ${account.email}: 绑 2FA 未成(${mfa.already ? "已有2FA缺密钥" : (mfa.reason || "失败")})，重登仍可能卡 mail.com`);
            }
        }

        log(`换绑 ${account.email}: 换绑接口要重新验证密码（已存 session 不够新），开始协议登录`);
        rememberMailcomPassword(account.email, account.password);
        const result = await relogin(fresh, {
            preferPool: true,
            timeoutMs: reloginIdleMs(fresh),
            allowBrowser: false,
            skipMfa: true,
            onChild: operation.onChild,
            onProgress: (message) => log(`换绑 ${account.email}: 重登 ${String(message || "").slice(0, 160)}`),
        });
        if (cancelled(operation)) return cancelledResult();
        if (!result.ok) return {ok: false, reason: `重登失败: ${String(result.reason || "").slice(0, 120)}`};
        fresh = await getAccount(account.id) || fresh;
        token = extractTokens(getAuthData(fresh));
        accessToken = token?.accessToken || "";
        if (!accessToken) return {ok: false, reason: "重登后仍无 access_token"};
        return {ok: true, fresh, token, accessToken};
    }

    return {prepare, reauthenticate};
}
