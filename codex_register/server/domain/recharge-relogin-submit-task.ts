// @ts-nocheck
// 重登提交单项执行器：只处理一个队列项，调度和批次状态由上层负责。
export function createRechargeReloginSubmitTaskExecutor({
    instanceId,
    store,
    relogin,
    credentials,
    api,
    cards,
    submitOne,
    policy,
    effects,
    childProcesses,
    isStopped = () => false,
} = {}) {
    const stopRequested = (signal) => isStopped() || !!signal?.aborted;
    const refreshView = async () => {
        try {
            if (effects.scheduleAll) effects.scheduleAll();
            else await effects.syncAll?.();
        } catch (error) {
            effects.log(`刷新充值视图失败: ${String(error?.message || error).slice(0, 120)}`);
        }
    };

    async function execute(task, {signal} = {}) {
        const id = Number(task?.entity_id);
        if (!Number.isInteger(id) || id <= 0) return {skipped: true, reason: "任务缺少有效队列项"};

        const claimed = await store.claim([id], instanceId, {allowError: true});
        const original = claimed?.claimed?.[0];
        if (!original) {
            return {skipped: true, reason: claimed?.skipped?.[0]?.reason || "队列项不可认领"};
        }

        const tag = `[重登提交] ${original.email}: `;
        const releaseClaimedCard = async (card) => {
            if (card?.id) await Promise.resolve(cards.release?.([card.id])).catch(() => {});
        };

        try {
            const queueItem = await store.getQueue(id);
            if (!queueItem) return {skipped: true, reason: "队列项不存在"};
            if (stopRequested(signal)) return {stopped: true};

            const account = await store.getAccount(queueItem.account_id);
            if (!account) {
                effects.log(`${tag}❌ 账号不存在`);
                return {ok: false, reason: "账号不存在"};
            }

            effects.log(`${tag}协议重登（GPT 池换出口，不挤 10808）…`);
            let loginResult;
            try {
                loginResult = await relogin(account, {
                    preferPool: true,
                    allowBrowser: false,
                    onProgress: (message) => effects.log(`${tag}${String(message || "").slice(0, 140)}`),
                    onChild: childProcesses?.track,
                });
            } catch (error) {
                const reason = String(error?.message || error).slice(0, 180);
                effects.log(`${tag}❌ 登录异常: ${reason}`);
                return {ok: false, reason};
            }
            if (stopRequested(signal)) return {stopped: true};
            if (!loginResult?.ok || !loginResult.authFile) {
                const reason = String(loginResult?.reason || "未知");
                effects.log(`${tag}❌ 登录失败: ${reason.slice(0, 180)}`);
                if (policy.isAccountDeadReason(reason)) {
                    await store.updateAccount(account.id, {error: reason.slice(0, 500)}).catch(() => {});
                    await store.updateQueue(queueItem.id, {status: "error", error: "OpenAI 账号已停用/删除，重登无效"}).catch(() => {});
                    effects.log(`${tag}号已停用，已标失败，换代理也登不上`);
                }
                return {ok: false, reason};
            }

            const fresh = await store.getAccount(queueItem.account_id);
            if (stopRequested(signal)) return {stopped: true};
            const auth = credentials.readAuth(fresh);
            if (!credentials.extractSession(auth)) {
                effects.log(`${tag}❌ 登录后仍无 session 数据`);
                return {ok: false, reason: "登录后仍无 session 数据"};
            }
            await store.updateQueueAuth(queueItem.id, fresh?.auth_file || "", auth);
            effects.log(`${tag}✅ session 已刷新`);

            let card = null;
            let cardValidation = null;
            if (queueItem.card_id) {
                card = await store.getCard(queueItem.card_id);
                if (card) {
                    try {
                        const response = await api.call("POST", "/redeem-codes/validate", {redeem_code: card.code});
                        cardValidation = response.result || {};
                        const status = cardValidation.status;
                        if (status !== "unused") {
                            await store.updateCard(card.id, {status: "error", error: `平台状态: ${status}(不可复用)`});
                            effects.log(`${tag}⏭ 原卡密平台状态 ${status},可能已充值成功,跳过(请人工确认)`);
                            await refreshView();
                            return {ok: false, skipped: true, reason: `原卡密平台状态 ${status}`};
                        }
                    } catch (error) {
                        const reason = String(error?.message || error).slice(0, 160);
                        effects.log(`${tag}❌ 卡密状态查询失败: ${reason}`);
                        return {ok: false, reason};
                    }
                }
            }

            if (!card) {
                const picked = await cards.takeReusable(queueItem.email, {isStopped: () => stopRequested(signal)});
                if (stopRequested(signal)) {
                    await releaseClaimedCard(picked.card);
                    return {stopped: true};
                }
                if (!picked.card) {
                    const reason = cards.failureReason(picked);
                    effects.log(`${tag}❌ ${reason}`);
                    return {ok: false, reason, rateLimited: !!picked.rateLimited};
                }
                card = picked.card;
                cardValidation = picked.val || null;
                effects.log(`${tag}分配新卡密 ${String(card.code || "").slice(0, 8)}...`);
            }

            const claimedNewCard = Number(queueItem.card_id || 0) !== Number(card.id);
            let assignment;
            try {
                assignment = await store.assignCard(queueItem.id, card.id, queueItem.account_id, queueItem.email, instanceId);
            } catch (error) {
                if (claimedNewCard) await releaseClaimedCard(card);
                throw error;
            }
            if (!assignment?.queueItem || !assignment?.card) {
                await Promise.resolve(store.cancelPair?.(queueItem.id, card.id, instanceId)).catch(() => {});
                throw new Error(`配卡事务未返回完整快照: ${queueItem.email}`);
            }
            if (stopRequested(signal)) {
                effects.log(`${tag}所属任务已停止，不再提交`);
                await Promise.resolve(store.cancelPair?.(assignment.queueItem.id, assignment.card.id, instanceId)).catch(() => {});
                return {stopped: true};
            }

            effects.log(`${tag}已重置为待提交 ← ${String(card.code || "").slice(0, 8)}...`);
            const result = await submitOne(assignment.queueItem, assignment.card, tag, {validation: cardValidation});
            await refreshView();
            return result || {ok: false, reason: "提交器未返回结果"};
        } finally {
            await store.releaseByInstance(instanceId, [id]).catch((error) => {
                effects.log(`${tag}释放充值租约失败: ${String(error?.message || error).slice(0, 120)}`);
            });
            await refreshView();
        }
    }

    return {execute};
}
