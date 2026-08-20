// @ts-nocheck

export function proxyHasSocksAuth(raw) {
    try {
        const cleaned = String(raw || "").trim().replace(/#.*$/, "");
        if (!cleaned) return false;
        const url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(cleaned) ? cleaned : `socks5://${cleaned}`);
        return url.protocol.startsWith("socks") && !!(url.username || url.password);
    } catch {
        return /socks[^:]*:\/\/[^/@]+@/i.test(String(raw || ""));
    }
}

export function pickBrowserCompatibleProxy(...candidates) {
    for (const candidate of candidates) {
        const url = String(candidate || "").trim();
        if (url && !proxyHasSocksAuth(url)) return url;
    }
    return "";
}

export function resolveReloginProxy(explicit, fallback) {
    const selected = explicit !== undefined && explicit !== null ? String(explicit).trim() : "";
    return selected || String(fallback?.() || "").trim();
}

function exitNeedsJump(proxyUrl) {
    try {
        const value = String(proxyUrl || "");
        const url = new URL(value.includes("://") ? value.split("#")[0] : `socks5://${value}`);
        return url.hostname !== "127.0.0.1" && url.hostname !== "localhost";
    } catch {
        return true;
    }
}

export function createGptProxyLease({proxyPool, jumpPool, settings, maskProxyUrl, maxJumpExits = 1} = {}) {
    return async function withLeasedGptProxy(owner, task, {
        timeoutMs = 45_000,
        log,
        noEmptyFallback = false,
        signal,
    } = {}) {
        const who = String(owner || "gpt-relogin");
        let jumpLease = null;
        let proxyLease = null;
        const rechargeProxy = () => String(settings.rechargeProxy() || "").trim();
        const wantJump = settings.hasJumpConfig();
        const runFallback = async (reason) => {
            if (signal?.aborted) throw signal.reason || new Error("任务已取消");
            const proxyUrl = rechargeProxy();
            if (!proxyUrl) {
                log?.(`GPT 代理池${reason}，无 10808 可回退`);
                throw new Error(`GPT 代理池${reason}且无充值代理可回退（禁止直连）`);
            }
            log?.(`GPT 代理池${reason}，回退充值代理 ${maskProxyUrl(proxyUrl)}`);
            return task(proxyUrl, "");
        };

        try {
            proxyLease = await proxyPool.lease(who, {
                fallback: noEmptyFallback ? "" : rechargeProxy(),
                maxPerTemplate: 1,
                freshSession: true,
                timeoutMs,
                signal,
            });
            if (signal?.aborted) throw signal.reason || new Error("任务已取消");
            const proxyUrl = String(proxyLease?.url || "").trim() || (noEmptyFallback ? "" : rechargeProxy());
            if (!proxyUrl) throw new Error("GPT 代理池租约空且无充值代理");

            if (wantJump && jumpPool.urls.length) {
                try {
                    jumpLease = await jumpPool.lease(who, {
                        timeoutMs: noEmptyFallback ? 45_000 : Math.min(timeoutMs, 20_000),
                        maxPerJump: maxJumpExits,
                        signal,
                    });
                } catch (error) {
                    if (signal?.aborted || error?.name === "AbortError") throw error;
                    log?.(`跳板租约未成: ${String(error?.message || error).slice(0, 80)}，直连 GPT 代理池`);
                }
            }
            if (signal?.aborted) throw signal.reason || new Error("任务已取消");
            const jumpUrl = wantJump && exitNeedsJump(proxyUrl)
                ? (jumpLease?.url || settings.configuredJump() || "")
                : "";
            log?.(`GPT 代理池 ${maskProxyUrl(proxyUrl)}${jumpUrl ? " · 跳板 " + maskProxyUrl(jumpUrl) : " · 无跳板"}（一号一代理 · 新 session）`);
            return await task(proxyUrl, jumpUrl);
        } catch (error) {
            if (signal?.aborted || error?.name === "AbortError") throw error;
            const message = String(error?.message || error);
            if (noEmptyFallback || !rechargeProxy()) throw error;
            if (/代理池全忙|等待超时|租约空|跳板池全忙|需要跳板/i.test(message)) {
                return runFallback(/忙|超时/.test(message) ? "忙" : "空");
            }
            if (!settings.hasPoolConfig()) throw error;
            return runFallback(`租约失败(${message.slice(0, 60)})`);
        } finally {
            try { await proxyLease?.release?.(); } catch { /* */ }
            try { await jumpLease?.release?.(); } catch { /* */ }
        }
    };
}
