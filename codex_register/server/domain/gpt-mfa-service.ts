// @ts-nocheck
// GPT MFA 应用服务：串行绑定 TOTP，并在 pwd_auth 过期时委托重登刷新会话。

export function createGptMfaService({store, enrollTotp, relogin, readAuth, extractTokens, decodeJwt, getProxy, effects} = {}) {
    async function processAccount(account) {
        let live = account;
        let auth = readAuth(live);
        let tokens = extractTokens(auth);
        if (!tokens?.accessToken) {
            effects.log(account.id, "[2fa] 无 AT,跳过(请先重登或测 at)");
            await store.update(account.id, {mfa_status: "❌无AT"});
            return;
        }
        effects.log(account.id, "[2fa] 绑定 TOTP…");
        const result = await enrollTotp(tokens.accessToken, {
            accountId: tokens.accountId
                || decodeJwt(tokens.accessToken)?.["https://api.openai.com/auth"]?.chatgpt_account_id
                || "",
            proxyUrl: getProxy(),
            cookie: String(auth?.cookie || "").trim(),
            retryAltProxy: true,
            browserFallback: process.env.MFA_NO_BROWSER !== "1",
            headless: true,
            log: (message) => effects.log(account.id, `[2fa] ${message}`),
            reauth: async () => {
                effects.log(account.id, "[2fa] 需重新密码登录以刷新 pwd_auth…");
                const login = await relogin(live, {
                    allowBrowser: true,
                    skipMfa: true,
                    onProgress: (message) => effects.log(account.id, `[2fa] 重登 ${String(message || "").slice(0, 120)}`),
                });
                if (!login?.ok) throw new Error(login?.reason || "重登失败");
                live = await store.get(account.id) || live;
                auth = readAuth(live);
                tokens = extractTokens(auth);
                if (!tokens?.accessToken) throw new Error("重登后仍无 AT");
                return {
                    accessToken: tokens.accessToken,
                    accountId: tokens.accountId || "",
                    cookie: String(auth?.cookie || "").trim(),
                };
            },
        });
        if (result.ok && result.secret) {
            await store.update(account.id, {totp_secret: result.secret, mfa_status: "✅已绑"});
            effects.log(account.id, `[2fa] ✅ 已绑定(${result.via || "http"})`);
        } else if (result.ok && result.already) {
            if (account.totp_secret || live.totp_secret) {
                await store.update(account.id, {mfa_status: "✅已绑"});
                effects.log(account.id, "[2fa] 该号已有 2FA");
            } else {
                await store.update(account.id, {mfa_status: "⚠已有2FA缺密钥"});
                effects.log(account.id, "[2fa] 已有 2FA 但库中无 secret,需人工处理");
            }
        } else {
            await store.update(account.id, {mfa_status: `❌${result.reason || "失败"}`});
            effects.log(account.id, `[2fa] ❌ ${result.reason || "失败"}`);
        }
        effects.broadcast("status", {id: account.id, ...await store.get(account.id)});
    }

    async function start(ids) {
        const accounts = (await Promise.all(ids.map((id) => store.get(id)))).filter(Boolean);
        if (!accounts.length) return {error: "未选择账号", status: 400};
        void (async () => {
            for (const account of accounts) {
                try {
                    await processAccount(account);
                } catch (error) {
                    await store.update(account.id, {mfa_status: `❌${String(error?.message || error).slice(0, 80)}`}).catch(() => {});
                    effects.log(account.id, `[2fa] ❌ ${String(error?.message || error).slice(0, 120)}`);
                }
            }
            effects.broadcast("snapshot", await store.list());
        })().catch((error) => effects.warn("[2fa] 批量绑定异常:", error?.message || error));
        return {ok: true, count: accounts.length};
    }

    return {start, processAccount};
}
