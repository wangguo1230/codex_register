// @ts-nocheck
// 错误卡复活：仅平台确认仍为 unused 时放回未使用池。
export function createRechargeCardRecovery({listCards, listErrorCards, validateCard, unpairCards, isAllowed, isRateLimited = () => false, log = () => {}, now = () => Date.now(), targetCount = 1} = {}) {
    const checkedAt = new Map();
    const retryAfterMs = 15 * 60_000;
    const batchSize = 50;

    return async function reviveErrorCards() {
        const list = listErrorCards ? await listErrorCards() : (await listCards()).list;
        let revived = 0;
        let attempted = 0;
        for (const card of list || []) {
            if (card.status !== "error" || !card.code) continue;
            if (now() - Number(checkedAt.get(Number(card.id)) || 0) < retryAfterMs) continue;
            if (attempted++ >= batchSize) break;
            try {
                const state = await validateCard(card.code);
                checkedAt.set(Number(card.id), now());
                if (String(state.status || "") !== "unused") continue;
                const released = Number(await unpairCards([card.id])) || 0;
                if (!released) {
                    log(`卡密 ${String(card.code).slice(0, 8)}… 平台虽为 unused，但仍被活动队列占用，暂不复活`);
                    continue;
                }
                checkedAt.delete(Number(card.id));
                revived++;
                log(`卡密 ${String(card.code).slice(0, 8)}… 平台仍 unused${isAllowed(state.account_change_allowed) ? "（已授权换号）" : ""}，已放回未使用池`);
                if (revived >= Math.max(1, Number(targetCount) || 1)) break;
            } catch (error) {
                checkedAt.set(Number(card.id), now());
                log(`卡密 ${String(card.code || "").slice(0, 8)}… 复活核验失败: ${String(error?.message || error).slice(0, 80)}`);
                if (isRateLimited(error?.message || error)) break;
            }
        }
        return revived;
    };
}
