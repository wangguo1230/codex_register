// @ts-nocheck

// 只管理本进程当前执行中的充值操作。历史任务恢复必须由控制台人工触发。
export function createRechargeLifecycle({relogin, batch, exports, rebind, workers = []} = {}) {
    function start() {
        for (const worker of workers) worker?.start?.();
        rebind?.start?.();
        return true;
    }

    async function stop({waitForIdle = false, timeoutMs = 15_000} = {}) {
        relogin?.requestStop?.();
        batch?.requestStop?.();
        exports?.requestStop?.();
        rebind?.requestStop?.();
        for (const worker of workers) worker?.stop?.({waitForIdle: false});
        rebind?.stop?.({waitForIdle: false});
        const rebindIdle = waitForIdle && rebind?.waitForIdle
            ? await rebind.waitForIdle({timeoutMs})
            : undefined;
        return {rebindIdle};
    }

    return {start, stop};
}
