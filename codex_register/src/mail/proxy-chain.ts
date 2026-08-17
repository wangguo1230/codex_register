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

async function connectViaJumpRetry(jumpRaw: string, destHost: string, destPort: number, tries = 3) {
    let last: any;
    for (let i = 0; i < tries; i++) {
        try {
            return await connectViaJump(jumpRaw, destHost, destPort, 12000);
        } catch (e) {
            last = e;
            await new Promise((r) => setTimeout(r, 400 + i * 400));
        }
    }
    throw last || new Error("跳板连不上出口网关");
}

export async function openLocalRelay(jumpRaw: string, destHost: string, destPort: number) {
    const server = net.createServer((client) => {
        connectViaJumpRetry(jumpRaw, destHost, destPort, 3).then((up) => {
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

function readExact(socket: net.Socket, n: number, timeoutMs = 8000): Promise<Buffer> {
    return new Promise((resolve, reject) => {
        const chunks: Buffer[] = [];
        let got = 0;
        const timer = setTimeout(() => done(new Error("socks read timeout")), timeoutMs);
        const done = (err?: Error, buf?: Buffer) => {
            clearTimeout(timer);
            socket.off("data", onData);
            socket.off("error", onErr);
            socket.off("close", onClose);
            if (err) reject(err);
            else resolve(buf as Buffer);
        };
        const onErr = (e: Error) => done(e);
        const onClose = () => done(new Error("socks socket closed"));
        const onData = (buf: Buffer) => {
            chunks.push(buf);
            got += buf.length;
            if (got < n) return;
            const all = Buffer.concat(chunks);
            const extra = all.subarray(n);
            if (extra.length) {
                try { socket.unshift(extra); } catch { /* 部分 socket 不支持 unshift */ }
            }
            done(undefined, all.subarray(0, n));
        };
        socket.on("data", onData);
        socket.on("error", onErr);
        socket.on("close", onClose);
    });
}

/** 已连上带账密的 socks5 出口后，在该 socket 上完成鉴权并 CONNECT dest。 */
async function socks5ConnectOnSocket(socket: net.Socket, user: string, pass: string, destHost: string, destPort: number) {
    if (user || pass) {
        socket.write(Buffer.from([0x05, 0x01, 0x02]));
        const pick = await readExact(socket, 2);
        if (pick[1] !== 0x02) throw new Error("出口不接受用户名密码鉴权");
        const u = Buffer.from(user || "");
        const p = Buffer.from(pass || "");
        socket.write(Buffer.concat([Buffer.from([0x01, u.length]), u, Buffer.from([p.length]), p]));
        const auth = await readExact(socket, 2);
        if (auth[1] !== 0x00) throw new Error("出口 socks5 账密被拒");
    } else {
        socket.write(Buffer.from([0x05, 0x01, 0x00]));
        const pick = await readExact(socket, 2);
        if (pick[1] !== 0x00) throw new Error("出口 socks5 无账密握手失败");
    }
    const host = Buffer.from(destHost);
    const req = Buffer.alloc(7 + host.length);
    req[0] = 0x05; req[1] = 0x01; req[2] = 0x00; req[3] = 0x03; req[4] = host.length;
    host.copy(req, 5);
    req.writeUInt16BE(destPort, 5 + host.length);
    socket.write(req);
    const head = await readExact(socket, 4);
    if (head[1] !== 0x00) throw new Error(`出口 CONNECT 失败 rep=${head[1]}`);
    if (head[3] === 1) await readExact(socket, 6);
    else if (head[3] === 3) {
        const l = await readExact(socket, 1);
        await readExact(socket, l[0] + 2);
    } else if (head[3] === 4) await readExact(socket, 18);
    return socket;
}

/**
 * Playwright 不能走 socks5 账密。这里起一个本机无账密 socks5，
 * 把 CONNECT 转到池里的 kookeey（可经跳板），这样 mail.com 预检能一人一出口。
 */
export async function openNoAuthSocksToAuthedProxy(exitUrl: string, jumpRaw = "") {
    const exit = parseProxyEndpoint(exitUrl);
    if (!exit || !exit.isSocks) throw new Error("出口须是 socks5");
    const server = net.createServer((client) => {
        (async () => {
            const hello = await readExact(client, 2);
            if (hello[0] !== 0x05) throw new Error("不是 socks5");
            await readExact(client, hello[1]);
            client.write(Buffer.from([0x05, 0x00]));
            const hdr = await readExact(client, 4);
            if (hdr[1] !== 0x01) throw new Error("只支持 CONNECT");
            let destHost = "";
            let destPort = 0;
            if (hdr[3] === 1) {
                const rest = await readExact(client, 6);
                destHost = `${rest[0]}.${rest[1]}.${rest[2]}.${rest[3]}`;
                destPort = rest.readUInt16BE(4);
            } else if (hdr[3] === 3) {
                const lb = await readExact(client, 1);
                const rest = await readExact(client, lb[0] + 2);
                destHost = rest.subarray(0, lb[0]).toString("utf8");
                destPort = rest.readUInt16BE(lb[0]);
            } else if (hdr[3] === 4) {
                const rest = await readExact(client, 18);
                destHost = rest.subarray(0, 16).toString("hex");
                destPort = rest.readUInt16BE(16);
            } else throw new Error("不支持的地址类型");
            let up: net.Socket;
            if (jumpRaw) {
                const raw = await connectViaJumpRetry(jumpRaw, exit.host, exit.port, 3);
                up = await socks5ConnectOnSocket(raw, exit.user, exit.pass, destHost, destPort);
            } else {
                const r = await SocksClient.createConnection({
                    proxy: {
                        host: exit.host, port: exit.port, type: 5,
                        userId: exit.user || undefined, password: exit.pass || undefined,
                    },
                    command: "connect",
                    destination: {host: destHost, port: destPort},
                    timeout: 15000,
                });
                up = r.socket;
            }
            client.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
            client.on("error", () => { try { up.destroy(); } catch { /* */ } });
            up.on("error", () => { try { client.destroy(); } catch { /* */ } });
            client.on("close", () => { try { up.destroy(); } catch { /* */ } });
            up.on("close", () => { try { client.destroy(); } catch { /* */ } });
            client.pipe(up);
            up.pipe(client);
        })().catch(() => {
            try { client.write(Buffer.from([0x05, 0x01, 0x00, 0x01, 0, 0, 0, 0, 0, 0])); } catch { /* */ }
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
        throw new Error("无账密 socks 端口分配失败");
    }
    return {
        url: `socks5://127.0.0.1:${port}`,
        localPort: port,
        close() { try { server.close(); } catch { /* */ } },
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
        const m = pass.match(/-([A-Za-z]{2}|global)-(\d+)(?:-(\d+m))?$/i);
        if (m && KOOK_COUNTRY_TZ[m[1].toUpperCase()]) return KOOK_COUNTRY_TZ[m[1].toUpperCase()];
    } catch { /* */ }
    return "";
}
