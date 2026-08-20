// @ts-nocheck
// 邮箱出口与跳板的组合租约，确保任一阶段失败时已取得的资源都会释放。

export function createMailProxyLease({
    proxyPool,
    jumpPool,
    getFallbackProxy = () => "",
    getFallbackJump = () => "",
    getMaxPerTemplate = () => 1,
    maxPerJump = 1,
    setMailboxProxy = null,
    resolveJumpUrl = async (url) => url,
} = {}) {
    return async function withLeasedMailProxy(owner, task, mailbox = null, options = {}) {
        const who = String(owner || "mail");
        const preferredUrl = String(mailbox?.proxy_url || "").trim();
        const skipJump = options?.skipJump === true;
        const signal = options?.signal;
        let proxyLease = null;
        let jumpLease = null;
        try {
            if (signal?.aborted) throw signal.reason || new Error("任务已取消");
            proxyLease = await proxyPool.lease(who, {
                fallback: getFallbackProxy(),
                maxPerTemplate: Math.max(1, Number(getMaxPerTemplate()) || 1),
                freshSession: !preferredUrl,
                preferUrl: preferredUrl,
                signal,
            });
            const remember = (url, ip = "") => {
                if (!mailbox?.id || !url || typeof setMailboxProxy !== "function") return;
                Promise.resolve(setMailboxProxy(mailbox.id, url, ip)).catch(() => {});
                mailbox.proxy_url = url;
                if (ip) mailbox.proxy_ip = ip;
            };
            if (proxyLease.url) remember(proxyLease.url, mailbox?.proxy_ip || "");

            if (!skipJump && jumpPool.urls.length) {
                jumpLease = await jumpPool.lease(who, {timeoutMs: 45_000, maxPerJump, signal});
            }
            if (signal?.aborted) throw signal.reason || new Error("任务已取消");
            let jumpUrl = skipJump ? "" : (jumpLease?.url || getFallbackJump() || "");
            if (!skipJump) jumpUrl = await resolveJumpUrl(jumpUrl);
            if (signal?.aborted) throw signal.reason || new Error("任务已取消");
            return await task(proxyLease.url, jumpUrl, remember);
        } finally {
            try { await proxyLease?.release?.(); } catch { /* */ }
            try { await jumpLease?.release?.(); } catch { /* */ }
        }
    };
}
