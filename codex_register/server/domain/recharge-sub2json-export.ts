// @ts-nocheck
// sub2json 导出编排：不依赖 Express，HTTP 层只负责请求/响应和任务互斥。
import {runBoundedPool} from "./async-pool.js";

function toSub2jsonAccount(email, tokens) {
    return {
        name: email,
        platform: "openai",
        type: "oauth",
        credentials: {
            access_token: tokens.access_token,
            refresh_token: tokens.refresh_token,
            ...(tokens.id_token ? {id_token: tokens.id_token} : {}),
            email,
        },
        concurrency: 1,
        priority: 0,
    };
}

/**
 * 将账号的 RT 获取、AT 刷新与 sub2json 结构组装集中在一个服务内。
 * 具体数据库/协议实现由组合根注入，避免服务反向依赖 HTTP 或全局单例。
 */
export function createSub2jsonExportService({
    getAccount,
    getAccounts,
    getRtData,
    extractTokens,
    testOneRt,
    refreshRtViaPool,
    attachChild = () => {},
} = {}) {
    async function ensureTokens(account, log) {
        const result = await testOneRt(account, {acquire: true, updateRt: true, onProgress: log, onChild: attachChild});
        if (result?.tokens?.access_token) {
            return {
                ok: true,
                tokens: {
                    access_token: result.tokens.access_token,
                    refresh_token: result.tokens.refresh_token || "",
                    id_token: result.tokens.id_token || "",
                },
            };
        }

        const live = await getAccount(account.id) || account;
        const record = getRtData(live) || {};
        const stored = extractTokens(record);
        const refreshToken = String(result?.refresh_token || stored?.refreshToken || "").trim();
        if (!refreshToken) return {ok: false, reason: result?.reason || "无rt"};

        const refreshed = await refreshRtViaPool(live, refreshToken, log);
        if (!refreshed.ok || !refreshed.tokens?.access_token) {
            return {ok: false, reason: refreshed.reason || result?.reason || "刷新 AT 失败"};
        }
        return {
            ok: true,
            tokens: {
                access_token: refreshed.tokens.access_token,
                refresh_token: refreshed.tokens.refresh_token || refreshToken,
                id_token: refreshed.tokens.id_token || "",
            },
        };
    }

    async function exportAccounts(rows, {
        concurrency = 4,
        isStopped = () => false,
        log = () => {},
        progress = false,
    } = {}) {
        const accounts = [];
        let ok = 0;
        let fail = 0;
        let done = 0;
        const total = rows.length;
        let accountsById = null;
        if (getAccounts && rows.length > 0 && rows.length <= 100) {
            try {
                const prefetched = await getAccounts(rows.map((row) => row.account_id));
                accountsById = new Map(prefetched.map((account) => [Number(account.id), account]));
            } catch (error) {
                log(`sub2json 批量读取账号失败，回退逐条读取: ${String(error?.message || error).slice(0, 120)}`);
            }
        }

        await runBoundedPool(rows, async (row) => {
            if (isStopped()) return;
            const index = ++done;
            let account;
            try {
                account = accountsById?.get(Number(row.account_id)) || await getAccount(row.account_id);
            } catch (error) {
                fail++;
                log(`[sub2json${progress ? ` ${index}/${total}` : ""}] ✗ ${row.email} 读取账号失败 ${String(error?.message || error).slice(0, 120)}`);
                return;
            }
            if (!account) {
                fail++;
                if (progress) log(`[sub2json ${index}/${total}] ✗ ${row.email} 账号不存在`);
                return;
            }
            if (progress) log(`[sub2json ${index}/${total}] ${row.email}…`);
            try {
                const got = await ensureTokens(account, (message) => log(`  ${row.email}: ${String(message || "").slice(0, 120)}`));
                if (isStopped()) return;
                if (!got.ok || !got.tokens?.access_token) {
                    fail++;
                    log(`[sub2json${progress ? ` ${index}/${total}` : ""}] ✗ ${row.email} ${got.reason || "失败"}`);
                    return;
                }
                accounts.push(toSub2jsonAccount(row.email, got.tokens));
                ok++;
                if (progress) log(`[sub2json ${index}/${total}] ✓ ${row.email}`);
            } catch (error) {
                fail++;
                log(`[sub2json${progress ? ` ${index}/${total}` : ""}] ✗ ${row.email} ${error?.message || error}`);
            }
        }, Math.max(1, Number(concurrency) || 1));

        accounts.sort((a, b) => String(a.name).localeCompare(String(b.name)));
        return {accounts, ok, fail, total};
    }

    return {ensureTokens, exportAccounts};
}
