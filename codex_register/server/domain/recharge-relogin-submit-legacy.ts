// @ts-nocheck
// 兼容旧装配的重登提交批处理。生产组合根绑定持久化 worker 后不会走这里。
export function createRechargeReloginSubmitLegacyRunner({
    instanceId,
    batchRuntime,
    store,
    relogin,
    credentials,
    api,
    cards,
    submitOne,
    poll,
    policy,
    config,
    effects,
    childProcesses,
    isStopped,
    sleep,
    onFinished,
} = {}) {
    return async function run({generation, items, skippedClaim, claimedIds}) {
        const intervalMs = config.intervalSeconds() * 1000;
        const isBatchStopped = () => isStopped() || batchRuntime.isStopped(generation);
        let ok = 0;
        let fail = 0;
        let skipped = 0;
        let wasStopped = false;
        try {
            effects.log(`[重登提交] 本实例 ${instanceId} 认领 ${items.length} 个(重登 → 验卡 → 重置 → 提交)${skippedClaim.length ? `，跳过 ${skippedClaim.length} 个` : ""}`);
            for (const item of skippedClaim) effects.log(`[重登提交] ⏭ ${item.email}: ${item.reason}`);
            for (let index = 0; index < items.length; index++) {
                if (isBatchStopped()) {
                    effects.log("[重登提交] 已停止");
                    break;
                }
                const tag = `[重登提交] [${index + 1}/${items.length}] `;
                const original = await store.getQueue(items[index].id);
                if (!original) {
                    skipped++;
                    continue;
                }
                const account = await store.getAccount(original.account_id);
                if (!account) {
                    fail++;
                    effects.log(`${tag}${original.email}: ❌ 账号不存在`);
                    continue;
                }
                effects.log(`${tag}${original.email}: 协议重登（GPT 池换出口，不挤 10808）…`);
                try {
                    const result = await relogin(account, {
                        preferPool: true,
                        allowBrowser: false,
                        onProgress: (message) => effects.log(`${tag}${original.email}: ${String(message || "").slice(0, 140)}`),
                        onChild: childProcesses.track,
                    });
                    if (isBatchStopped()) break;
                    if (!result.ok || !result.authFile) {
                        fail++;
                        const reason = String(result.reason || "未知");
                        effects.log(`${tag}${original.email}: ❌ 登录失败: ${reason.slice(0, 180)}`);
                        if (policy.isAccountDeadReason(reason)) {
                            await store.updateAccount(account.id, {error: reason.slice(0, 500)}).catch(() => {});
                            await store.updateQueue(original.id, {status: "error", error: "OpenAI 账号已停用/删除，重登无效"}).catch(() => {});
                            effects.log(`${tag}${original.email}: 号已停用，已标失败，换代理也登不上`);
                        }
                        continue;
                    }
                } catch (error) {
                    fail++;
                    effects.log(`${tag}${original.email}: ❌ 登录异常: ${String(error?.message || error).slice(0, 100)}`);
                    continue;
                }
                const fresh = await store.getAccount(original.account_id);
                if (isBatchStopped()) break;
                const auth = credentials.readAuth(fresh);
                if (!credentials.extractSession(auth)) {
                    fail++;
                    effects.log(`${tag}${original.email}: ❌ 登录后仍无 session 数据`);
                    continue;
                }
                await store.updateQueueAuth(original.id, fresh?.auth_file || "", auth);
                effects.log(`${tag}${original.email}: ✅ session 已刷新`);

                let card = null;
                let cardValidation = null;
                if (original.card_id) {
                    card = await store.getCard(original.card_id);
                    if (card) {
                        try {
                            const response = await api.call("POST", "/redeem-codes/validate", {redeem_code: card.code});
                            cardValidation = response.result || {};
                            const status = cardValidation.status;
                            if (status !== "unused") {
                                await store.updateCard(card.id, {status: "error", error: `平台状态: ${status}(不可复用)`});
                                skipped++;
                                effects.log(`${tag}${original.email}: ⏭ 原卡密平台状态 ${status},可能已充值成功,跳过(请人工确认)`);
                                if (effects.scheduleAll) effects.scheduleAll();
                                else await effects.syncAll();
                                continue;
                            }
                        } catch (error) {
                            fail++;
                            effects.log(`${tag}${original.email}: ❌ 卡密状态查询失败: ${String(error?.message || error).slice(0, 100)}`);
                            continue;
                        }
                    }
                }
                if (!card) {
                    const picked = await cards.takeReusable(original.email, {isStopped: isBatchStopped});
                    if (isBatchStopped()) {
                        if (picked.card) await cards.release?.([picked.card.id]).catch(() => {});
                        break;
                    }
                    if (!picked.card) {
                        fail++;
                        if (picked.rateLimited) batchRuntime.requestStop(generation);
                        effects.log(`${tag}${original.email}: ❌ ${cards.failureReason(picked)}`);
                        continue;
                    }
                    card = picked.card;
                    cardValidation = picked.val || null;
                    effects.log(`${tag}${original.email}: 分配新卡密 ${card.code.slice(0, 8)}...`);
                }

                const claimedNewCard = Number(original.card_id || 0) !== Number(card.id);
                let assignment;
                try {
                    assignment = await store.assignCard(original.id, card.id, original.account_id, original.email, instanceId);
                } catch (error) {
                    if (claimedNewCard) await cards.release?.([card.id]).catch(() => {});
                    throw error;
                }
                if (!assignment?.queueItem || !assignment?.card) {
                    await store.cancelPair?.(original.id, card.id, instanceId).catch(() => {});
                    throw new Error(`配卡事务未返回完整快照: ${original.email}`);
                }
                if (isBatchStopped()) {
                    effects.log(`${tag}${original.email}: 所属批次已停止，不再提交`);
                    await store.cancelPair?.(assignment.queueItem.id, assignment.card.id, instanceId).catch(() => {});
                    break;
                }
                effects.log(`${tag}${original.email}: 已重置为待提交 ← ${card.code.slice(0, 8)}...`);
                const submitted = await submitOne(assignment.queueItem, assignment.card, tag, {validation: cardValidation});
                if (submitted.ok) ok++;
                else fail++;
                if (effects.scheduleAll) effects.scheduleAll();
                else await effects.syncAll();
                if (index + 1 < items.length && !isBatchStopped()) await sleep(intervalMs);
            }
            effects.log(`[重登提交] 完成: 成功 ${ok} / 失败 ${fail} / 跳过 ${skipped} / 共 ${items.length}`);
        } catch (error) {
            effects.log(`[重登提交] 异常: ${String(error?.message || error).slice(0, 160)}`);
        } finally {
            wasStopped = isBatchStopped();
            await store.releaseByInstance(instanceId, claimedIds).catch((error) => {
                effects.log(`[重登提交] 释放认领失败: ${String(error?.message || error).slice(0, 120)}`);
            });
            await effects.syncAll().catch((error) => {
                effects.log(`[重登提交] 刷新最终状态失败: ${String(error?.message || error).slice(0, 120)}`);
            });
            await onFinished({ok, wasStopped, generation});
        }
        if (ok > 0 && !wasStopped) {
            effects.log("开始轮询任务状态…（已解锁，可继续提交其他号）");
            await poll.runLoop();
        }
    };
}
