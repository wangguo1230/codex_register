// @ts-nocheck
// Token 批次协调器：管理 AT 重登代际、停止状态和 RT 获取维护锁。
import {createChildProcessRegistry} from "./child-process-registry.js";

export function createTokenBatchService({scheduler, store, testAt, testRt, pickAccounts, runPool, effects, childProcesses = createChildProcessRegistry(), now = () => Date.now(), taskStore = null} = {}) {
    let atRunning = false;
    let atStop = false;
    let atGeneration = 0;
    let atProgress = {done: 0, total: 0};
    let distributedRtWorker = null;
    let distributedRtStopped = false;

    const log = (line) => effects.broadcast("log", {id: 0, line, ts: now()});

    function finishAt(generation, {done = 0, total = 0, stopped = false, error = ""} = {}) {
        if (generation !== atGeneration) return;
        atRunning = false;
        atStop = false;
        atProgress = {done, total};
        scheduler.releaseLock("batch-at-relogin");
        effects.broadcast("batchAt", {running: false, done, total});
        effects.info(error
            ? `[批量重登at] 异常结束: ${error}`
            : `[批量重登at] ${stopped ? "已停止" : "结束"} ${done}/${total}`);
        try { scheduler.tick(); } catch { /* */ }
    }

    async function startAt(ids, {relogin = false} = {}) {
        const accounts = await pickAccounts(ids);
        if (!relogin) {
            void runPool(accounts, (account) => testAt(account), 6)
                .catch((error) => effects.warn("[批量AT] 探测异常:", error?.message || error));
            return {ok: true, count: accounts.length};
        }
        if (atRunning) return {error: "已有批量重登在跑,请先点「停止重登」(可强制结束卡住的任务)", status: 409};
        if (scheduler.maintLock && scheduler.maintLock !== "batch-at-relogin") {
            return {error: `有浏览器任务在跑(${scheduler.maintLock}),请等待完成`, status: 409};
        }
        if (scheduler.maintLock === "batch-at-relogin") scheduler.releaseLock("batch-at-relogin");
        if (!accounts.length) return {error: "没有可重登的账号", status: 400};

        const generation = ++atGeneration;
        atRunning = true;
        atStop = false;
        atProgress = {done: 0, total: accounts.length};
        if (!scheduler.acquireLock("batch-at-relogin")) scheduler.maintLock = "batch-at-relogin";
        effects.broadcast("batchAt", {running: true, done: 0, total: accounts.length});
        void (async () => {
            let done = 0;
            try {
                if (scheduler.running.size > 0) {
                    log(`[批量重登at] 等待 ${scheduler.running.size} 个注册任务完成…`);
                    const deadline = now() + 30 * 60_000;
                    while (scheduler.running.size > 0) {
                        if (atStop || generation !== atGeneration) break;
                        if (now() > deadline) {
                            log("[批量重登at] 等注册超时，继续重登");
                            break;
                        }
                        await new Promise((resolve) => setTimeout(resolve, 1000));
                    }
                }
                if (atStop || generation !== atGeneration) {
                    finishAt(generation, {done, total: accounts.length, stopped: true});
                    return;
                }
                await runPool(accounts, async (account) => {
                    if (atStop || generation !== atGeneration) return;
                    try {
                        await testAt((await store.getAccount(account.id)) || account, {
                            relogin: true,
                            onChild: childProcesses.track,
                        });
                    } catch (error) {
                        effects.logAccount(account.id, `[at] 异常: ${error?.message || error}`);
                    }
                    done++;
                    if (generation === atGeneration) {
                        atProgress = {done, total: accounts.length};
                        effects.broadcast("batchAt", {running: true, done, total: accounts.length});
                    }
                }, scheduler.concurrency);
                finishAt(generation, {done, total: accounts.length, stopped: atStop});
            } catch (error) {
                finishAt(generation, {done, total: accounts.length, error: String(error?.message || error)});
            }
        })();
        return {ok: true, count: accounts.length, willWaitReg: scheduler.running.size > 0};
    }

    function atStatus() {
        return {
            ok: true,
            running: atRunning || scheduler.maintLock === "batch-at-relogin",
            done: atProgress.done,
            total: atProgress.total,
            lock: scheduler.maintLock || "",
        };
    }

    function stopAt({force = false} = {}) {
        if (!atRunning && scheduler.maintLock !== "batch-at-relogin") {
            atProgress = {done: 0, total: 0};
            return {ok: true, msg: "当前无批量重登", forced: false, running: false};
        }
        atStop = true;
        if (!force) {
            return {ok: true, msg: "已请求停止(当前号跑完即停；若一直卡住请再点「强制结束」)", forced: false, running: true};
        }
        atGeneration++;
        atRunning = false;
        atStop = false;
        atProgress = {done: 0, total: 0};
        const killed = childProcesses.terminateAll();
        scheduler.releaseLock("batch-at-relogin");
        effects.broadcast("batchAt", {running: false, done: 0, total: 0});
        log(`[批量重登at] 已强制结束（终止 ${killed} 个 worker，可重新开始）`);
        try { scheduler.tick(); } catch { /* */ }
        return {ok: true, msg: "已强制结束批量重登", forced: true, running: false, killed};
    }

    async function startRt(ids, {updateRt = true, acquire = false} = {}) {
        const accounts = await pickAccounts(ids);
        if (taskStore && distributedRtWorker) {
            if (!accounts.length) return {error: "没有可处理的账号", status: 400};
            const tasks = taskStore.enqueueMany
                ? await taskStore.enqueueMany(accounts.map((account) => ({
                    entityId: Number(account.id),
                    payload: {updateRt, acquire},
                    priority: 5,
                })))
                : (await Promise.all(accounts.map((account) => taskStore.enqueue(Number(account.id), {updateRt, acquire})))).filter(Boolean);
            const queued = tasks.map((task) => Number(task.entity_id ?? task.id));
            distributedRtStopped = false;
            distributedRtWorker.start();
            distributedRtWorker.wake();
            log(`[批量RT] 已入分布式队列 ${queued.length}/${accounts.length} 个，并发由各实例自动分片`);
            return {ok: true, count: queued.length, active: accounts.length - queued.length, queued: true};
        }
        if (!acquire) {
            void runPool(accounts, (account) => testRt(account, {updateRt, acquire: false}), 6)
                .catch((error) => effects.warn("[批量RT] 探测异常:", error?.message || error));
            return {ok: true, count: accounts.length};
        }
        if (scheduler.maintLock) return {error: `有浏览器任务在跑(${scheduler.maintLock}),请等待完成`, status: 409};
        scheduler.acquireLock("batch-rt-acquire");
        void (async () => {
            try {
                if (scheduler.running.size > 0) {
                    log(`[rt获取] 等待 ${scheduler.running.size} 个注册任务完成…`);
                    await scheduler.waitRegistrationIdle();
                }
                log(`[rt获取] 开始批量获取 ${accounts.length} 个(并发${scheduler.concurrency})`);
                await runPool(accounts, (account) => testRt(account, {updateRt, acquire: true}), scheduler.concurrency);
                log("[rt获取] 完成");
            } catch (error) {
                effects.warn("[批量RT] 获取异常:", error?.message || error);
            } finally {
                scheduler.releaseLock("batch-rt-acquire");
                scheduler.tick();
            }
        })();
        return {ok: true, count: accounts.length, willWaitReg: scheduler.running.size > 0};
    }

    async function processDistributedRtTask(task, {signal} = {}) {
        if (distributedRtStopped || signal?.aborted) return {stopped: true};
        const account = await store.getAccount(task.entity_id);
        if (!account) return {ok: false, reason: "账号不存在"};
        const payload = typeof task.payload === "string" ? JSON.parse(task.payload || "{}") : (task.payload || {});
        return testRt(account, {
            updateRt: payload.updateRt !== false,
            acquire: payload.acquire === true,
            onProgress: (message) => log(`[批量RT] ${account.email}: ${String(message || "").slice(0, 120)}`),
        });
    }

    function bindDistributedRtWorker(worker) {
        distributedRtWorker = worker;
        return worker;
    }

    function stopDistributedRt() {
        distributedRtStopped = true;
        void distributedRtWorker?.stop?.({waitForIdle: true});
        return {ok: true, running: !!distributedRtWorker?.isBusy?.()};
    }

    return {startAt, atStatus, stopAt, startRt, bindDistributedRtWorker, processDistributedRtTask, stopDistributedRt};
}
