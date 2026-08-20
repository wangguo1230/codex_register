// @ts-nocheck
// 普通充值队列重登批次：逐项刷新 session，不负责认领、互斥和运行态收尾。

export async function runRechargeReloginBatch({
    items,
    skipped,
    store,
    relogin,
    credentials,
    effects,
    childProcesses,
    isStopped,
    instanceId,
} = {}) {
    let ok = 0;
    let fail = 0;
    effects.log(`[重登] 本实例 ${instanceId} 认领 ${items.length} 个${skipped.length ? `，跳过 ${skipped.length} 个(其他实例/不可处理)` : ""}`);
    for (const item of skipped) effects.log(`[重登] ⏭ ${item.email}: ${item.reason}`);
    for (let index = 0; index < items.length; index++) {
        const queueItem = items[index];
        if (isStopped()) {
            effects.log("[重登] 已停止");
            break;
        }
        const account = await store.getAccount(queueItem.account_id);
        if (!account) {
            fail++;
            effects.log(`[重登] [${index + 1}/${items.length}] ${queueItem.email}: ❌ 账号不存在`);
            continue;
        }
        effects.log(`[重登] [${index + 1}/${items.length}] ${queueItem.email}: 协议重登（GPT 池换出口，不挤 10808）…`);
        try {
            const result = await relogin(account, {
                preferPool: true,
                allowBrowser: false,
                onProgress: (message) => effects.log(`[重登] ${queueItem.email}: ${String(message || "").slice(0, 140)}`),
                onChild: childProcesses.track,
            });
            if (isStopped()) break;
            if (!result.ok || !result.authFile) {
                fail++;
                effects.log(`[重登] [${index + 1}/${items.length}] ${queueItem.email}: ❌ ${result.reason || "浏览器登录失败"}`);
            } else {
                const fresh = await store.getAccount(queueItem.account_id);
                const auth = credentials.readAuth(fresh);
                if (!credentials.extractSession(auth)) {
                    fail++;
                    effects.log(`[重登] [${index + 1}/${items.length}] ${queueItem.email}: ❌ 登录后仍无 session 数据`);
                    continue;
                }
                await store.updateQueueAuth(queueItem.id, fresh?.auth_file || "", auth);
                ok++;
                effects.log(`[重登] [${index + 1}/${items.length}] ${queueItem.email}: ✅ 登录成功, session: 有效`);
            }
        } catch (error) {
            fail++;
            effects.log(`[重登] [${index + 1}/${items.length}] ${queueItem.email}: ❌ ${String(error?.message || error).slice(0, 100)}`);
        }
        if (effects.scheduleAll) effects.scheduleAll();
        else await effects.syncQueue();
    }
    effects.log(`[重登] 完成: 成功 ${ok} / 失败 ${fail} / 共 ${items.length}`);
    return {ok, fail};
}
