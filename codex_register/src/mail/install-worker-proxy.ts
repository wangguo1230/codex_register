// 协议 worker：PROXY_URL=出口(kookeey) + MAIL_PROXY_JUMP=跳板。
// 起本机 socks 转发，链路=本机 → 跳板(10811/vless) → kookeey，和邮箱探活同一条。

function parseHost(raw: string) {
    try {
        const u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw.split("#")[0] : `socks5://${raw.split("#")[0]}`);
        return {host: u.hostname, hasAuth: !!(u.username || u.password), isSocks: u.protocol.startsWith("socks")};
    } catch {
        return {host: "", hasAuth: false, isSocks: false};
    }
}

export async function installWorkerProxyFromEnv() {
    const exit = String(process.env.WORKER_PROXY_EXIT || process.env.PROXY_URL || "").trim();
    const jump = String(process.env.MAIL_PROXY_JUMP || "").trim();
    if (!exit) return () => {};

    const info = parseHost(exit);
    if (!info.host || info.host === "127.0.0.1" || info.host === "localhost") return () => {};
    if (!info.isSocks) return () => {};
    if (!jump) {
        console.log(`[worker-proxy] 无跳板，直连 ${info.host}（国内打 kookeey 常超时）`);
        return () => {};
    }

    // 和邮箱探活同一条：本机 socks 转发 → 跳板(10811/vless) → kookeey。
    // 不要在 fetch 里对「已连上的 kookeey TCP」再做 SocksClient existing_socket，那条会卡死。
    const {wrapExitThroughJump} = await import("./proxy-chain.js");
    const wrapped = await wrapExitThroughJump(exit, jump);
    process.env.PROXY_URL = wrapped.url;
    process.env.MAIL_PROXY_JUMP = "";
    console.log(`[worker-proxy] 链式 ${info.host} ←跳板 本机转发 :${wrapped.localPort}`);
    return () => { try { wrapped.close(); } catch { /* */ } };
}

/** 变更邮箱 worker 的官方请求和 Gmail IMAP 使用不同出口，不能覆盖 PROXY_URL。 */
export async function installWorkerImapProxyFromEnv() {
    const exit = String(process.env.IMAP_PROXY || "").trim();
    const jump = String(process.env.IMAP_PROXY_JUMP || "").trim();
    if (!exit || !jump) return () => {};
    const info = parseHost(exit);
    if (!info.host || info.host === "127.0.0.1" || info.host === "localhost" || !info.isSocks) return () => {};
    const {wrapExitThroughJump} = await import("./proxy-chain.js");
    const wrapped = await wrapExitThroughJump(exit, jump);
    process.env.IMAP_PROXY = wrapped.url;
    console.log(`[worker-proxy] Gmail IMAP 链式 ${info.host} ←跳板 本机转发 :${wrapped.localPort}`);
    return () => { try { wrapped.close(); } catch { /* */ } };
}
