// @ts-nocheck
// 独立邮箱验密服务：限流验证 mail.com 登录，可选改随机密码，不写业务数据库。
export function createMailCheckService({verifyLogin, changePassword, randomPassword, runPool, concurrency = 2} = {}) {
    async function check(items, {changePassword: shouldChange = false} = {}) {
        const results = new Array(items.length);
        await runPool(items.map((item, index) => ({item, index})), async ({item, index}) => {
            const email = String(item?.email || "").trim();
            const password = String(item?.password || "").trim();
            if (!email || !password) {
                results[index] = {email, ok: false, reason: "邮箱或密码为空"};
                return;
            }
            try {
                if (shouldChange) {
                    const nextPassword = randomPassword(20);
                    const result = await changePassword(email, password, nextPassword);
                    results[index] = result?.ok
                        ? {email, ok: true, changed: true, newPassword: nextPassword}
                        : {
                            email,
                            ok: false,
                            changed: false,
                            reason: result?.detail
                                ? `登录成功但改密失败: ${String(result.detail).slice(0, 60)}`
                                : "改密未成功",
                        };
                } else {
                    const result = await verifyLogin(email, password);
                    results[index] = {email, ok: result.ok, reason: result.reason};
                }
            } catch (error) {
                results[index] = {email, ok: false, reason: String(error?.message || error).slice(0, 120)};
            }
        }, concurrency);
        return {results, changePassword: shouldChange};
    }

    return {check};
}
