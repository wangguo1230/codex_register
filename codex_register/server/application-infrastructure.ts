// @ts-nocheck
// 应用基础设施初始化：应用代理配置、恢复 Xray 拓扑并按顺序初始化数据库连接。

async function runStage(name, task, {required = true, timeoutMs = 0, reportPhase = () => {}, logger = console} = {}) {
    reportPhase(name);
    const startedAt = Date.now();
    logger.log(`[startup] ${name} 开始`);
    let timer = null;
    try {
        const operation = Promise.resolve().then(task);
        const result = timeoutMs > 0
            ? await Promise.race([
                operation,
                new Promise((_, reject) => {
                    timer = setTimeout(() => reject(new Error(`${name} 超时(${timeoutMs}ms)`)), timeoutMs);
                    timer?.unref?.();
                }),
            ])
            : await operation;
        logger.log(`[startup] ${name} 完成 (${Date.now() - startedAt}ms)`);
        return result;
    } catch (error) {
        if (required) throw new Error(`${name} 失败: ${error?.message || error}`, {cause: error});
        logger.warn(`[startup] ${name} 失败，已降级 (${Date.now() - startedAt}ms): ${error?.message || error}`);
        return undefined;
    } finally {
        if (timer) clearTimeout(timer);
    }
}

export async function initializeApplicationInfrastructure({
    scheduler,
    mailbox,
    xray,
    database,
    logger = console,
    reportPhase = () => {},
} = {}) {
    reportPhase("proxy-configuration");
    mailbox.setProxy(scheduler.mailProxyEnabled !== false ? (scheduler.mailProxy || "") : "");

    try { xray.stop(); } catch { /* 独立 GPT Xray 已废弃，清理失败不阻断 HTTP */ }
    if (scheduler.xrayVless) {
        logger.log("[server] 已停用 GPT 独立 vless，改走代理池");
        scheduler.xrayVless = "";
    }

    const localXray = new RegExp(`^socks5h?://127\\.0\\.0\\.1:${Number(scheduler.regProxyPort) || 10809}$`, "i");
    if (localXray.test(String(scheduler.regProxy || "").trim())) {
        scheduler.regProxy = "";
        logger.log("[server] 已清空指向独立 xray 的 regProxy，注册改租代理池");
    }
    scheduler.saveSettings();

    // 数据库是所有业务模块的基础设施，先完成 Schema/连接，避免 Xray 启动或端口探测阻塞服务初始化。
    await runStage("database-schema", database.ensureSchema, {reportPhase, logger});
    await runStage("database-connection", database.initConnection, {reportPhase, logger});
    if (typeof scheduler.initializeSharedProxyPool === "function") {
        await runStage("shared-proxy-pool", () => scheduler.initializeSharedProxyPool(), {reportPhase, logger});
    }

    // Xray 属于可选运行时能力，失败只降级代理能力，不阻塞 HTTP 和数据库服务。
    if (scheduler.claudeXrayVless) {
        await runStage("claude-xray", async () => {
            const result = xray.start(scheduler.claudeXrayVless, {
                name: "claude",
                localPort: scheduler.claudeProxyPort,
                binPath: scheduler.xrayBinPath || undefined,
            });
            scheduler.claudeProxy = `socks5://127.0.0.1:${result.port}`;
            logger.log(`[server] Claude 独立 xray 已自启: ${result.node} @ 127.0.0.1:${result.port}`);
        }, {required: false, timeoutMs: 10_000, reportPhase, logger});
    }

    await runStage("jump-fleet", async () => {
        const fleet = await scheduler.ensureJumpFleet();
        if (fleet.length) {
            const details = fleet.map((item) => `${item.node || "?"}@${item.port}${item.running ? "" : " 失败"}`).join(", ");
            logger.log(`[server] 跳板 xray 已自启 ${fleet.length} 条（不占用 10808）: ${details}`);
        }
    }, {required: false, timeoutMs: 45_000, reportPhase, logger});

    reportPhase("ready");
}
