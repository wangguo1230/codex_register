// @ts-nocheck
// 统一持有应用级轮询句柄，确保关停时能一次释放且同名任务不会重复注册。

export function createPeriodicTaskRegistry({clock = globalThis, onError = () => {}} = {}) {
    const tasks = new Map();

    function every(name, intervalMs, task) {
        if (tasks.has(name)) return false;
        const timer = clock.setInterval(() => {
            Promise.resolve(task()).catch((error) => onError(name, error));
        }, intervalMs);
        tasks.set(name, timer);
        return true;
    }

    function stop(name) {
        const timer = tasks.get(name);
        if (timer === undefined) return false;
        clock.clearInterval(timer);
        tasks.delete(name);
        return true;
    }

    function stopAll() {
        for (const timer of tasks.values()) clock.clearInterval(timer);
        tasks.clear();
    }

    return {every, stop, stopAll, has: (name) => tasks.has(name), size: () => tasks.size};
}
