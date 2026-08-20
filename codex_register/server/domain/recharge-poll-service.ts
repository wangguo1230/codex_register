// @ts-nocheck
// 充值轮询应用服务：本次提交后的前台轮询与人工刷新复用同一收敛器。

export function createRechargePollService({store, reconcile, runtime, effects, hasApiKey, isRecoveryRunning = () => false, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), now = () => Date.now()} = {}) {
    let loopPromise = null;
    let loopDirty = false;
    let refreshRunning = 0;
    const withLease = (task) => store.withLease
        ? store.withLease(task)
        : Promise.resolve().then(task).then((value) => ({acquired: true, value}));

    async function runLoopOnce({intervalMs = 30_000, timeoutMs = 20 * 60_000} = {}) {
        const deadline = now() + timeoutMs;
        let completed = false;
        let stopped = false;
        while (now() < deadline) {
            if (isRecoveryRunning()) {
                effects.log("人工恢复残留任务中，停止本轮充值状态轮询");
                stopped = true;
                break;
            }
            if (!hasApiKey()) {
                effects.log("充值平台 API 配置不完整，停止前台轮询；配置后请人工刷新状态");
                stopped = true;
                break;
            }
            if (runtime.isStopped()) {
                effects.log("轮询已停止");
                stopped = true;
                break;
            }
            let leased;
            try {
                leased = await withLease(async () => {
                    const pending = await store.listPending();
                    if (!pending.length) return {pending: 0, settled: 0};
                    return {pending: pending.length, settled: await reconcile(pending)};
                });
            } catch (error) {
                effects.log(`轮询出错: ${error?.message || error}`);
                await sleep(intervalMs);
                continue;
            }
            if (!leased.acquired) {
                await sleep(intervalMs);
                continue;
            }
            if (!leased.value.pending) {
                effects.log("所有任务已到达终态");
                completed = true;
                break;
            }
            await effects.syncAll();
            if (leased.value.settled >= leased.value.pending) {
                effects.log("所有任务已到达终态");
                completed = true;
                break;
            }
            await sleep(intervalMs);
        }
        if (!completed && !stopped && now() >= deadline && (await store.listPending()).length) {
            effects.log("轮询超时(20分钟)，任务保持当前状态；请人工点「刷新状态」继续核对");
        }
    }

    function runLoop(options = {}) {
        if (loopPromise) {
            loopDirty = true;
            return loopPromise;
        }
        loopPromise = (async () => {
            try {
                do {
                    loopDirty = false;
                    await runLoopOnce(options);
                } while (loopDirty);
            } finally {
                loopPromise = null;
            }
        })();
        return loopPromise;
    }

    async function refreshOnce(ids) {
        if (!hasApiKey()) {
            return {error: "充值平台 API 未配置(缺少 Base URL 或 API Key)", status: 400};
        }
        let targets;
        const skipped = [];
        if (ids.length) {
            const rows = store.getMany
                ? await store.getMany(ids)
                : (await Promise.all(ids.map((id) => store.get(id)))).filter(Boolean);
            targets = [];
            for (const item of rows) {
                if (!item.card_code) {
                    skipped.push({email: item.email, reason: `仍是${item.status || "pending"}、无卡密，平台查不到任务`});
                } else if (item.status === "done") {
                    skipped.push({email: item.email, reason: "已完成"});
                } else {
                    targets.push(item);
                }
            }
            if (!targets.length) {
                const message = skipped.map((item) => `${item.email}: ${item.reason}`).join("；") || "无需刷新的队列项";
                effects.log(`刷新跳过: ${message}`);
                // 任务可能已被后台 worker 收敛，前端仍拿着旧行；已完成项不再查平台，但要补一次视图同步。
                if (skipped.length && skipped.every((item) => item.reason === "已完成")) {
                    await effects.syncAll?.().catch?.(() => {});
                    return {ok: true, updated: 0, skipped};
                }
                return {error: message, skipped, status: 400};
            }
        } else {
            targets = await store.listPending();
        }
        if (!targets.length) {
            effects.log("无需刷新的队列项");
            return {ok: true, updated: 0};
        }
        effects.log(`刷新状态: ${targets.length} 个 (${targets.map((item) => item.card_code.slice(0, 8) + "...").join(", ")})`);
        let updated = 0;
        try {
            const leased = await withLease(() => reconcile(targets, {
                    onLookup: (results) => effects.log(`  平台返回 ${results.length} 条结果`),
                    onResult: ({result, item, task}) => {
                        if (!result.ok) {
                            effects.log(`  ${result.redeem_code?.slice(0, 8) || "?"}... 查询失败: ${result.error || "未知"}`);
                            return;
                        }
                        if (!item) return;
                        updated++;
                        if (task.status !== item.task_status) {
                            effects.log(`  ${item.email}: ${item.task_status || "—"} → ${task.status}${task.message ? " (" + task.message + ")" : ""}`);
                        }
                    },
                    onUnmatched: ({result, task}) => effects.log(
                        `  平台返回卡密 [${result.redeem_code}] 未匹配到队列(状态: ${task.status}, 本地存储: ${targets.map((item) => item.card_code).join(",")})`,
                    ),
                }));
            if (!leased.acquired) {
                return {error: "其他实例正在刷新充值任务，请稍后重试", status: 409};
            }
        } catch (error) {
            effects.log(`刷新出错: ${error?.message || error}`);
            return {error: `刷新失败: ${error?.message || error}`, status: 500};
        }
        effects.log(`刷新完成: ${updated} 个已更新`);
        await effects.syncAll();
        return {ok: true, updated};
    }

    async function refresh(ids) {
        if (isRecoveryRunning()) return {error: "正在人工恢复残留任务", status: 409};
        refreshRunning++;
        try {
            return await refreshOnce(ids);
        } finally {
            refreshRunning--;
        }
    }

    return {
        runLoop,
        refresh,
        isLoopRunning: () => !!loopPromise,
        isRunning: () => !!loopPromise || refreshRunning > 0,
    };
}
