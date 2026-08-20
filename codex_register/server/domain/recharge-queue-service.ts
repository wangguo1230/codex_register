// @ts-nocheck
// 充值基础队列应用服务：入队、交付、重置、人工失败和卡密安全回收。

export function createRechargeQueueService({store, api, cardPolicy, effects} = {}) {
    const idsOf = (values) => (values || []).map(Number).filter(Number.isInteger);

    async function listRechargeableAccounts() {
        return (await store.listSuccessAccounts()).filter((account) => !account.sold_at && account.auth_file);
    }

    async function add(accountIds, batch = "") {
        if (!accountIds.length) return {error: "未选择账号", status: 400};
        const result = await store.add(accountIds, String(batch || ""));
        await effects.syncQueue();
        await effects.syncAccounts();
        return {ok: true, ...result};
    }

    async function deliver(ids, movedFromQueue = false) {
        const result = await store.deliver(ids);
        effects.log(`已交付 ${result.count} 个${movedFromQueue ? "（从队列移入已交付）" : ""}${result.cardsRemoved ? `，卡密池移除 ${result.cardsRemoved} 张已用卡` : ""}`);
        await effects.syncQueue();
        if (result.cardsRemoved) await effects.syncCards();
        return {ok: true, ...result};
    }

    async function undeliver(ids) {
        const result = await store.undeliver(ids);
        effects.log(`退回未交付 ${result.count} 个`);
        await effects.syncQueue();
        return {ok: true, ...result};
    }

    async function setBatch(ids, batch) {
        await store.setBatch(ids, String(batch ?? ""));
        await effects.syncQueue();
        return {ok: true};
    }

    async function reset(ids) {
        if (!ids.length) return {error: "未选择队列项", status: 400};
        const info = await store.reset(ids);
        await effects.syncQueue();
        await effects.syncCards();
        if (info.kept) effects.log(`重置 ${info.reset} 项: ${info.reclaimed} 张卡密已回收, ${info.kept} 张存在提交痕迹，已保留原队列关系(需先核对或回收)`);
        return {ok: true, ...info};
    }

    async function markError(ids, reason = "") {
        if (!ids.length) return {error: "未选择队列项", status: 400};
        const normalized = String(reason || "").trim();
        const info = await store.markError(ids, normalized);
        await effects.syncQueue();
        await effects.syncCards();
        if (info.count) effects.log(`人工标记失败 ${info.count} 个（已移入失败页）${info.reclaimed ? `，收回卡密 ${info.reclaimed}` : ""}${normalized ? `：${normalized}` : ""}`);
        return {ok: true, ...info};
    }

    async function reclaimCards(ids) {
        if (!ids.length) return {error: "未选择队列项", status: 400};
        const items = store.getMany
            ? await store.getMany(ids)
            : (await Promise.all(ids.map((id) => store.get(id)))).filter(Boolean);
        const candidates = items.filter((item) => item.card_id && item.status === "error");
        if (!candidates.length) return {error: "无可回收的卡密(需 error 状态且有卡密)", status: 400};
        let reclaimed = 0;
        let used = 0;
        let failed = 0;
        for (const item of candidates) {
            try {
                const response = await api.call("POST", "/redeem-codes/validate", {redeem_code: item.card_code});
                const result = response.result || {};
                if (result.status === "unused" && !cardPolicy.boundToOtherAccount(result, item.email)) {
                    const released = Number(await store.unpairCards([item.card_id])) || 0;
                    if (released) {
                        reclaimed++;
                        effects.log(`✓ 卡密 ${item.card_code.slice(0, 8)}... 平台确认未使用，已安全回收`);
                    } else {
                        failed++;
                        effects.log(`✗ 卡密 ${item.card_code.slice(0, 8)}... 本地状态已变化或仍被活动队列占用，未回收`);
                    }
                } else {
                    const reason = result.status === "unused"
                        ? `平台锁在 ${result.bound_email || "其他账号"}，不能回收换号`
                        : `平台状态: ${result.status}(不可回收)`;
                    await store.updateCard(item.card_id, {status: "error", error: reason});
                    used++;
                    effects.log(`✗ 卡密 ${item.card_code.slice(0, 8)}... ${reason}`);
                }
            } catch (error) {
                failed++;
                effects.log(`✗ 卡密 ${item.card_code.slice(0, 8)}... 查询失败: ${error?.message || error}`);
            }
        }
        await effects.syncCards();
        effects.log(`回收卡密完成: 回收 ${reclaimed} / 已消费 ${used} / 查询失败 ${failed}`);
        return {ok: true, reclaimed, used, failed};
    }

    return {
        idsOf,
        listRechargeableAccounts,
        list: (delivery) => store.list(delivery),
        listBatches: (delivery) => store.listBatches(delivery),
        add,
        deliver,
        undeliver,
        setBatch,
        reset,
        markError,
        reclaimCards,
    };
}
