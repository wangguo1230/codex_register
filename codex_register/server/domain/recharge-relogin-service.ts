// @ts-nocheck
// 充值重登应用服务：刷新队列 session，以及重登后验卡、重置并提交。
import {createChildProcessRegistry} from "./child-process-registry.js";
import {runRechargeReloginBatch} from "./recharge-relogin-batch-runner.js";
import {createRechargeReloginSubmitLegacyRunner} from "./recharge-relogin-submit-legacy.js";
import {createRechargeReloginSubmitTaskExecutor} from "./recharge-relogin-submit-task.js";
import {createRechargeReloginSubmitDistribution} from "./recharge-relogin-submit-distributed.js";

export function createRechargeReloginService({instanceId, batchRuntime, store, relogin, credentials, api, cards, submitOne, poll, policy, config, effects, isSubmitRunning = () => batchRuntime.isRunning(), isExportRunning = () => false, isRecoveryRunning = () => false, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), childProcesses = createChildProcessRegistry()} = {}) {
    let running = false;
    let stopped = false;
    let distributed;

    const distributedExecutor = createRechargeReloginSubmitTaskExecutor({
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
        isStopped: () => stopped,
    });
    distributed = createRechargeReloginSubmitDistribution({
        instanceId,
        store,
        executor: distributedExecutor,
        effects: {...effects, childProcesses},
        isSubmitRunning,
        isExportRunning,
        isRecoveryRunning,
        isReloginRunning: () => running,
        isConfigured: () => config?.isConfigured ? config.isConfigured() : true,
    });

    const setRunning = (value) => {
        running = value;
        effects.jobsChanged();
    };

    const runLegacyReloginSubmit = createRechargeReloginSubmitLegacyRunner({
        instanceId, batchRuntime, store, relogin, credentials, api, cards, submitOne, poll, policy, config, effects,
        childProcesses, isStopped: () => stopped, sleep,
        onFinished: async ({generation}) => {
            running = false;
            stopped = false;
            batchRuntime.end(generation);
            effects.jobsChanged();
        },
    });

    async function claim(ids) {
        try {
            return await store.claim(ids, instanceId);
        } catch (error) {
            setRunning(false);
            return {error: String(error?.message || error), status: 500};
        }
    }

    async function start(ids) {
        if (isRecoveryRunning()) return {error: "正在人工恢复残留任务", status: 409};
        if (running) return {error: "重新登录正在进行中", status: 400};
        if (isSubmitRunning()) return {error: "充值提交正在进行中", status: 400};
        if (isExportRunning()) return {error: "导出 RT 正在进行中", status: 409};
        if (!ids.length) return {error: "未选择队列项", status: 400};
        running = true;
        stopped = false;
        effects.jobsChanged();
        const claimed = await claim(ids);
        if (claimed.error) return claimed;
        if (!claimed.claimed.length) {
            setRunning(false);
            return {error: claimed.skipped[0]?.reason || "未找到可认领的队列项(可能已被其他实例占用)", status: 400};
        }
        const claimedIds = claimed.claimed.map((item) => Number(item.id));
        void runRelogin(claimed.claimed, claimed.skipped, claimedIds).catch((error) => {
            effects.log(`[重登] 后台任务异常: ${String(error?.message || error).slice(0, 160)}`);
        });
        return {ok: true, count: claimed.claimed.length, claimed: claimed.claimed.length, skipped: claimed.skipped.length, instanceId};
    }

    async function runRelogin(items, skipped, claimedIds) {
        try {
            await runRechargeReloginBatch({
                items,
                skipped,
                store,
                relogin,
                credentials,
                effects,
                childProcesses,
                isStopped: () => stopped,
                instanceId,
            });
        } finally {
            await store.releaseByInstance(instanceId, claimedIds).catch((error) => {
                effects.log(`[重登] 释放认领失败: ${String(error?.message || error).slice(0, 120)}`);
            });
            const finalSync = effects.syncAll || effects.syncQueue;
            await finalSync().catch((error) => {
                effects.log(`[重登] 刷新队列失败: ${String(error?.message || error).slice(0, 120)}`);
            });
            running = false;
            stopped = false;
            effects.jobsChanged();
        }
    }

    async function startAndSubmit(ids) {
        if (distributed?.isBound?.()) {
            stopped = false;
            return distributed.start(ids);
        }
        if (isRecoveryRunning()) return {error: "正在人工恢复残留任务", status: 409};
        if (running) return {error: "重新登录正在进行中", status: 400};
        if (isSubmitRunning()) return {error: "充值提交正在进行中", status: 400};
        if (isExportRunning()) return {error: "导出 RT 正在进行中", status: 409};
        if (!ids.length) return {error: "未选择队列项", status: 400};
        if (config?.isConfigured && !config.isConfigured()) {
            return {error: "充值平台 API 未配置(缺少 Base URL 或 API Key)", status: 400};
        }
        running = true;
        stopped = false;
        const generation = batchRuntime.begin();
        effects.jobsChanged();
        const claimed = await store.claim(ids, instanceId, {allowError: true}).catch((error) => ({
            error: String(error?.message || error),
            status: 500,
        }));
        if (claimed.error) {
            setRunning(false);
            batchRuntime.end(generation);
            return claimed;
        }
        if (!claimed.claimed.length) {
            setRunning(false);
            batchRuntime.end(generation);
            return {error: claimed.skipped[0]?.reason || "无可认领的队列项(已提交/已完成或已被其他实例占用)", status: 400};
        }
        const claimedIds = claimed.claimed.map((item) => Number(item.id));
        void runLegacyReloginSubmit({generation, items: claimed.claimed, skippedClaim: claimed.skipped, claimedIds}).catch((error) => {
            effects.log(`[重登提交] 后台任务异常: ${String(error?.message || error).slice(0, 160)}`);
        });
        return {ok: true, count: claimed.claimed.length, claimed: claimed.claimed.length, skipped: claimed.skipped.length, instanceId};
    }

    function stop() {
        stopped = true;
        batchRuntime.requestStop();
        const killed = childProcesses.terminateAll();
        if (distributed?.isBound?.()) return distributed.stop();
        effects.jobsChanged();
        return {ok: true, running, killed};
    }

    return {
        start,
        startAndSubmit,
        stop,
        bindDistributedWorker: distributed.bind,
        processDistributedTask: distributed.processTask,
        distributedTaskHooks: {
            onTaskStart: distributed.onTaskStart,
            onTaskFinish: distributed.onTaskFinish,
        },
        isRunning: () => running || distributed.isRunning(),
        requestStop: stop,
    };
}
