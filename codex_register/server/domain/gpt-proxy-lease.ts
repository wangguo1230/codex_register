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

function isLocalProxy(proxyUrl) {
    try {
        const value = String(proxyUrl || "");
        const url = new URL(value.includes("://") ? value.split("#")[0] : `socks5://${value}`);
        return url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "::1";
    } catch {
        return false;
    }
}

/** Keep the last observed IP per account owner and a process-local cooldown set. */
export function createGptProxyExitTracker({ttlMs = 270_000, cooldownMs = 24 * 60 * 60 * 1000, now = () => Date.now()} = {}) {
    const records = new Map();
    const usedIps = new Map();
    const copy = (record) => record ? {...record} : null;
    return {
        get(owner) { return copy(records.get(String(owner || ""))); },
        needsProbe(owner, url) {
            const previous = records.get(String(owner || ""));
            const value = String(url || "").trim();
            if (!previous || previous.url !== value || !previous.checkedAt) return true;
            return now() - previous.checkedAt >= Math.max(30_000, Number(ttlMs) || 270_000);
        },
        update(owner, url, ip) {
            const key = String(owner || "");
            const value = String(url || "").trim();
            if (!value) return;
            const previous = records.get(key);
            records.set(key, {url: value, ip: String(ip || "").trim() || previous?.ip || "", checkedAt: now()});
        },
        reserve(owner, ip) {
            const value = String(ip || "").trim();
            if (!value || value === "?") return true;
            const key = String(owner || "");
            const at = now();
            for (const [address, lease] of usedIps) {
                if (lease.until <= at) usedIps.delete(address);
            }
            const previous = usedIps.get(value);
            if (previous && previous.until > at) return false;
            usedIps.set(value, {owner: key, until: at + Math.max(30_000, Number(cooldownMs) || 24 * 60 * 60 * 1000)});
            return true;
        },
        clear(owner) { records.delete(String(owner || "")); },
    };
}

export function createGptProxyLease({
    proxyPool,
    jumpPool,
    settings,
    maskProxyUrl,
    maxJumpExits = 1,
    probeExit = null,
    exitTracker = createGptProxyExitTracker(),
    reserveExitIp = null,
} = {}) {
    return async function withLeasedGptProxy(owner, task, {
        timeoutMs = 45_000,
        log,
        noEmptyFallback = false,
        signal,
        _deadlineAt = 0,
    } = {}) {
        const who = String(owner || "gpt-relogin");
        let jumpLease = null;
        let proxyLease = null;
        const rechargeProxy = () => String(settings.rechargeProxy() || "").trim();
        const wantJump = settings.hasJumpConfig();
        const deadlineAt = Number(_deadlineAt) > 0 ? Number(_deadlineAt) : Date.now() + Math.max(1_000, Number(timeoutMs) || 45_000);
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
            if (probeExit && !isLocalProxy(proxyUrl)) {
                const previous = exitTracker?.get?.(who);
                const shouldProbe = exitTracker?.needsProbe?.(who, proxyUrl) !== false;
                let ip = shouldProbe ? "" : String(previous?.ip || "").trim();
                if (shouldProbe) {
                    let probe;
                    try {
                        probe = await probeExit(proxyUrl, {jump: jumpUrl, signal});
                    } catch (error) {
                        log?.(`GPT 代理出口探测失败（${String(error?.message || error).slice(0, 80)}）`);
                    }
                    ip = String(probe?.ip || "").trim();
                }
                if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) {
                    log?.(`GPT 代理出口探测未拿到 IP，释放当前出口并重试`);
                    await proxyLease?.release?.();
                    proxyLease = null;
                    await jumpLease?.release?.();
                    jumpLease = null;
                    const unknown = new Error("代理出口 IP 未知");
                    unknown.code = "GPT_PROXY_IP_UNKNOWN";
                    throw unknown;
                }
                const localReserved = exitTracker?.reserve?.(who, ip) !== false;
                if (!localReserved) {
                    log?.(`GPT 代理出口 ${ip} 在本实例冷却期内，换下一个出口`);
                    const duplicate = new Error(`代理出口 IP 重复: ${ip}`);
                    duplicate.code = "GPT_PROXY_DUPLICATE_IP";
                    throw duplicate;
                }
                if (typeof reserveExitIp === "function") {
                    try {
                        const sharedReserved = await reserveExitIp({ip, owner: who, cooldownMs: 24 * 60 * 60 * 1000});
                        if (!sharedReserved) {
                            log?.(`GPT 代理出口 ${ip} 在共享冷却期内，换下一个出口`);
                            const duplicate = new Error(`代理出口 IP 重复: ${ip}`);
                            duplicate.code = "GPT_PROXY_DUPLICATE_IP";
                            throw duplicate;
                        }
                    } catch (error) {
                        if (error?.code === "GPT_PROXY_DUPLICATE_IP") throw error;
                        const unavailable = new Error(`代理出口 IP 共享记忆不可用: ${String(error?.message || error).slice(0, 100)}`);
                        unavailable.code = "GPT_PROXY_IP_MEMORY_UNAVAILABLE";
                        throw unavailable;
                    }
                }
                if (previous?.ip && previous.ip !== ip) log?.(`GPT 代理出口已变化 ${previous.ip} -> ${ip}`);
                else if (!previous?.ip) log?.(`GPT 代理出口已记录 ${ip}`);
                exitTracker.update(who, proxyUrl, ip);
            }
            log?.(`GPT 代理池 ${maskProxyUrl(proxyUrl)}${jumpUrl ? " · 跳板 " + maskProxyUrl(jumpUrl) : " · 无跳板"}（一号一代理 · 新 session）`);
            return await task(proxyUrl, jumpUrl);
        } catch (error) {
            if (signal?.aborted || error?.name === "AbortError") throw error;
            if (error?.code === "GPT_PROXY_DUPLICATE_IP" || error?.code === "GPT_PROXY_IP_UNKNOWN") {
                // Rotate only after returning the rejected lease; otherwise the
                // recursive attempt can consume the pool while the old lease is
                // still counted as active.
                try { await proxyLease?.release?.(); } catch { /* */ }
                proxyLease = null;
                try { await jumpLease?.release?.(); } catch { /* */ }
                jumpLease = null;
                const remaining = Math.max(0, deadlineAt - Date.now());
                if (remaining > 1_000) {
                    await new Promise((resolve) => setTimeout(resolve, Math.min(800, remaining - 1)));
                    return withLeasedGptProxy(owner, task, {timeoutMs: remaining, log, noEmptyFallback, signal, _deadlineAt: deadlineAt});
                }
                throw error;
            }
            const message = String(error?.message || error);
            // When the pool is enabled, waiting for a distinct exit is safer
            // than silently switching every account to the shared local proxy.
            if (probeExit && settings.hasPoolConfig?.() && /代理池全忙|等待超时|租约空|跳板池全忙|需要跳板/i.test(message)) {
                throw error;
            }
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
