// @ts-nocheck

export function createMailJobCapacityPolicy({scheduler, jumpPool, maxExitsPerJump, localRunningCount, effects, now = () => Date.now()} = {}) {
    let jumpGateWarned = false;

    function capacity() {
        const proxy = scheduler.mailProxyPoolSnap();
        return Math.max(1, Math.min(scheduler.pwConcurrency || 1, proxy.slots || 1));
    }

    function freeSlots() {
        return Math.max(0, capacity() - localRunningCount());
    }

    async function claimSlots() {
        const free = freeSlots();
        const configured = (scheduler.collectJumpLines() || []).filter(Boolean).length;
        if (!configured) return free;
        const urls = jumpPool.urls || [];
        if (!urls.length) {
            if (!jumpGateWarned) effects.warn("[mail-jobs] 跳板已配置但没有可用本地端口，本机不领整备");
            jumpGateWarned = true;
            return 0;
        }
        const healthStates = await Promise.all(urls.map(async (url) => {
            let health = jumpPool.health.get(url);
            if (!health || now() - (health.at || 0) > 90_000) health = await jumpPool.checkOne(url);
            return health;
        }));
        const healthy = healthStates.filter((health) => health?.ok).length;
        if (!healthy) {
            if (!jumpGateWarned) effects.warn("[mail-jobs] 跳板探测全失败，本机不领整备");
            jumpGateWarned = true;
            return 0;
        }
        jumpGateWarned = false;
        return Math.max(0, Math.min(free, healthy * maxExitsPerJump - localRunningCount()));
    }

    return {capacity, freeSlots, claimSlots};
}
