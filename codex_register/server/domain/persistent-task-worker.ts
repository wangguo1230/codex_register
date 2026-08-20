// @ts-nocheck
// 通用持久化任务执行器：每个实例只处理自己的租约，旧租约不能覆盖新结果。
import {normalizeConcurrency} from "./concurrency.js";

export function createPersistentTaskWorker({
    kind,
    instanceId,
    concurrency = () => 1,
    pollMs = 500,
    leaseMs = 120_000,
    claim,
    heartbeat,
    complete,
    fail,
    release,
    cancel,
    execute,
    onTaskStart = () => {},
    onTaskFinish = () => {},
    onChange = () => {},
    now = () => Date.now(),
} = {}) {
    const active = new Map();
    let timer = null;
    let pumping = false;
    let started = false;
    let stopping = false;
    const idleWaiters = new Set();

    const limit = () => normalizeConcurrency(typeof concurrency === "function" ? concurrency() : concurrency);
    const notify = () => {
        try { onChange({kind, active: active.size, running: started && !stopping}); } catch { /* 状态通知不应影响任务 */ }
        if (active.size || pumping) return;
        for (const resolve of idleWaiters) resolve(true);
        idleWaiters.clear();
    };
    const schedule = () => {
        if (!started || stopping || timer) return;
        timer = setTimeout(() => {
            timer = null;
            void pump();
        }, Math.max(50, Number(pollMs) || 500));
        timer?.unref?.();
    };

    async function runTask(task) {
        const controller = new AbortController();
        const key = Number(task.id);
        const entry = {task, controller, heartbeatTimer: null, stopRequested: false};
        active.set(key, entry);
        try { onTaskStart(task); } catch { /* */ }
        entry.heartbeatTimer = setInterval(() => {
            void heartbeat(task, leaseMs).catch(() => {});
        }, Math.max(5_000, Math.min(30_000, Math.floor(Number(leaseMs) / 3) || 20_000)));
        entry.heartbeatTimer?.unref?.();
        notify();
        try {
            const result = await execute(task, {signal: controller.signal, instanceId, kind});
            if (controller.signal.aborted && entry.stopRequested) {
                await release(task, "实例停止，任务退回排队").catch(() => {});
            } else {
                await complete(task, result).catch((error) => {
                    throw new Error(`任务完成写回失败: ${error?.message || error}`, {cause: error});
                });
            }
        } catch (error) {
            if (controller.signal.aborted && entry.stopRequested) {
                await release(task, "实例停止，任务退回排队").catch(() => {});
            } else {
                await fail(task, error).catch(() => {});
            }
        } finally {
            clearInterval(entry.heartbeatTimer);
            active.delete(key);
            try { onTaskFinish(task); } catch { /* */ }
            notify();
            if (started && !stopping) void pump();
        }
    }

    async function pump() {
        if (!started || stopping || pumping) return;
        pumping = true;
        try {
            const free = Math.max(0, limit() - active.size);
            if (!free) return;
            const tasks = await claim(free, leaseMs);
            for (const task of tasks || []) {
                if (stopping) {
                    await release(task, "实例停止，任务退回排队").catch(() => {});
                    continue;
                }
                void runTask(task);
            }
        } catch (error) {
            try { onChange({kind, error}); } catch { /* */ }
        } finally {
            pumping = false;
            notify();
            if (started && !stopping && active.size < limit()) schedule();
        }
    }

    function start() {
        if (started) return false;
        started = true;
        stopping = false;
        void pump();
        return true;
    }

    async function waitForIdle({timeoutMs = 0} = {}) {
        if (!active.size && !pumping) return true;
        return new Promise((resolve) => {
            let timer = null;
            const done = (value) => {
                if (timer) clearTimeout(timer);
                idleWaiters.delete(done);
                resolve(value);
            };
            idleWaiters.add(done);
            if (timeoutMs > 0) {
                timer = setTimeout(() => done(false), timeoutMs);
                timer?.unref?.();
            }
        });
    }

    async function stop({waitForIdle: wait = true, timeoutMs = 15_000} = {}) {
        if (!started) return {active: 0};
        stopping = true;
        if (timer) clearTimeout(timer);
        timer = null;
        for (const entry of active.values()) {
            entry.stopRequested = true;
            try { entry.controller.abort(new Error("任务执行器停止")); } catch { /* */ }
        }
        if (wait) await waitForIdle({timeoutMs});
        started = false;
        stopping = false;
        notify();
        return {active: active.size};
    }

    function wake() {
        if (!started || stopping) return false;
        void pump();
        return true;
    }

    async function cancelEntity(entityId) {
        const task = [...active.values()].find((entry) => Number(entry.task.entity_id) === Number(entityId))?.task;
        if (!task) return false;
        await cancel(task);
        const entry = active.get(Number(task.id));
        try { entry?.controller.abort(new Error("任务已取消")); } catch { /* */ }
        return true;
    }

    return {
        start,
        stop,
        wake,
        pump,
        waitForIdle,
        cancelEntity,
        isBusy: () => active.size > 0 || pumping,
        activeCount: () => active.size,
        isRunning: () => started && !stopping,
        state: () => ({kind, running: started && !stopping, active: active.size}),
    };
}
