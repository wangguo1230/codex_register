// @ts-nocheck
// RT 导出执行器：选择分布式/本机实现、处理停止和生成最终文本。
export function createRechargeRtExportRunner({store, formatLine, formatRt = (row) => row.refresh_token || "", rtAcquire, distributedRtExport, hasRt, effects, notifyReady, setRunning} = {}) {
    async function run({rows, work, ids, batch, forceRelogin, concurrency, isStopped}) {
        effects.log((forceRelogin ? "重登导出含RT: " : "导出含RT: ")
            + work.length + (forceRelogin
                ? " 个账号将先重登再取 RT，并发" + concurrency + "执行…"
                : "/" + rows.length + " 个账号缺少 RT，并发" + concurrency + "获取中..."));
        let result;
        let fresh = null;
        try {
            if (!forceRelogin && distributedRtExport) {
                try {
                    const distributed = await distributedRtExport.run({rows, work, ids, batch, isStopped});
                    fresh = distributed.fresh;
                    result = {
                        ok: fresh.filter(hasRt).length,
                        fail: fresh.filter((row) => !hasRt(row)).length,
                        total: work.length,
                        timedOut: distributed.timedOut,
                    };
                } catch (error) {
                    effects.log("分布式 RT 入队/等待失败，回退当前实例执行: " + String(error?.message || error).slice(0, 140));
                    result = await rtAcquire(work, {
                        forceRelogin,
                        concurrency,
                        isStopped,
                        log: effects.log,
                    });
                }
            } else {
                result = await rtAcquire(work, {
                    forceRelogin,
                    concurrency,
                    isStopped,
                    log: effects.log,
                });
            }
        } catch (error) {
            result = {ok: 0, fail: work.length, total: work.length};
            effects.log((forceRelogin ? "重登导出" : "导出含RT") + "异常: " + String(error?.message || error).slice(0, 140));
        }
        try {
            if (isStopped()) {
                effects.log((forceRelogin ? "重登导出" : "导出含RT") + "已停止: 已完成 " + (result.ok || 0) + " / 失败 " + (result.fail || 0));
                notifyReady({stopped: true, relogin: forceRelogin});
                return;
            }
            effects.log((forceRelogin ? "重登导出" : "RT 获取")
                + (result.timedOut ? "等待超时，已输出当前结果" : "完成")
                + ": 成功 " + result.ok + " / 失败 " + result.fail);
            fresh ||= await store.listFull(ids.length ? ids : undefined, batch || undefined);
            notifyReady({text: fresh.map((row) => formatLine(row, {rt: formatRt(row), sep: "----"})).join("\n"), relogin: forceRelogin});
            effects.log(forceRelogin
                ? "重登取 RT 完成，共 " + fresh.length + " 条，点「导出含RT」即可复制"
                : "导出含RT 已就绪，共 " + fresh.length + " 条");
        } catch (error) {
            effects.log((forceRelogin ? "重登导出" : "导出含RT") + "收尾失败: " + String(error?.message || error).slice(0, 140));
            notifyReady({error: String(error?.message || error).slice(0, 200), relogin: forceRelogin});
        } finally {
            setRunning(false);
        }
    }

    return {run};
}
