// @ts-nocheck

export function createMailJobInstanceReporter({store, scheduler, instanceId, localRunningCount, isLocallyStopped} = {}) {
    async function report() {
        const proxy = scheduler.mailProxyPoolSnap();
        const paused = await store.isClaimPaused().catch(() => false);
        await store.upsertInstance(instanceId, {
            stopClaim: paused || isLocallyStopped(),
            proxySlots: proxy.slots || 0,
            proxyLeased: proxy.leased || 0,
            runningJobs: localRunningCount(),
        });
        return store.listInstances();
    }

    return {report};
}
