// @ts-nocheck

export function createTokenCredentials({readJson, decodeJwt} = {}) {
    function extract(data) {
        if (!data) return null;
        const session = data.session || {};
        const accessToken = session.accessToken || data.access_token || "";
        const refreshToken = data.refresh_token || "";
        let accountId = data.account_id || "";
        if (!accountId && accessToken) {
            const claims = decodeJwt(accessToken) || {};
            accountId = (claims["https://api.openai.com/auth"] || {}).chatgpt_account_id || "";
        }
        if (!accountId && session.account) {
            accountId = session.account.account_id || session.account.id || "";
        }
        return {accessToken, refreshToken, accountId, raw: data};
    }

    function readFile(file) {
        const data = readJson(file);
        const tokens = extract(data);
        return tokens ? {...tokens, path: file} : null;
    }

    return {extract, readFile};
}
