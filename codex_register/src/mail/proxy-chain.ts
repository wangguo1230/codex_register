// 本机 → 跳板(注册代理/xray) → 出口代理(kookeey)。
// 跳板只负责连上网关端口；比特窗口仍用出口账密，出口 IP 不变。
import net from "node:net";
import {SocksClient} from "socks";

export function parseProxyEndpoint(raw: string) {
    const url = String(raw || "").trim();
    if (!url) return null;
    try {
        const u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(url) ? url : `socks5://${url}`);
        const proto = (u.protocol || "socks5:").replace(":", "").toLowerCase();
        return {
            url,
            proto,
            host: u.hostname,
            port: Number(u.port || (proto.startsWith("socks") ? 1080 : 80)),
            user: u.username ? decodeURIComponent(u.username) : "",
            pass: u.password ? decodeURIComponent(u.password) : "",
            isSocks: proto.startsWith("socks"),
            isHttp: proto === "http" || proto === "https",
        };
    } catch {
        return null;
    }
}

function socksType(proto: string) {
    return proto.startsWith("socks4") ? 4 : 5;
}

export async function connectViaJump(jumpRaw: string, destHost: string, destPort: number, timeoutMs = 8000): Promise<net.Socket> {
    const jump = parseProxyEndpoint(jumpRaw);
    if (!jump) throw new Error("跳板代理无效");
    if (jump.isSocks) {
        const {socket} = await SocksClient.createConnection({
            proxy: {
                host: jump.host,
                port: jump.port,
                type: socksType(jump.proto),
                userId: jump.user || undefined,
                password: jump.pass || undefined,
            },
            command: "connect",
            destination: {host: destHost, port: destPort},
            timeout: timeoutMs,
        });
        return socket;
    }
    if (jump.isHttp) {
        return connectHttpConnect(jump, destHost, destPort, timeoutMs);
    }
    throw new Error(`跳板只支持 socks5/http，当前 ${jump.proto}`);
}

function connectHttpConnect(jump, destHost: string, destPort: number, timeoutMs: number): Promise<net.Socket> {
    return new Promise((resolve, reject) => {
        const sock = net.connect({host: jump.host, port: jump.port});
        const timer = setTimeout(() => {
            try { sock.destroy(); } catch { /* */ }
            reject(new Error("跳板 HTTP CONNECT 超时"));
        }, timeoutMs);
        const fail = (e) => {
            clearTimeout(timer);
            try { sock.destroy(); } catch { /* */ }
            reject(e instanceof Error ? e : new Error(String(e)));
        };
        sock.once("error", fail);
        sock.once("connect", () => {
            const auth = jump.user
                ? `Proxy-Authorization: Basic ${Buffer.from(`${jump.user}:${jump.pass}`).toString("base64")}\r\n`
                : "";
            sock.write(`CONNECT ${destHost}:${destPort} HTTP/1.1\r\nHost: ${destHost}:${destPort}\r\n${auth}\r\n`);
        });
        let buf = "";
        const onData = (chunk) => {
            buf += chunk.toString("latin1");
            const idx = buf.indexOf("\r\n\r\n");
            if (idx < 0) return;
            sock.off("data", onData);
            const status = buf.slice(0, idx).split("\r\n")[0] || "";
            if (!/ 200 /.test(status)) {
                fail(new Error(`跳板 CONNECT 失败: ${status.slice(0, 80)}`));
                return;
            }
            clearTimeout(timer);
            resolve(sock);
        };
        sock.on("data", onData);
    });
}

export async function probeJumpTo(jumpRaw: string, destHost: string, destPort: number, timeoutMs = 8000) {
    const started = Date.now();
    try {
        const sock = await connectViaJump(jumpRaw, destHost, destPort, timeoutMs);
        try { sock.destroy(); } catch { /* */ }
        return {ok: true, ms: Date.now() - started};
    } catch (e: any) {
        return {ok: false, ms: Date.now() - started, reason: String(e?.message || e).slice(0, 160)};
    }
}

export function rewriteExitToLocal(exitUrl: string, localPort: number) {
    const u = new URL(exitUrl);
    const auth = u.username
        ? `${u.username}:${u.password}@`
        : "";
    const proto = (u.protocol || "socks5:").replace(":", "") || "socks5";
    return `${proto}://${auth}127.0.0.1:${localPort}`;
}

export async function openLocalRelay(jumpRaw: string, destHost: string, destPort: number) {
    const server = net.createServer((client) => {
        connectViaJump(jumpRaw, destHost, destPort, 12000).then((up) => {
            try { client.setKeepAlive(true, 15000); } catch { /* */ }
            try { up.setKeepAlive(true, 15000); } catch { /* */ }
            const pump = (a: net.Socket, b: net.Socket) => {
                a.on("error", () => { try { b.destroy(); } catch { /* */ } });
                b.on("error", () => { try { a.destroy(); } catch { /* */ } });
                a.on("close", () => { try { b.destroy(); } catch { /* */ } });
                b.on("close", () => { try { a.destroy(); } catch { /* */ } });
                a.pipe(b);
                b.pipe(a);
            };
            pump(client, up);
        }).catch(() => {
            try { client.destroy(); } catch { /* */ }
        });
    });
    await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => resolve(null));
    });
    const addr = server.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;
    if (!port) {
        try { server.close(); } catch { /* */ }
        throw new Error("跳板本地转发端口分配失败");
    }
    return {
        port,
        destHost,
        destPort,
        close() {
            try { server.close(); } catch { /* */ }
        },
    };
}

export async function wrapExitThroughJump(exitUrl: string, jumpRaw: string) {
    const exit = parseProxyEndpoint(exitUrl);
    if (!exit) throw new Error("出口代理无效");
    const relay = await openLocalRelay(jumpRaw, exit.host, exit.port);
    return {
        url: rewriteExitToLocal(exitUrl, relay.port),
        destHost: exit.host,
        destPort: exit.port,
        localPort: relay.port,
        close: () => relay.close(),
    };
}

export const KOOK_COUNTRY_TZ: Record<string, string> = {
    US: "America/New_York", GB: "Europe/London", DE: "Europe/Berlin",
    FR: "Europe/Paris", JP: "Asia/Tokyo", SG: "Asia/Singapore",
    HK: "Asia/Hong_Kong", TW: "Asia/Taipei", KR: "Asia/Seoul",
    AU: "Australia/Sydney", CA: "America/Toronto", NL: "Europe/Amsterdam",
};

export function timezoneFromExitUrl(exitUrl: string) {
    try {
        const pass = decodeURIComponent(new URL(exitUrl).password || "");
        const m = pass.match(/-([A-Za-z]{2})-(\d+)-(\d+m)$/);
        if (m && KOOK_COUNTRY_TZ[m[1].toUpperCase()]) return KOOK_COUNTRY_TZ[m[1].toUpperCase()];
    } catch { /* */ }
    return "";
}
