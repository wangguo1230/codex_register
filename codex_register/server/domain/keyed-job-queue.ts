// @ts-nocheck
// 进程内按业务主键串行的并发队列。一个 key 同时最多执行一次。

export function createKeyedJobQueue({
    concurrency = () => 1,
    execute,
    onError = () => {},
} = {}) {
    const pending = [];
    const queued = new Set();
    const active = new Set();
    const cancelled = new Set();
    const metadata = new Map();
    const controllers = new Map();
    const idleWaiters = new Set();

    function limit() {
        return Math.max(1, Number(typeof concurrency === "function" ? concurrency() : concurrency) || 1);
    }

    function clear(id) {
        queued.delete(id);
        cancelled.delete(id);
        metadata.delete(id);
    }

    function notifyIdle() {
        if (queued.size || active.size) return;
        for (const resolve of idleWaiters) resolve(true);
        idleWaiters.clear();
    }

    function pump() {
        while (active.size < limit() && pending.length) {
            const id = pending.shift();
            if (!queued.has(id) || active.has(id)) continue;
            active.add(id);
            const controller = new AbortController();
            controllers.set(id, controller);
            Promise.resolve()
                .then(() => execute(id, metadata.get(id), {signal: controller.signal}))
                .catch((error) => onError(id, error))
                .finally(() => {
                    active.delete(id);
                    controllers.delete(id);
                    clear(id);
                    pump();
                    notifyIdle();
                });
        }
    }

    function enqueue(id, value) {
        if (!Number.isInteger(id) || queued.has(id) || active.has(id)) return false;
        cancelled.delete(id);
        queued.add(id);
        metadata.set(id, value);
        pending.push(id);
        pump();
        return true;
    }

    function cancel(id) {
        if (!queued.has(id) && !active.has(id)) return {found: false, active: false};
        cancelled.add(id);
        const index = pending.indexOf(id);
        if (index >= 0) pending.splice(index, 1);
        const running = active.has(id);
        if (running) controllers.get(id)?.abort(new Error("任务已取消"));
        if (!running) {
            clear(id);
            notifyIdle();
        }
        return {found: true, active: running};
    }

    function cancelAll() {
        const ids = [...new Set([...pending, ...active])];
        let running = 0;
        for (const id of ids) {
            const result = cancel(id);
            if (result.active) running++;
        }
        return {count: ids.length, active: running};
    }

    function waitForIdle({timeoutMs = 0} = {}) {
        if (!queued.size && !active.size) return Promise.resolve(true);
        return new Promise((resolve) => {
            let timer = null;
            const finish = (idle) => {
                if (timer) clearTimeout(timer);
                idleWaiters.delete(finish);
                resolve(idle);
            };
            idleWaiters.add(finish);
            if (timeoutMs > 0) {
                timer = setTimeout(() => finish(false), timeoutMs);
                timer?.unref?.();
            }
        });
    }

    return {
        enqueue,
        cancel,
        cancelAll,
        pump,
        isCancelled: (id) => cancelled.has(Number(id)),
        isQueued: (id) => queued.has(Number(id)),
        isActive: (id) => active.has(Number(id)),
        has: (id) => queued.has(Number(id)) || active.has(Number(id)),
        getMetadata: (id) => metadata.get(Number(id)),
        getSignal: (id) => controllers.get(Number(id))?.signal || null,
        activeCount: () => active.size,
        size: () => queued.size,
        waitForIdle,
    };
}
