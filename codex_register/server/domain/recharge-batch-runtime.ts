// @ts-nocheck
// 充值批次进程内运行态：代际锁防止旧批次释放新批次。
export function createRechargeBatchRuntime({onChange = () => {}, now = () => Date.now()} = {}) {
    let running = false;
    let stopped = false;
    let generation = 0;
    let startedAt = 0;

    const changed = () => { try { onChange(); } catch { /* 状态通知不影响任务 */ } };
    const begin = () => {
        running = true;
        stopped = false;
        startedAt = now();
        generation++;
        changed();
        return generation;
    };
    const end = (ownerGeneration) => {
        if (ownerGeneration !== generation) return false;
        running = false;
        stopped = false;
        changed();
        return true;
    };
    const requestStop = (ownerGeneration) => {
        if (ownerGeneration !== undefined && ownerGeneration !== generation) return false;
        stopped = true;
        changed();
        return true;
    };
    const forceUnlock = () => {
        running = false;
        changed();
    };
    return {
        begin,
        end,
        requestStop,
        forceUnlock,
        isRunning: () => running,
        isStopped: (ownerGeneration) => ownerGeneration === undefined
            ? stopped
            : ownerGeneration !== generation || stopped,
        elapsedMs: () => startedAt ? Math.max(0, now() - startedAt) : 0,
        snapshot: () => ({running, stopped, generation, startedAt}),
    };
}
