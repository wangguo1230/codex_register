export function startSchedulerPollLoop({tick, isActive, intervalMs = 3000, clock = globalThis} = {}) {
    const timer = clock.setInterval(() => {
        if (isActive()) void Promise.resolve(tick()).catch(() => {});
    }, intervalMs);
    timer?.unref?.();
    return () => clock.clearInterval(timer);
}
