// @ts-nocheck
// SSE 传输适配器：管理客户端、事件序列化、心跳和调度器事件转发。

const DEFAULT_EVENTS = ["log", "status", "stats", "snapshot", "sms", "claude", "mbLog", "claudeLog", "daily"];

export function createSseHub({
    scheduler,
    getInitialState,
    getStats,
    maxPayloadBytes = 4_000_000,
    heartbeatMs = 25_000,
    clock = globalThis,
    logger = console,
} = {}) {
    const clients = new Set();
    const heartbeats = new Map();
    const listeners = new Map();

    function removeClient(response, destroy = false) {
        const heartbeat = heartbeats.get(response);
        if (heartbeat) clock.clearInterval(heartbeat);
        heartbeats.delete(response);
        clients.delete(response);
        try {
            if (destroy) response.destroy?.();
            else response.end?.();
        } catch { /* 客户端已经断开 */ }
    }

    function write(response, payload) {
        if (response.destroyed || response.writableEnded || response.writableNeedDrain) {
            removeClient(response, true);
            return false;
        }
        try {
            if (response.write(payload) === false) {
                logger.warn("[sse] 客户端消费过慢，关闭连接避免响应缓冲持续占用内存");
                removeClient(response, true);
                return false;
            }
            return true;
        } catch {
            removeClient(response, true);
            return false;
        }
    }

    function broadcast(event, data) {
        let json;
        try {
            json = JSON.stringify(data);
        } catch (error) {
            logger.warn(`[sse] ${event} 无法序列化: ${error?.message || error}`);
            return false;
        }
        if (json.length > maxPayloadBytes) {
            logger.warn(`[sse] 丢弃 ${event}（${json.length} 字节），避免 HTTP 服务和前端内存过载`);
            return false;
        }
        const payload = `event: ${event}\ndata: ${json}\n\n`;
        for (const response of [...clients]) write(response, payload);
        return true;
    }

    function bindScheduler(events = DEFAULT_EVENTS) {
        for (const event of events) {
            if (listeners.has(event)) continue;
            const listener = (data) => broadcast(event, data);
            listeners.set(event, listener);
            scheduler.on(event, listener);
        }
    }

    function registerRoute(app) {
        app.get("/api/stream", async (request, response) => {
            response.set({
                "Content-Type": "text/event-stream",
                "Cache-Control": "no-cache",
                Connection: "keep-alive",
                "X-Accel-Buffering": "no",
            });
            response.flushHeaders?.();
            const close = () => removeClient(response);
            request.once("close", close);
            try {
                const hello = `event: hello\ndata: ${JSON.stringify({state: await getInitialState(), stats: await getStats()})}\n\n`;
                clients.add(response);
                if (!write(response, hello)) return;
                const heartbeat = clock.setInterval(() => write(response, "event: ping\ndata: {}\n\n"), heartbeatMs);
                heartbeats.set(response, heartbeat);
            } catch (error) {
                logger.warn(`[sse] 初始化失败: ${error?.message || error}`);
                removeClient(response, true);
            }
        });
    }

    function dispose() {
        for (const [event, listener] of listeners) scheduler.off?.(event, listener);
        listeners.clear();
        for (const response of [...clients]) removeClient(response);
    }

    return {broadcast, bindScheduler, registerRoute, dispose, clientCount: () => clients.size};
}
