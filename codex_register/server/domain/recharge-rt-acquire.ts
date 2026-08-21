// @ts-nocheck
// 导出前 RT 获取编排：重登、RT 获取和并发控制不属于 HTTP 路由职责。
import {runBoundedPool} from "./async-pool.js";

export function createRechargeRtAcquireService({
    getAccount,
    getAccounts,
    getAuthData,
    getRtData,
    extractTokens,
    relogin,
    acquireRt,
    attachChild = () => {},
} = {}) {
    return async function acquireForExport(rows, {
        forceRelogin = false,
        concurrency = 1,
        isStopped = () => false,
        log = () => {},
    } = {}) {
        let ok = 0;
        let fail = 0;
        let done = 0;
        const total = rows.length;
        let accountsById = null;
        if (getAccounts && rows.length > 0 && rows.length <= 100) {
            try {
                const accounts = await getAccounts(rows.map((row) => row.account_id));
                accountsById = new Map(accounts.map((account) => [Number(account.id), account]));
            } catch (error) {
                log(`批量读取账号失败，回退逐条读取: ${String(error?.message || error).slice(0, 120)}`);
            }
        }

        await runBoundedPool(rows, async (row) => {
            if (isStopped()) return;
            const index = ++done;
            let account;
            try {
                account = accountsById
                    ? accountsById.get(Number(row.account_id))
                    : await getAccount(row.account_id);
            } catch (error) {
                fail++;
                log(`[${index}/${total}] ✗ ${row.email} 读取账号失败 ${String(error?.message || error).slice(0, 120)}`);
                return;
            }
            if (!account) {
                fail++;
                log(`[${index}/${total}] ✗ ${row.email} 账号不存在`);
                return;
            }

            if (forceRelogin) log(`[${index}/${total}] RT 优先：跳过前置重登，由 RT worker 一次登录并获取 RT ${row.email}`);
            // Legacy two-step mode is opt-in only; the normal RT export must log in once.
            if (forceRelogin && process.env.CODEX_LEGACY_RT_PRERELOGIN === "1") {
                log(`[${index}/${total}] 重登 ${row.email}…`);
                try {
                    const result = await relogin(account, {
                        allowBrowser: true,
                        preferPool: true,
                        onProgress: (message) => log(`  ${row.email}: ${String(message || "").slice(0, 120)}`),
                        onChild: attachChild,
                    });
                    if (!result?.ok) {
                        fail++;
                        log(`[${index}/${total}] ✗ ${row.email} 重登失败 ${String(result?.reason || "").slice(0, 120)}`);
                        return;
                    }
                    account = await getAccount(row.account_id) || account;
                    if (isStopped()) return;
                    log(`[${index}/${total}] 重登成功，取 RT: ${row.email}`);
                } catch (error) {
                    fail++;
                    log(`[${index}/${total}] ✗ ${row.email} 重登异常 ${error?.message || error}`);
                    return;
                }
            } else if (!forceRelogin) {
                const existing = extractTokens(getRtData(account) || getAuthData(account));
                if (existing?.refreshToken) {
                    ok++;
                    log(`[${index}/${total}] ✓ ${row.email} 已有 RT，跳过获取`);
                    return;
                }
                log(`[${index}/${total}] 获取 RT: ${row.email}...`);
            }

            try {
                const result = await acquireRt(account, {
                    acquire: true,
                    forceAcquire: forceRelogin,
                    onProgress: (message) => log(`  ${row.email}: ${String(message || "").slice(0, 120)}`),
                    onChild: attachChild,
                });
                if (result.ok) {
                    ok++;
                    log(`[${index}/${total}] ✓ ${row.email}${result.plan_type ? " · " + result.plan_type : ""}`);
                } else {
                    fail++;
                    log(`[${index}/${total}] ✗ ${row.email} ${result.reason || "失败"}`);
                }
            } catch (error) {
                fail++;
                log(`[${index}/${total}] ✗ ${row.email} ${error?.message || error}`);
            }
        }, Math.max(1, Number(concurrency) || 1));

        return {ok, fail, total};
    };
}
