// 协议出网：PROXY_URL + MAIL_PROXY_JUMP → 跳板→出口，和 OpenAIClient 同一条。
// 给换绑 HTTP / 其它非 OpenAIClient 的 fetch 用，禁止在 :3100 里对远程出口调这个。
import net from "node:net";
import tls from "node:tls";
import {Agent, ProxyAgent, type Dispatcher} from "undici";
import {SocksClient} from "socks";
import {connectExitViaJump} from "./proxy-chain.js";

function isSocksProtocol(protocol: string): boolean {
    return ["socks4:", "socks4a:", "socks5:", "socks5h:"].includes(protocol);
}

async function createSocksSocket(
    proxyUrl: URL,
    options: Record<string, unknown>,
    allowInsecureTLS: boolean,
): Promise<net.Socket> {
    const destinationHost = String(options.hostname ?? "");
    const rawPort = options.port;
    const destinationPort =
        rawPort === "" || rawPort == null
            ? (options.protocol === "https:" ? 443 : 80)
            : Number(rawPort);
    const proxyPort = Number(proxyUrl.port || 1080);
    const proxyType = proxyUrl.protocol.startsWith("socks4") ? 4 : 5;
    const jump = String(process.env.MAIL_PROXY_JUMP || "").trim();
    const proxyLocal = proxyUrl.hostname === "127.0.0.1" || proxyUrl.hostname === "localhost";

    let socket: net.Socket;
    if (jump && !proxyLocal) {
        socket = await connectExitViaJump(proxyUrl.toString(), jump, destinationHost, destinationPort);
    } else {
        const connection = await SocksClient.createConnection({
            proxy: {
                host: proxyUrl.hostname,
                port: proxyPort,
                type: proxyType,
                userId: proxyUrl.username ? decodeURIComponent(proxyUrl.username) : undefined,
                password: proxyUrl.password ? decodeURIComponent(proxyUrl.password) : undefined,
            },
            command: "connect",
            destination: {host: destinationHost, port: destinationPort},
            timeout: 25_000,
        });
        socket = connection.socket;
    }
    try {
        socket.setKeepAlive(true, 15_000);
        socket.setNoDelay(true);
    } catch { /* */ }
    if (options.protocol !== "https:") return socket;

    return await new Promise<net.Socket>((resolve, reject) => {
        const tlsSocket = tls.connect({
            socket,
            host: String(options.servername ?? destinationHost),
            servername: String(options.servername ?? destinationHost),
            rejectUnauthorized: !allowInsecureTLS,
            minVersion: "TLSv1.2",
            maxVersion: "TLSv1.3",
        });
        const timer = setTimeout(() => {
            try { tlsSocket.destroy(); } catch { /* */ }
            reject(new Error(`TLS 握手超时 ${destinationHost}:${destinationPort}`));
        }, 25_000);
        tlsSocket.once("secureConnect", () => {
            clearTimeout(timer);
            resolve(tlsSocket);
        });
        tlsSocket.once("error", (err) => {
            clearTimeout(timer);
            reject(err);
        });
    });
}

export function createProtocolDispatcher(proxyUrl = "", allowInsecureTLS = true): Dispatcher | undefined {
    const raw = String(proxyUrl || "").trim();
    if (!raw) return undefined;
    let parsed: URL;
    try {
        parsed = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw.split("#")[0] : `socks5://${raw.split("#")[0]}`);
    } catch {
        return undefined;
    }
    if (parsed.protocol === "http:" || parsed.protocol === "https:") {
        return new ProxyAgent({
            uri: raw,
            requestTls: {rejectUnauthorized: !allowInsecureTLS},
        });
    }
    if (!isSocksProtocol(parsed.protocol)) return undefined;
    const connect = ((options, callback) => {
        void createSocksSocket(parsed, options as unknown as Record<string, unknown>, allowInsecureTLS)
            .then((socket) => callback(null, socket))
            .catch((error) => callback(error instanceof Error ? error : new Error(String(error)), null));
    }) as NonNullable<ConstructorParameters<typeof Agent>[0]>["connect"];
    return new Agent({connect});
}
