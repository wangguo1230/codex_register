// @ts-nocheck
// 充值队列导出应用服务：格式化、RT 获取、sub2json、停止和套餐查询。
import {createChildProcessRegistry} from "./child-process-registry.js";
import {createRechargePlanProbeService} from "./recharge-plan-probe-service.js";
import {createRechargeDistributedRtExport} from "./recharge-distributed-rt-export.js";
import {createRechargeRtExportRunner} from "./recharge-rt-export-runner.js";
import {normalizeConcurrency} from "./concurrency.js";

export function createRechargeExportService({store, credentials, formatLine, rtAcquire, distributedRt = null, sub2json, plans, config, effects, isRechargeOperationRunning = () => false, isRecoveryRunning = () => false, isRebindRunning = () => false, childProcesses = createChildProcessRegistry(), now = () => new Date(), sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))} = {}) {
    let running = false;
    let stopped = false;
    let partialSub2jsonRunning = false;

    const safeLog = (line) => {
        try { effects.log(line); } catch { /* 日志失败不能打断后台作业收尾 */ }
    };
    const notifyReady = (payload) => {
        try {
            effects.ready(payload);
        } catch (error) {
            safeLog(`导出结果通知失败: ${String(error?.message || error).slice(0, 140)}`);
        }
    };
    const runDetached = (task, label) => {
        void task.catch((error) => {
            safeLog(`${label}后台任务异常: ${String(error?.message || error).slice(0, 160)}`);
        });
    };
    const planProbe = createRechargePlanProbeService({store, credentials, plans, config, effects});

    const exportRtOf = (row) => {
        if (row.refresh_token) return String(row.refresh_token);
        return credentials.extractTokens(credentials.readJson(row.rt_file) || credentials.readJson(row.gpt_auth_file))?.refreshToken || "";
    };
    const hasRt = (row) => !!exportRtOf(row);
    const distributedRtExport = distributedRt
        ? createRechargeDistributedRtExport({
            store,
            distributedRt,
            hasRt,
            sleep,
            maxWaitMs: Number(process.env.RT_DISTRIBUTED_WAIT_MS || 30 * 60_000),
            log: safeLog,
        })
        : null;
    const isRunning = () => running || partialSub2jsonRunning;
    const notifyJobsChanged = () => {
        try { effects.jobsChanged(); } catch (error) {
            safeLog(`刷新导出运行状态失败: ${String(error?.message || error).slice(0, 120)}`);
        }
    };
    const setRunning = (value) => {
        running = value;
        notifyJobsChanged();
    };
    const setPartialSub2jsonRunning = (value) => {
        partialSub2jsonRunning = value;
        notifyJobsChanged();
    };
    const rtExportRunner = createRechargeRtExportRunner({
        store,
        formatLine,
        formatRt: exportRtOf,
        rtAcquire,
        distributedRtExport,
        hasRt,
        effects,
        notifyReady,
        setRunning,
    });
    const reserveExport = () => {
        if (isRunning()) return false;
        setRunning(true);
        stopped = false;
        return true;
    };

    function attachChild(child) {
        if (!isRunning() || !child) return;
        childProcesses.track(child);
        if (stopped) childProcesses.terminateAll();
    }

    async function exportQueue(options = {}) {
        const ids = (options.ids || []).map(Number).filter(Number.isInteger);
        const batch = options.batch || "";
        const format = options.format || "account";
        const needsRtWork = !["account", "card", "session", "sub2json"].includes(format);
        if (!ids.length && !batch) return {error: "请先勾选账号或选分组再导出，避免把全表 session 灌进内存", status: 400};
        if (needsRtWork && isRecoveryRunning()) {
            return {error: "人工恢复正在执行，请完成后再导出 RT", status: 409};
        }
        if (needsRtWork && isRebindRunning()) {
            return {error: "换绑正在执行，请完成后再导出 RT", status: 409};
        }
        if (needsRtWork && isRechargeOperationRunning()) {
            return {error: "充值提交或重登正在进行中，请完成后再导出 RT", status: 409};
        }
        let ownsReservation = needsRtWork && reserveExport();
        let rows;
        try {
            rows = await store.listFull(ids.length ? ids : undefined, batch || undefined, {includeAuth: format === "session"});
        } catch (error) {
            if (ownsReservation) setRunning(false);
            throw error;
        }
        if (!rows.length) {
            if (ownsReservation) setRunning(false);
            return {error: "无数据可导出", status: 400};
        }
        const text = (value, contentType = "text/plain; charset=utf-8") => ({text: value, contentType});

        if (format === "account") return text(rows.map((row) => formatLine(row, {withGpt: true})).join("\n"));
        if (format === "card") {
            const cards = rows.filter((row) => row.card_code).map((row) => row.card_code).join("\n");
            return cards ? text(cards) : {error: "选中项无卡密", status: 400};
        }
        if (format === "session") {
            const sessions = rows.map((row) => {
                const auth = row.gpt_auth_data || row.auth_data || credentials.readJson(row.gpt_auth_file) || credentials.readJson(row.auth_file);
                const session = credentials.extractSession(auth);
                return session ? JSON.stringify(session) : "";
            }).filter(Boolean);
            return sessions.length ? text(sessions.join("\n")) : {error: "选中项无 session 数据", status: 400};
        }
        if (format === "sub2json") {
            let withRt = 0;
            const lines = rows.map((row) => {
                const rt = exportRtOf(row);
                if (rt) withRt++;
                return `${row.email}----${String(row.gpt_password || row.password || "").trim()}----${rt}`;
            });
            return {ok: true, text: lines.join("\n"), total: rows.length, withRt, missingRt: rows.length - withRt};
        }

        const forceRelogin = options.relogin === true;
        const needRt = rows.filter((row) => !hasRt(row));
        if (!forceRelogin && !needRt.length) {
            if (ownsReservation) setRunning(false);
            return text(rows.map((row) => formatLine(row, {rt: exportRtOf(row), sep: "----"})).join("\n"));
        }
        const work = forceRelogin ? rows : needRt;
        if (!ownsReservation && !running) {
            if (isRecoveryRunning() || isRebindRunning() || isRechargeOperationRunning()) {
                return {error: "充值操作状态已变化，请稍后重试导出 RT", status: 409};
            }
            ownsReservation = reserveExport();
        }
        if (!ownsReservation) {
            const ready = forceRelogin ? [] : rows.filter(hasRt);
            if (ready.length) {
                effects.log(`另有导出在取 RT，先交出已有 RT 的 ${ready.length}/${rows.length} 个（缺的仍在后台拿）`);
                return text(ready.map((row) => formatLine(row, {rt: exportRtOf(row), sep: "----"})).join("\n"));
            }
            effects.log("已有导出含RT在跑，请先点「停止导出RT」");
            return {error: "已有导出含RT在跑，请先停止", status: 409};
        }
        const concurrency = normalizeConcurrency(config.rtConcurrency(), 4);
        runDetached(rtExportRunner.run({rows, work, ids, batch, forceRelogin, concurrency, isStopped: () => stopped}), "RT 导出");
        return {ok: true, async: true, total: rows.length, needRt: work.length, relogin: forceRelogin};
    }

    async function exportSub2json(ids, requestedConcurrency) {
        if (!ids.length) return {error: "请先勾选要导出的账号", status: 400};
        if (isRecoveryRunning()) {
            return {error: "人工恢复正在执行，请完成后再导出 RT", status: 409};
        }
        if (isRebindRunning()) {
            return {error: "换绑正在执行，请完成后再导出 RT", status: 409};
        }
        if (isRechargeOperationRunning()) {
            return {error: "充值提交或重登正在进行中，请完成后再导出 RT", status: 409};
        }
        let ownsReservation = reserveExport();
        let rows;
        try {
            rows = await store.listFull(ids);
        } catch (error) {
            if (ownsReservation) setRunning(false);
            throw error;
        }
        if (!rows.length) {
            if (ownsReservation) setRunning(false);
            return {error: "无数据可导出", status: 400};
        }
        const concurrency = normalizeConcurrency(requestedConcurrency ?? config.rtConcurrency(), 4);
        if (!ownsReservation && !running) {
            if (isRecoveryRunning() || isRebindRunning() || isRechargeOperationRunning()) {
                return {error: "充值操作状态已变化，请稍后重试导出 RT", status: 409};
            }
            ownsReservation = reserveExport();
        }
        if (!ownsReservation) {
            const ready = rows.filter(hasRt);
            if (!ready.length) {
                effects.log("已有导出在跑，请先点「停止导出」");
                return {error: "已有导出在跑，请先停止", status: 409};
            }
            if (partialSub2jsonRunning) {
                return {error: "已有局部 sub2json 导出在跑，请稍后", status: 409};
            }
            effects.log(`另有导出在取 RT，sub2json 只刷已有 RT 的 ${ready.length}/${rows.length} 个`);
            setPartialSub2jsonRunning(true);
            runDetached(
                runSub2json(ready, concurrency, {partial: true})
                    .finally(() => { setPartialSub2jsonRunning(false); }),
                "sub2json 局部导出",
            );
            return {ok: true, async: true, total: ready.length, needRt: 0, concurrency, partial: true};
        }
        const needRt = rows.filter((row) => !hasRt(row)).length;
        effects.log(`导出 sub2json：${rows.length} 个，缺 RT ${needRt}，并发 ${concurrency}（缺的先获取再刷新，出一个 JSON）`);
        runDetached(runSub2json(rows, concurrency, {ownsLock: true, progress: true}), "sub2json 导出");
        return {ok: true, async: true, total: rows.length, needRt, concurrency};
    }

    async function runSub2json(rows, concurrency, {ownsLock = false, progress = false} = {}) {
        let result;
        try {
            result = await sub2json.exportAccounts(rows, {
                concurrency,
                isStopped: () => stopped,
                log: effects.log,
                progress,
            });
        } catch (error) {
            result = {accounts: [], ok: 0, fail: rows.length, total: rows.length};
            effects.log(`导出 sub2json 异常: ${String(error?.message || error).slice(0, 140)}`);
        }
        try {
            if (stopped) {
                effects.log(`导出 sub2json 已停止：成功 ${result.ok || 0} / 失败 ${result.fail || 0}`);
                notifyReady({stopped: true, format: "sub2json", ok: result.ok || 0, fail: result.fail || 0, total: result.total || rows.length});
                return;
            }
            const payload = {exported_at: now().toISOString(), proxies: [], accounts: result.accounts};
            if (progress) effects.log(`导出 sub2json 完成：成功 ${result.ok} / 失败 ${result.fail} / 共 ${rows.length}，一个 JSON`);
            notifyReady({
                format: "sub2json",
                text: JSON.stringify(payload, null, 2),
                ok: result.ok,
                fail: result.fail,
                total: result.total,
            });
        } catch (error) {
            effects.log(`导出 sub2json 收尾失败: ${String(error?.message || error).slice(0, 140)}`);
            notifyReady({error: String(error?.message || error).slice(0, 200), format: "sub2json", ok: result?.ok || 0, fail: result?.fail || rows.length, total: result?.total || rows.length});
        } finally {
            if (ownsLock) setRunning(false);
        }
    }

    function stop() {
        const wasRunning = isRunning();
        stopped = true;
        notifyJobsChanged();
        const killed = childProcesses.terminateAll();
        if (wasRunning) effects.log(killed
            ? `已停止导出RT，正在终止 ${killed} 个子进程`
            : "已请求停止导出RT，当前这个号跑完就停，后面的不再开始");
        return {ok: true, running: wasRunning, killed};
    }

    return {
        exportQueue,
        exportSub2json,
        stop,
        probePlans: planProbe.start,
        attachChild,
        isRunning,
        requestStop: stop,
    };
}
