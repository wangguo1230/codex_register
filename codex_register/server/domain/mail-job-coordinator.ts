// @ts-nocheck
// 邮箱任务协调器：管理停止状态、槽位、认领、实例心跳、窗口预算和批次续跑。
import {
    ensureBitWindowBudget,
    isBitLoggedOut,
    listAllBitWindows,
    listAutomationBitWindows,
    markBitLoggedOut,
    setExpectedBitTiles,
    stopAutomationBitWindows,
} from "../../src/bitbrowser.js";
import {
    clearMailboxJobStop,
    isMailboxJobStopped,
    mailJobInCritical,
    requestMailboxJobStop,
} from "../../src/mail/mailbox-job-stop.js";
import {needsHardenRetry, planHardenSkip} from "../../src/mail/google-state.js";
import {createMailJobCapacityPolicy} from "./mail-job-capacity-policy.js";
import {createMailJobInstanceReporter} from "./mail-job-instance-reporter.js";
import {buildMailJobSnapshot} from "./mail-job-snapshot.js";

const defaultBitRuntime = {
    ensureWindowBudget: ensureBitWindowBudget,
    isLoggedOut: isBitLoggedOut,
    listAllWindows: listAllBitWindows,
    listAutomationWindows: listAutomationBitWindows,
    markLoggedOut: markBitLoggedOut,
    setExpectedTiles: setExpectedBitTiles,
    stopAutomationWindows: stopAutomationBitWindows,
};

const defaultStopRuntime = {
    clear: clearMailboxJobStop,
    isStopped: isMailboxJobStopped,
    isCritical: mailJobInCritical,
    request: requestMailboxJobStop,
};

export function createMailJobCoordinator({
    store,
    scheduler,
    jumpPool,
    maxExitsPerJump,
    executeJob,
    effects,
    instanceId,
    isHttpReady,
    isShuttingDown,
    bitRuntime = defaultBitRuntime,
    stopRuntime = defaultStopRuntime,
    now = () => Date.now(),
} = {}) {
    let stopped = false;
    let windows = [];
    let progress = null;
    let instances = [];
    let broadcastTimer = null;
    let tickBusy = false;
    let bitParkAnnounced = false;
    let lastBitBudgetAt = 0;
    const abortControllers = new Map();
    const current = new Map();
    const localMailboxIds = new Set();
    const capacityPolicy = createMailJobCapacityPolicy({
        scheduler,
        jumpPool,
        maxExitsPerJump,
        localRunningCount: () => localMailboxIds.size,
        effects,
        now,
    });
    const instanceReporter = createMailJobInstanceReporter({
        store,
        scheduler,
        instanceId,
        localRunningCount: () => localMailboxIds.size,
        isLocallyStopped: () => stopped || stopRuntime.isStopped(),
    });

    const snapshot = () => buildMailJobSnapshot({progress, windows, instances, instanceId});

    const stateExtras = () => {
        const job = snapshot();
        return {batchPw: job, batchHarden: job, mailJob: job, mailInstances: instances};
    };

    const broadcast = () => {
        effects.broadcast("batchHarden", {...snapshot(), proxyPool: scheduler.mailProxyPoolSnap()});
    };

    const scheduleBroadcast = () => {
        if (broadcastTimer) return;
        broadcastTimer = setTimeout(() => {
            broadcastTimer = null;
            broadcast();
        }, 350);
    };

    async function reportInstance() {
        instances = await instanceReporter.report();
    }

    async function heartbeat() {
        await Promise.all([
            store.heartbeat(instanceId, [...localMailboxIds]),
            reportInstance(),
        ]);
    }

    async function begin() {
        stopRuntime.clear();
        stopped = false;
        await store.setClaimPaused(false);
    }

    function startPaused() {
        stopped = true;
    }

    function afterEnqueue() {
        store.progress().then((value) => {
            progress = value;
            progress.paused = false;
            scheduleBroadcast();
        }).catch(() => {});
        tick().catch(() => {});
    }

    function requestStop() {
        stopped = true;
        stopRuntime.request();
    }

    async function stopAll() {
        requestStop();
        await store.setClaimPaused(true);
        const canceled = await store.cancelPending("").catch(() => 0);
        for (const controller of abortControllers.values()) {
            try { controller.abort(); } catch { /* */ }
        }
        progress = await store.progress().catch(() => progress);
        if (progress) progress.paused = true;
        await reportInstance().catch(() => {});
        broadcast();

        void (async () => {
            const startedAt = now();
            while (localMailboxIds.size && now() - startedAt < 70_000) {
                if (!stopRuntime.isCritical() && now() - startedAt > 3_000) break;
                await new Promise((resolve) => setTimeout(resolve, 400));
            }
            const closed = await bitRuntime.stopAutomationWindows({includeClosed: true, log: effects.log});
            effects.log(`[整备] 停止收尾关窗 ${closed} 进行中=${localMailboxIds.size}`);
            await refreshWindows();
            await reportInstance().catch(() => {});
            broadcast();
        })().catch((error) => effects.warn("[mail-jobs] 停止收尾失败:", error?.message || error));
        return {ok: true, closed: 0, canceled, draining: true};
    }

    function freeSlots() {
        return capacityPolicy.freeSlots();
    }

    async function claimSlots() {
        return capacityPolicy.claimSlots();
    }

    async function parkForBitDown(reason) {
        bitRuntime.markLoggedOut(true);
        const count = await store.requeueRunning(instanceId, "比特掉登录，退回排队").catch(() => 0);
        for (const controller of abortControllers.values()) {
            try { controller.abort(); } catch { /* */ }
        }
        if (!bitParkAnnounced) {
            effects.warn(`[mail-jobs] 比特不可用，已领任务退回排队（不当失败）: ${String(reason || "").slice(0, 120)} n=${count}`);
            bitParkAnnounced = true;
        }
        scheduleBroadcast();
    }

    async function tick() {
        if (!isHttpReady() || stopped || stopRuntime.isStopped() || tickBusy || isShuttingDown()) return;
        tickBusy = true;
        try {
            if (bitRuntime.isLoggedOut()) {
                try {
                    await bitRuntime.listAllWindows({force: true});
                    if (!bitRuntime.isLoggedOut()) {
                        const restored = await store.requeueRecentBitFailures().catch(() => []);
                        bitParkAnnounced = false;
                        if (restored.length) effects.log(`[mail-jobs] 比特已恢复，误失败 ${restored.length} 个重新排队`);
                    }
                } catch { /* 仍未登录 */ }
            }
            if (now() - lastBitBudgetAt > 45_000 && !bitRuntime.isLoggedOut()) {
                lastBitBudgetAt = now();
                const proxy = scheduler.mailProxyPoolSnap();
                bitRuntime.setExpectedTiles(Math.max(1, Math.min(scheduler.pwConcurrency || 1, proxy.slots || 1)));
                const swept = await bitRuntime.ensureWindowBudget({log: effects.log});
                if (swept) effects.log(`[指纹] 本轮清超额 ${swept} 个`);
            }
            await store.reclaimStale(3 * 60 * 1000);
            const timedOut = await store.failTimedOut(22 * 60 * 1000);
            for (const item of timedOut) {
                if (item.instance_id === instanceId) {
                    try { abortControllers.get(item.mailbox_id)?.abort(); } catch { /* */ }
                }
            }
            progress = await store.progress();
            progress.paused = await store.isClaimPaused();
            await reportInstance();
            if (progress.paused) {
                scheduleBroadcast();
                return;
            }

            const bitDown = bitRuntime.isLoggedOut();
            const slots = bitDown ? freeSlots() : await claimSlots();
            if (!slots) {
                scheduleBroadcast();
                return;
            }
            const capacity = capacityPolicy.capacity();
            bitRuntime.setExpectedTiles(capacity);
            const jobs = await store.claim(instanceId, slots, bitDown ? "pw" : "", capacity);
            if (!jobs.length) {
                scheduleBroadcast();
                return;
            }
            effects.log(`[mail-jobs] ${instanceId} 认领 ${jobs.length} 个（本机空位 ${slots}）`);
            for (const job of jobs) executeJob(job);
            progress = await store.progress();
            scheduleBroadcast();
        } catch (error) {
            effects.warn("[mail-jobs] tick 失败:", error?.message || error);
        } finally {
            tickBusy = false;
        }
    }

    async function refreshWindows({listBit = true} = {}) {
        if (listBit) {
            try { windows = await bitRuntime.listAutomationWindows(); } catch { /* 沿用上次 */ }
        }
        try { progress = await store.progress(); } catch { /* 表未就绪 */ }
        const open = windows.filter((window) => window.status === 1);
        if (progress?.running || open.length || progress?.done) scheduleBroadcast();
    }

    async function refreshState() {
        progress = await store.progress();
        progress.paused = await store.isClaimPaused();
        instances = await store.listInstances();
    }

    async function startHarden(ids) {
        const selected = (ids || []).map(Number).filter(Number.isInteger);
        if (!selected.length) return {error: "未选择邮箱"};
        const mailboxes = (await Promise.all(selected.map((id) => store.getMailbox(id))))
            .filter((mailbox) => mailbox && mailbox.provider === "google" && !(mailbox.deleted_at > 0));
        if (!mailboxes.length) return {error: "选中项没有 Gmail"};
        await begin();
        const enqueued = await store.enqueue(
            mailboxes.map((mailbox) => ({id: mailbox.id, email: mailbox.email})),
            "harden",
        );
        const proxy = scheduler.mailProxyPoolSnap();
        progress = await store.progress();
        broadcast();
        tick().catch(() => {});
        return {
            ok: true,
            queued: true,
            count: enqueued.inserted,
            skipped: mailboxes.length - enqueued.inserted,
            batchId: enqueued.batchId,
            concurrency: capacityPolicy.capacity(),
            proxies: proxy.total || proxy.slots,
            instanceId,
        };
    }

    async function resume({onlyError = false, ids = null} = {}) {
        const scoped = Array.isArray(ids) && ids.length;
        const recovered = onlyError ? 0 : await store.recoverInterrupted(
            scoped ? ids : null,
            {excludeMailboxIds: [...localMailboxIds]},
        ).catch((error) => {
            effects.warn("[mail-jobs] 人工恢复残留任务失败:", error?.message || error);
            return 0;
        });
        if (recovered) effects.log(`[mail-jobs] 人工恢复 ${recovered} 个失联 running，已退回排队`);
        await begin();
        const dropped = await store.cancelUsablePending().catch(() => 0);
        if (dropped) effects.log(`[mail-jobs] 继续完成：撤掉 ${dropped} 个已整备（2FA+IMAP）的排队`);
        let candidates = onlyError
            ? await store.listNewestErrors("harden").catch(() => [])
            : await store.listResumable({
                kinds: ["harden", "pw", "2fa"],
                onlyError: false,
                since: scoped ? 0 : now() - 3 * 60 * 60 * 1000,
            }).catch(() => []);
        if (scoped) {
            const selected = new Set(ids.map(Number).filter(Number.isInteger));
            candidates = candidates.filter((item) => selected.has(item.id));
        }

        const harden = [];
        const passwords = [];
        const totps = [];
        let skippedDone = 0;
        const seen = new Set();
        for (const item of candidates) {
            const mailbox = await store.getMailbox(item.id);
            if (!mailbox || mailbox.deleted_at > 0) continue;
            if (item.kind === "harden") {
                if (mailbox.provider !== "google") continue;
                if (mailbox.google_stage === "blocked" || mailbox.google_stage === "gpt_ok") continue;
                if (planHardenSkip(mailbox).usable) {
                    skippedDone++;
                    continue;
                }
                if (!needsHardenRetry(mailbox)) continue;
                harden.push(mailbox);
                seen.add(mailbox.id);
            } else if (item.kind === "pw") {
                passwords.push(mailbox);
            } else if (item.kind === "2fa" && mailbox.provider === "google") {
                totps.push(mailbox);
            }
        }
        if (!onlyError && scoped) {
            const gaps = await store.listHardenGaps(ids).catch(() => []);
            for (const mailbox of gaps) {
                if (seen.has(mailbox.id) || !needsHardenRetry(mailbox)) continue;
                harden.push(mailbox);
                seen.add(mailbox.id);
            }
        }
        if (!harden.length && !passwords.length && !totps.length) {
            if (recovered) {
                progress = await store.progress();
                broadcast();
                tick().catch(() => {});
                return {ok: true, queued: true, count: recovered, recovered, skippedDone};
            }
            return {
                ok: true,
                count: 0,
                skippedDone,
                msg: onlyError
                    ? (skippedDone
                        ? `任务条上这批失败里有 ${skippedDone} 个 2FA+IMAP 已齐，无需再跑`
                        : "当前这批没有仍需重跑的失败")
                    : "没有可续跑的任务",
            };
        }
        let inserted = 0;
        if (harden.length) {
            inserted += (await store.enqueue(harden.map((mailbox) => ({id: mailbox.id, email: mailbox.email})), "harden")).inserted;
        }
        if (passwords.length) {
            inserted += (await store.enqueue(passwords.map((mailbox) => ({
                id: mailbox.id,
                email: mailbox.email,
                payload: {oldPw: mailbox.password},
            })), "pw")).inserted;
        }
        if (totps.length) {
            inserted += (await store.enqueue(totps.map((mailbox) => ({id: mailbox.id, email: mailbox.email})), "2fa")).inserted;
        }
        progress = await store.progress();
        broadcast();
        tick().catch(() => {});
        return {ok: true, queued: true, count: inserted + recovered, recovered, skippedDone};
    }

    return {
        begin,
        startPaused,
        afterEnqueue,
        stopAll,
        requestStop,
        tick,
        refreshWindows,
        refreshState,
        startHarden,
        resume,
        parkForBitDown,
        reportInstance,
        heartbeat,
        scheduleBroadcast,
        snapshot,
        stateExtras,
        getInstances: () => instances,
        hasBusyWork: () => !!(progress?.running || windows.some((window) => window.status === 1) || localMailboxIds.size),
        isStopped: () => stopped || stopRuntime.isStopped(),
        runtime: {abortControllers, current, localMailboxIds},
    };
}
