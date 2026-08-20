// @ts-nocheck
// 应用生命周期协调器：启动 HTTP 后注册运行期服务，并在退出前幂等退回本实例工作。
import {createPeriodicTaskRegistry} from "./periodic-task-registry.js";

export function createApplicationLifecycle({
    port,
    webBuilt,
    state,
    processGuard,
    store,
    scheduler,
    mailJobs,
    mailWorkers = {stopAll: () => 0},
    recharge,
    token = {workers: []},
    daily,
    browser,
    rss,
    effects,
    runtime = process,
    periodicTasks = createPeriodicTaskRegistry({
        onError: (name, error) => effects.warn(`[server] 周期任务 ${name} 失败: ${error?.message || error}`),
    }),
} = {}) {
    let server = null;
    let unregisterPid = null;
    let rssStop = null;
    let signalsInstalled = false;
    let parkPromise = null;
    let backgroundStarted = false;

    const fire = (label, task) => {
        Promise.resolve().then(task).catch((error) => effects.warn(`[server] ${label}失败: ${error?.message || error}`));
    };

    function startBackgroundWork() {
        if (backgroundStarted || state.shuttingDown) return false;
        backgroundStarted = true;
        fire("RSS 内存监控启动", async () => {
            const stop = await rss.start({
                name: String(port),
            });
            if (typeof stop !== "function") return;
            if (state.shuttingDown) stop();
            else rssStop = stop;
        });

        mailJobs.startPaused();
        recharge.lifecycle.start?.();
        for (const worker of token.workers || []) worker?.start?.();
        effects.log("[mail-jobs] 服务启动默认不恢复历史任务；请从控制台人工开始或恢复");
        fire("邮箱实例上报", mailJobs.heartbeat);

        periodicTasks.every("mail-job-windows", 30_000, () => browser.refreshWindows({listBit: mailJobs.hasBusyWork()}));
        periodicTasks.every("mail-job-tick", 2_000, mailJobs.tick);
        periodicTasks.every("mail-job-heartbeat", 15_000, mailJobs.heartbeat);
        periodicTasks.every("daily-maintenance", 60_000, daily.runIfDue);
        return true;
    }

    function maybeStartBackgroundWork() {
        if (!state.httpReady || !state.infrastructureReady || state.shuttingDown) return false;
        return startBackgroundWork();
    }

    function onListening() {
        state.httpReady = true;
        effects.log(`[server] http://localhost:${port} 已监听  instance=${store.instanceId}  (前端 ${webBuilt ? "已托管" : "未构建, 用 vite dev"})`);
        maybeStartBackgroundWork();
    }

    function markInfrastructureReady() {
        state.infrastructureReady = true;
        state.startupPhase = "ready";
        state.startupError = "";
        effects.log("[server] 基础设施已就绪，运行期服务已启动；历史任务保持暂停");
        maybeStartBackgroundWork();
    }

    function markInfrastructureFailed(error) {
        state.infrastructureReady = false;
        state.startupPhase = "failed";
        state.startupError = String(error?.message || error || "基础设施初始化失败").slice(0, 500);
    }

    function onHttpError(error) {
        state.httpReady = false;
        periodicTasks.stopAll();
        void recharge.lifecycle.stop();
        unregisterPid?.();
        effects.error(`[server] 无法占用 :${port}（${error?.message || error}），本进程退出，避免无端口还领任务开窗`);
        runtime.exit(1);
    }

    function parkWorkForShutdown(reason = "") {
        if (parkPromise) return parkPromise;
        state.shuttingDown = true;
        state.httpReady = false;
        state.infrastructureReady = false;
        periodicTasks.stopAll();
        rssStop?.();
        rssStop = null;
        const stopRecharge = recharge.lifecycle.stop({waitForIdle: true, timeoutMs: 15_000});
        for (const worker of token.workers || []) void worker?.stop?.({waitForIdle: false});
        mailJobs.requestStop();
        try { mailWorkers.stopAll?.(); } catch (error) { effects.warn(`[server] 停止邮箱 worker 失败: ${error?.message || error}`); }

        parkPromise = (async () => {
            try {
                const stopped = await stopRecharge;
                if (stopped?.rebindIdle === false) {
                    effects.warn("[server] 换绑任务停止等待超时，继续按持久化阶段停放租约");
                }
            } catch (error) {
                effects.warn(`[server] 停止充值任务失败，继续释放持久化租约: ${error?.message || error}`);
            }
            try { await store.setMailClaimPaused(true); } catch { /* */ }
            try { effects.rechargeLog(`实例退出（${reason || "关停"}），任务退回排队，不会标失败`); } catch { /* */ }
            try { effects.broadcastRechargeJobs(); } catch { /* */ }
            try {
                const released = await store.releaseInstanceWork(store.instanceId);
                effects.log(`[server] 已退回队列 gpt=${released.gpt} claude=${released.claude} sms=${released.sms} pw=${released.pw} mail=${released.mail || 0} recharge=${released.recharge}`);
            } catch (error) {
                effects.warn(`[server] 退回队列失败: ${error?.message || error}`);
            }
            try {
                const rebind = await store.parkRebindWork(store.instanceId, `实例因 ${reason || "关停"} 在 verify 阶段退出，状态待核对`);
                if (rebind?.leases) effects.log(`[server] 已停换绑租约 ${rebind.leases} 个，待对账 ${rebind.unknown || 0} 个，归还邮箱 ${rebind.mailboxes || 0} 个`);
            } catch (error) {
                effects.warn(`[server] 换绑任务收尾失败: ${error?.message || error}`);
            }
            scheduler.pause();
            scheduler.pauseClaude();
            scheduler.releasingGpt = true;
            scheduler.releasingClaude = true;
            try { scheduler.killDomain("gpt"); } catch { /* */ }
            try { scheduler.killDomain("claude"); } catch { /* */ }
            try { await browser.closeTrackedWindows(); } catch { /* */ }
        })();
        return parkPromise;
    }

    async function shutdown(signal) {
        effects.log(`[server] ${signal} 关闭本实例 ${store.instanceId},释放未完成任务…`);
        await parkWorkForShutdown(signal);
        unregisterPid?.();
        runtime.exit(0);
    }

    const onSigint = () => { void shutdown("SIGINT"); };
    const onSigterm = () => { void shutdown("SIGTERM"); };

    function installSignalHandlers() {
        if (signalsInstalled) return;
        signalsInstalled = true;
        runtime.on("SIGINT", onSigint);
        runtime.on("SIGTERM", onSigterm);
    }

    function removeSignalHandlers() {
        if (!signalsInstalled) return;
        signalsInstalled = false;
        runtime.off?.("SIGINT", onSigint);
        runtime.off?.("SIGTERM", onSigterm);
    }

    function startHttp(app) {
        processGuard.killExistingHttp();
        unregisterPid = processGuard.registerPid();
        installSignalHandlers();
        try {
            server = app.listen(port, "0.0.0.0", onListening);
            server.on("error", onHttpError);
            return server;
        } catch (error) {
            onHttpError(error);
            return null;
        }
    }

    function dispose() {
        periodicTasks.stopAll();
        void recharge.lifecycle.stop();
        try { mailWorkers.stopAll?.(); } catch { /* */ }
        scheduler.dispose?.();
        rssStop?.();
        rssStop = null;
        removeSignalHandlers();
        unregisterPid?.();
        unregisterPid = null;
        state.httpReady = false;
        state.infrastructureReady = false;
    }

    return {
        startHttp,
        markInfrastructureReady,
        markInfrastructureFailed,
        parkWorkForShutdown,
        shutdown,
        dispose,
        isShuttingDown: () => state.shuttingDown,
    };
}
