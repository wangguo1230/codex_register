// @ts-nocheck
// 充值提交协调器：兼容旧批处理入口，生产环境通过持久化 worker 分片执行。
import {createRechargeSubmitDistribution} from "./recharge-submit-distributed.js";
import {normalizeConcurrency} from "./concurrency.js";

export function createRechargeSubmitService({instanceId, runtime, store, cards, precheck, submitOne, poll, runPool, config, effects, isReloginRunning = () => false, isExportRunning = () => false, isRecoveryRunning = () => false, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), now = () => Date.now(), stuckMs = 30 * 60_000} = {}) {
    const distributed = createRechargeSubmitDistribution({
        instanceId, store, cards, precheck, submitOne, config, effects,
        isReloginRunning, isExportRunning, isRecoveryRunning, sleep, now,
    });

    async function start(queueIds) {
        if (distributed.isBound()) return distributed.start(queueIds);
        if (isRecoveryRunning()) return {error: "正在人工恢复残留任务", status: 409};
        if (isReloginRunning()) return {error: "重新登录正在进行中", status: 400};
        if (isExportRunning()) return {error: "导出 RT 正在进行中", status: 409};
        if (runtime.isRunning()) return {error: "充值提交正在进行中", status: 400};
        if (!queueIds.length) return {error: "未选择队列项", status: 400};
        if (config?.isConfigured && !config.isConfigured()) {
            return {error: "充值平台 API 未配置(缺少 Base URL 或 API Key)", status: 400};
        }
        const generation = runtime.begin();
        let claimedAll = [];
        let claimedIds = [];
        try {
            const claimed = await store.claim(queueIds, instanceId);
            claimedAll = claimed.claimed;
            claimedIds = claimedAll.map((item) => Number(item.id));
            const items = claimedAll.filter((item) => item.status === "pending");
            if (!items.length) {
                await store.release(claimedIds, instanceId);
                runtime.end(generation);
                return {error: claimed.skipped[0]?.reason || "无可提交的队列项(需 status=pending,且未被其他实例占用)", status: 400};
            }
            const nonPendingIds = claimedAll
                .filter((value) => value.status !== "pending")
                .map((item) => Number(item.id));
            if (nonPendingIds.length) await store.release(nonPendingIds, instanceId);
            if (await store.unusedCardCount() < 1) {
                await store.release(claimedIds, instanceId);
                runtime.end(generation);
                return {error: "没有未使用卡密", status: 400};
            }
            void runClaimed({generation, items, skippedClaim: claimed.skipped, claimedIds}).catch((error) => {
                effects.log(`充值提交后台任务异常: ${String(error?.message || error).slice(0, 160)}`);
            });
            return {ok: true, paired: 0, claimed: items.length, skipped: claimed.skipped.length, instanceId};
        } catch (error) {
            if (claimedIds.length) await store.release(claimedIds, instanceId).catch(() => {});
            runtime.end(generation);
            return {error: String(error?.message || error), status: 500};
        }
    }

    async function runClaimed({generation, items, skippedClaim, claimedIds}) {
        const intervalMs = config.intervalSeconds() * 1000;
        const precheckConcurrency = normalizeConcurrency(config.concurrency(), 3);
        let accountsById = null;
        if (store.getAccounts && items.length <= 100) {
            try {
                const accounts = await store.getAccounts(items.map((item) => item.account_id));
                accountsById = new Map(accounts.map((account) => [Number(account.id), account]));
            } catch (error) {
                effects.log(`批量读取充值账号失败，回退逐条读取: ${String(error?.message || error).slice(0, 120)}`);
            }
        }
        let submitted = 0;
        let failed = 0;
        let precheckDone = 0;
        let wasStopped = false;
        let submitGate = Promise.resolve();
        const isStopped = () => runtime.isStopped(generation);
        const notifyAll = async () => {
            try {
                if (effects.scheduleAll) effects.scheduleAll();
                else await effects.syncAll();
            } catch (error) {
                effects.log(`刷新充值视图失败: ${String(error?.message || error).slice(0, 120)}`);
            }
        };
        const notifyQueue = async () => {
            try {
                if (effects.scheduleAll) effects.scheduleAll();
                else await effects.syncQueue();
            } catch (error) {
                effects.log(`刷新充值队列失败: ${String(error?.message || error).slice(0, 120)}`);
            }
        };

        const submitPassed = async (candidate, account) => {
            if (isStopped()) return;
            const current = await store.get(candidate.id);
            if (isStopped()) return;
            if (!current) {
                failed++;
                effects.log(`跳过 ${candidate.email}：队列项已不存在`);
                return;
            }
            if (current.status === "error") {
                effects.log(`跳过 ${candidate.email}：已人工标记失败`);
                return;
            }
            const picked = await cards.takeReusable(candidate.email, {isStopped});
            if (isStopped()) {
                if (picked.card) await cards.release([picked.card.id]).catch(() => {});
                return;
            }
            if (!picked.card) {
                failed++;
                if (picked.rateLimited) runtime.requestStop(generation);
                const reason = cards.failureReason(picked);
                await store.updateQueue(candidate.id, {status: "error", error: reason, instance_id: "", finished_at: now()});
                effects.log(`预检 ✓ ${candidate.email}，但${reason}，不提交`);
                await notifyQueue();
                return;
            }
            const card = picked.card;
            let assignment;
            try {
                assignment = await store.assignCard(candidate.id, card.id, candidate.account_id, candidate.email, instanceId);
            } catch (error) {
                await cards.release([card.id]).catch(() => {});
                throw error;
            }
            const queueItem = assignment?.queueItem;
            const liveCard = assignment?.card;
            if (!queueItem || !liveCard) {
                failed++;
                await store.cancelPair(candidate.id, card.id, instanceId).catch(() => {});
                return;
            }
            await notifyAll();
            if (isStopped()) {
                effects.log(`跳过 ${candidate.email}：所属批次已停止`);
                await store.cancelPair(queueItem.id, liveCard.id, instanceId).catch(() => {});
                return;
            }
            effects.log(`提交 ${queueItem.email} ← ${String(liveCard.code || "").slice(0, 8)}…`);
            const result = await submitOne(queueItem, liveCard, "", {validation: picked.val || null, account});
            if (result.ok) submitted++;
            else failed++;
            await notifyAll();
            if (!isStopped() && intervalMs > 0) await sleep(intervalMs);
        };

        const enqueueSubmit = (item, account) => {
            const running = submitGate.then(() => submitPassed(item, account));
            submitGate = running.catch(() => {});
            return running;
        };

        try {
            effects.log(`本实例 ${instanceId} 预检并发 ${precheckConcurrency}，通过即提交 ${items.length} 个 / API: ${config.baseUrl()}`);
            for (const skipped of skippedClaim) effects.log(`⏭ ${skipped.email}: ${skipped.reason}`);
            await runPool(items, async (item) => {
                try {
                    if (isStopped()) return;
                    const queueItem = item;
                    if (queueItem.status === "error") {
                        effects.log(`跳过 ${queueItem.email}：已人工标记失败`);
                        return;
                    }
                    effects.log(`[预检] ${queueItem.email}`);
                    const account = accountsById?.get(Number(queueItem.account_id));
                    const result = await precheck(queueItem, account);
                    if (isStopped()) return;
                    const sequence = ++precheckDone;
                    if (!result.ok) {
                        if (result.transient) {
                            effects.log(`预检 抖动 ${sequence}/${items.length} ${queueItem.email}: ${result.reason}`);
                            await notifyQueue();
                            return;
                        }
                        failed++;
                        await store.updateQueue(queueItem.id, {status: "error", error: result.reason, instance_id: "", finished_at: now()});
                        effects.log(`预检 ✗ ${sequence}/${items.length} ${queueItem.email}: ${result.reason}，不配卡、不提交`);
                        await notifyQueue();
                        return;
                    }
                    effects.log(`预检 ✓ ${sequence}/${items.length} ${queueItem.email}，立刻配卡提交`);
                    await enqueueSubmit(queueItem, account);
                } catch (error) {
                    failed++;
                    effects.log(`处理 ${item.email || item.id} 异常: ${String(error?.message || error).slice(0, 160)}`);
                }
            }, precheckConcurrency);
            await submitGate;
            if (isStopped()) effects.log("已停止充值提交");
            effects.log(`提交完成: 成功 ${submitted} / 失败 ${failed} / 总计 ${items.length}`);
        } catch (error) {
            effects.log(`充值提交异常: ${String(error?.message || error).slice(0, 160)}`);
        } finally {
            wasStopped = isStopped();
            await store.releaseByInstance(instanceId, claimedIds).catch((error) => {
                effects.log(`释放充值认领失败: ${String(error?.message || error).slice(0, 120)}`);
            });
            await effects.syncQueue().catch((error) => {
                effects.log(`刷新充值最终状态失败: ${String(error?.message || error).slice(0, 120)}`);
            });
            runtime.end(generation);
            effects.scheduleAll?.();
        }
        if (submitted > 0 && !wasStopped) {
            effects.log("开始轮询任务状态…（已解锁，可继续提交其他号）");
            await poll.runLoop();
        }
    }

    function stop({force = false} = {}) {
        if (distributed.isBound()) return distributed.stop({force});
        runtime.requestStop();
        const elapsed = runtime.elapsedMs();
        const shouldForce = force || (runtime.isRunning() && elapsed > stuckMs);
        if (shouldForce && runtime.isRunning()) {
            runtime.forceUnlock();
            effects.log(`强制解锁充值提交（已占用 ${Math.round(elapsed / 1000)}s）`);
        }
        return {ok: true, running: runtime.isRunning(), forced: shouldForce};
    }

    return {
        start,
        stop,
        bindDistributedWorker: distributed.bind,
        processDistributedTask: distributed.processTask,
        isRunning: () => distributed.isRunning() || runtime.isRunning(),
    };
}
