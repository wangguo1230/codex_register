// @ts-nocheck
// 子进程终止策略：先 TERM，宽限期后 KILL；detached worker 可按进程组清理后代。

export function signalChildProcess(child, signal = "SIGTERM", {tree = false} = {}) {
    if (!child) return false;
    try {
        if (tree && process.platform !== "win32" && child.pid) process.kill(-child.pid, signal);
        else child.kill?.(signal);
        return true;
    } catch {
        try {
            child.kill?.(signal);
            return true;
        } catch {
            return false;
        }
    }
}

export function terminateChildProcess(child, {
    graceMs = 12_000,
    tree = false,
    clock = globalThis,
} = {}) {
    signalChildProcess(child, "SIGTERM", {tree});
    const timer = clock.setTimeout(() => {
        signalChildProcess(child, "SIGKILL", {tree});
    }, Math.max(1_000, Number(graceMs) || 12_000));
    timer?.unref?.();
    return () => clock.clearTimeout(timer);
}
