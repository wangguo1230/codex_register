// @ts-nocheck
// 按 AT -> RT -> 原邮箱重登的顺序读取官方当前登录邮箱。

export function createCurrentLoginEmailResolver({
    pickProxy,
    getAuthData,
    getRtData,
    extractTokens,
    fetchCurrentLoginEmail,
    refreshRt,
    relogin,
    getAccount,
    log = () => {},
} = {}) {
    return async function currentLoginEmailOf(account) {
        const proxyUrl = await pickProxy();
        if (!proxyUrl) return {ok: false, email: "", reason: "对账需要本机 10808（chatgpt.com HTTP）"};

        const authData = getAuthData(account);
        const cookie = String(authData?.cookie || "").trim();
        const read = (accessToken, accountId) => fetchCurrentLoginEmail(accessToken, {
            accountId: accountId || "",
            proxyUrl,
            cookie,
        });

        const token = extractTokens(authData);
        if (token?.accessToken) {
            const result = await read(token.accessToken, token.accountId);
            if (result.ok || !result.needReauth) return result;
            log(`对账 ${account.email}: AT 已失效，改用 RT 换新 AT`);
        }

        const refreshToken = extractTokens(getRtData(account) || authData);
        if (refreshToken?.refreshToken) {
            const refreshed = await refreshRt(account, refreshToken.refreshToken,
                (message) => log(`对账 ${account.email}: ${message}`));
            const accessToken = refreshed?.ok ? (refreshed.tokens?.access_token || "") : "";
            if (accessToken) {
                const result = await read(accessToken, refreshed.tokens?.account_id || refreshToken.accountId);
                if (result.ok || !result.needReauth) return result;
            } else {
                log(`对账 ${account.email}: RT 刷新失败(${String(refreshed?.reason || "").slice(0, 80)})`);
            }
        }

        log(`对账 ${account.email}: AT/RT 都不可用，尝试用原邮箱协议重登`);
        const reloginResult = await relogin(account, {
            preferPool: true,
            allowBrowser: false,
            skipMfa: true,
            onProgress: (message) => log(`对账 ${account.email}: 重登 ${String(message || "").slice(0, 120)}`),
        });
        if (!reloginResult?.ok) {
            return {
                ok: false,
                email: "",
                reason: `无法读官方邮箱（AT/RT 失效，原邮箱重登也失败: ${String(reloginResult?.reason || "").slice(0, 80)}）——换绑可能已生效，请人工确认`,
            };
        }

        const fresh = await getAccount(account.id) || account;
        const freshToken = extractTokens(getAuthData(fresh));
        if (!freshToken?.accessToken) return {ok: false, email: "", reason: "重登后仍无 AT"};
        return read(freshToken.accessToken, freshToken.accountId);
    };
}
