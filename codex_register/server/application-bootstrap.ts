// @ts-nocheck
// 基础设施引导器：串行初始化、失败退避重试，并维护应用 readiness 状态。

export function createApplicationBootstrap({
    initialize,
    state,
    lifecycle,
    retryDelayMs = 10_000,
    logger = console,
    clock = globalThis,
} = {}) {
    let stopped = false;
    let ready = false;
    let running = null;
    let retryTimer = null;

    function reportPhase(phase) {
        state.startupPhase = String(phase || "initializing");
    }

    function scheduleRetry() {
        if (stopped || ready || retryTimer) return;
        retryTimer = clock.setTimeout(() => {
            retryTimer = null;
            void run();
        }, retryDelayMs);
        retryTimer?.unref?.();
    }

    async function runOnce() {
        state.startupAttempt = Number(state.startupAttempt || 0) + 1;
        state.startupError = "";
        reportPhase("initializing");
        try {
            await initialize({reportPhase, attempt: state.startupAttempt});
            if (stopped) return false;
            ready = true;
            lifecycle.markInfrastructureReady();
            return true;
        } catch (error) {
            if (stopped) return false;
            lifecycle.markInfrastructureFailed(error);
            logger.error(`[startup] 基础设施初始化失败，${retryDelayMs}ms 后重试: ${error?.message || error}`);
            scheduleRetry();
            return false;
        }
    }

    function run() {
        if (stopped || ready) return Promise.resolve(ready);
        if (running) return running;
        running = runOnce().finally(() => { running = null; });
        return running;
    }

    function start() {
        stopped = false;
        return run();
    }

    function stop() {
        stopped = true;
        if (retryTimer) clock.clearTimeout(retryTimer);
        retryTimer = null;
    }

    return {start, stop, isReady: () => ready, isRunning: () => !!running};
}
