// @ts-nocheck
// 人工恢复用例：与本进程运行任务互斥，持久化状态收敛由仓储事务负责。

export function createRechargeManualRecoveryService({runtime, store, effects} = {}) {
    let running = false;

    function localBusyReason() {
        const jobs = runtime.jobState();
        if (jobs.submit || jobs.reloginSubmit) return "充值提交正在运行";
        if (jobs.relogin) return "重新登录正在运行";
        if (jobs.exportRt) return "RT 导出正在运行";
        if (runtime.pollRunning()) return "充值状态轮询正在运行";
        if (runtime.rebindRunning()) return "换绑正在运行";
        return "";
    }

    async function recover(ids) {
        const selected = [...new Set((ids || []).map(Number).filter(Number.isInteger))];
        if (!selected.length) return {error: "未选择要恢复的充值队列项", status: 400};
        if (running) return {error: "人工恢复正在执行", status: 409};
        const busy = localBusyReason();
        if (busy) return {error: `${busy}，请先停止或等待完成`, status: 409};
        running = true;
        try {
            const result = await store.recover(selected);
            effects.log(`人工恢复 ${result.selected} 项：释放充值租约 ${result.rechargeLeases}，安全解配 ${result.pairedReset}，保留待对账 ${result.preserved}，释放换绑租约 ${result.rebindLeases}，转待核对 ${result.rebindUnknown}${result.activeSkipped ? `，跳过其他活实例 ${result.activeSkipped}` : ""}`);
            await effects.sync();
            return {ok: true, ...result};
        } finally {
            running = false;
        }
    }

    return {recover, isRunning: () => running};
}
