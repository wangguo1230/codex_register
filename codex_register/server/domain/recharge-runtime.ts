// @ts-nocheck

function createCoalescedSync(load, publish) {
    let running = null;
    let dirty = false;
    const sync = async () => {
        if (running) {
            dirty = true;
            return running;
        }
        running = (async () => {
            do {
                dirty = false;
                publish(await load());
            } while (dirty);
        })();
        try {
            await running;
        } finally {
            running = null;
        }
    };
    return sync;
}

function createScheduledSync(sync, {
    delayMs = 100,
    minIntervalMs = 5_000,
    now = () => Date.now(),
    clock = globalThis,
    onError = () => {},
} = {}) {
    let timer = null;
    let active = null;
    let dirty = false;
    let lastRunAt = 0;

    const arm = () => {
        if (timer || active || !dirty) return;
        const wait = Math.max(delayMs, minIntervalMs - Math.max(0, now() - lastRunAt));
        timer = clock.setTimeout(() => {
            timer = null;
            if (!dirty) return;
            dirty = false;
            const task = Promise.resolve().then(sync);
            const completed = task.finally(() => {
                lastRunAt = now();
                if (active === completed) active = null;
                arm();
            });
            active = completed;
            void completed.catch(onError);
        }, wait);
        timer?.unref?.();
    };
    const schedule = () => {
        dirty = true;
        arm();
    };
    const flush = async () => {
        if (timer) clock.clearTimeout(timer);
        timer = null;
        if (active) {
            dirty = true;
            await active;
            if (timer) clock.clearTimeout(timer);
            timer = null;
        }
        dirty = false;
        await sync();
        lastRunAt = now();
    };
    const stop = () => {
        if (timer) clock.clearTimeout(timer);
        timer = null;
        dirty = false;
    };
    return {schedule, flush, stop};
}

export function createRechargeRuntime({store, jobs, publish, syncSchedule} = {}) {
    const syncCards = createCoalescedSync(store.listCards, (data) => publish("recharge", data));
    const syncQueue = createCoalescedSync(store.listQueue, (data) => publish("rechargeQueue", data));
    const jobState = () => {
        const reloginRunning = jobs.reloginRunning();
        const batchRunning = jobs.batchRunning();
        return {
            submit: batchRunning && !reloginRunning,
            reloginSubmit: reloginRunning && batchRunning,
            relogin: reloginRunning && !batchRunning,
            exportRt: jobs.exportRunning(),
        };
    };
    const broadcastJobs = () => {
        try { publish("rechargeJobs", jobState()); } catch { /* */ }
    };
    const syncAll = async () => {
        await Promise.all([syncQueue(), syncCards()]);
    };
    const scheduled = createScheduledSync(syncAll, syncSchedule);
    return {
        syncCards,
        syncQueue,
        syncAll,
        scheduleAll: scheduled.schedule,
        flushAll: scheduled.flush,
        stopScheduledSync: scheduled.stop,
        jobState,
        broadcastJobs,
    };
}
