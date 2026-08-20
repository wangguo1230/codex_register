// @ts-nocheck
// 卡密分配应用服务：认领、平台核验、暂存他号卡和失败补偿。
export function createRechargeCardAllocator({
    isStopped,
    claimUnusedCards,
    reviveErrorCards,
    validateCard,
    unpairCards,
    lockCard,
    cardBoundToOtherAccount,
    isRateLimited,
    log = () => {},
} = {}) {
    const ownerAffinity = new Map();
    const affinityTtlMs = 60 * 60_000;

    return async function takeReusableCard(email, {maxTries = 20, isStopped: operationStopped = isStopped} = {}) {
        const skipped = [];
        const heldForOwner = [];
        const attempted = new Set();
        let revived = false;
        const releaseHeld = async () => {
            if (!heldForOwner.length) return;
            const ids = heldForOwner.splice(0);
            try { await unpairCards(ids); } catch { /* 与旧实现一致：释放失败不覆盖主结果 */ }
        };

        try {
            for (let attempt = 0; attempt < maxTries; attempt++) {
                if (operationStopped()) {
                    await releaseHeld();
                    return {card: null, skipped, empty: false, reason: "已停止配卡"};
                }
                const now = Date.now();
                for (const [id, affinity] of ownerAffinity) {
                    if (now - affinity.checkedAt > affinityTtlMs) ownerAffinity.delete(id);
                }
                const excluded = [];
                for (const [id, affinity] of ownerAffinity) {
                    if (affinity.email && affinity.email.toLowerCase() !== String(email || "").toLowerCase()) excluded.push(id);
                }
                for (const id of attempted) excluded.push(id);
                let cards = await claimUnusedCards(1, {excludeIds: excluded});
                if (!cards.length && !revived) {
                    revived = true;
                    if (await reviveErrorCards()) cards = await claimUnusedCards(1, {excludeIds: excluded});
                }
                if (!cards.length) {
                    await releaseHeld();
                    return {card: null, skipped, empty: skipped.length === 0};
                }

                const card = cards[0];
                attempted.add(Number(card.id));
                try {
                    const state = await validateCard(card.code);
                    log(`卡密 ${String(card.code).slice(0, 8)}… 平台=${state.status || "?"} bound=${state.bound_email || "-"} locked=${state.account_change_locked} allowed=${state.account_change_allowed}`);
                    if (String(state.status || "") !== "unused") {
                        const reason = `平台状态 ${state.status || "?"}，不能配`;
                        await lockCard(card.id, reason);
                        skipped.push({code: card.code, reason});
                        log(`跳过卡密 ${String(card.code).slice(0, 8)}… ${reason}`);
                        continue;
                    }
                    if (cardBoundToOtherAccount(state, email)) {
                        const reason = `平台锁在 ${state.bound_email || "其他账号"}，不能换给 ${email}`;
                        ownerAffinity.set(Number(card.id), {
                            email: String(state.bound_email || "").trim(),
                            checkedAt: Date.now(),
                        });
                        if (ownerAffinity.size > 5_000) ownerAffinity.delete(ownerAffinity.keys().next().value);
                        heldForOwner.push(card.id);
                        skipped.push({code: card.code, reason});
                        log(`跳过卡密 ${String(card.code).slice(0, 8)}… ${reason}（先挪开，留给对得上的号）`);
                        continue;
                    }
                    ownerAffinity.delete(Number(card.id));
                    await releaseHeld();
                    return {card, skipped, empty: false, val: state};
                } catch (error) {
                    const reason = `核验失败: ${String(error?.message || error).slice(0, 120)}`;
                    await unpairCards([card.id]);
                    skipped.push({code: card.code, reason});
                    log(`跳过卡密 ${String(card.code).slice(0, 8)}… ${reason}（已放回未使用）`);
                    if (isRateLimited(reason)) {
                        await releaseHeld();
                        log("平台核验 429，停止配卡（不再连打同一张）");
                        return {card: null, skipped, empty: false, rateLimited: true, reason};
                    }
                }
            }
            await releaseHeld();
            return {card: null, skipped, empty: false};
        } catch (error) {
            await releaseHeld();
            throw error;
        }
    };
}
