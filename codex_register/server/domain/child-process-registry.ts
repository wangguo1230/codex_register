// @ts-nocheck
// 按业务操作跟踪子进程；停止时先优雅终止，超时后强杀，避免跨模块共享全局子进程集合。

export function createChildProcessRegistry({graceMs = 12_000, clock = globalThis, signal} = {}) {
    const children = new Map();

    function drop(child) {
        const timer = children.get(child);
        if (timer) clock.clearTimeout(timer);
        children.delete(child);
    }

    function track(child) {
        if (!child || children.has(child)) return false;
        children.set(child, null);
        child.once?.("close", () => drop(child));
        child.once?.("exit", () => drop(child));
        if (signal?.aborted) {
            try { child.kill?.("SIGTERM"); } catch { /* */ }
            const timer = clock.setTimeout(() => {
                try { child.kill?.("SIGKILL"); } catch { /* */ }
                drop(child);
            }, Math.max(1_000, Number(graceMs) || 12_000));
            timer?.unref?.();
            children.set(child, timer);
        }
        return true;
    }

    function terminateAll(signal = "SIGTERM") {
        const active = [...children.keys()];
        for (const child of active) {
            try { child.kill?.(signal); } catch { /* 子进程可能已经退出 */ }
            if (!children.has(child)) continue;
            const timer = clock.setTimeout(() => {
                try { child.kill?.("SIGKILL"); } catch { /* */ }
                drop(child);
            }, Math.max(1_000, Number(graceMs) || 12_000));
            timer?.unref?.();
            children.set(child, timer);
        }
        return active.length;
    }

    function clear() {
        for (const child of [...children.keys()]) drop(child);
    }

    const onAbort = () => terminateAll("SIGTERM");
    if (signal?.aborted) onAbort();
    else signal?.addEventListener?.("abort", onAbort, {once: true});

    function dispose() {
        signal?.removeEventListener?.("abort", onAbort);
    }

    return {track, terminateAll, clear, dispose, size: () => children.size};
}
