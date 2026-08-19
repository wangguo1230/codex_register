// 协议出网冒烟：跳板→kookeey→google / auth.openai.com（不经本机 socks）
import {connectExitViaJump} from "../src/mail/proxy-chain.js";
import tls from "node:tls";

function race<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
    return Promise.race([
        p,
        new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`${label} timeout ${ms}ms`)), ms)),
    ]);
}

async function head(socket: any, host: string, path = "/", ms = 15000) {
    return race(new Promise<string>((resolve, reject) => {
        const t = tls.connect({socket, servername: host, rejectUnauthorized: false}, () => {
            t.write(`HEAD ${path} HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`);
        });
        let buf = "";
        t.on("data", (c) => { buf += c.toString("latin1"); });
        t.on("end", () => resolve((buf.split("\r\n")[0] || "").slice(0, 80)));
        t.on("error", reject);
    }), ms, `tls:${host}`);
}

async function main() {
    console.log("start");
    const pool = await fetch("http://127.0.0.1:3100/api/gpt/proxy-pool").then((r) => r.json());
    const exit = String(pool.urls?.[0] || "").trim();
    const jump = String(pool.jump || "").trim();
    console.log("pool", {n: pool.urls?.length || 0, hasJump: !!jump});
    if (!exit || !jump) {
        console.log("NO_POOL");
        process.exit(2);
    }
    const t0 = Date.now();
    console.log("connecting google…");
    const g = await connectExitViaJump(exit, jump, "www.google.com", 443);
    const gLine = await head(g, "www.google.com", "/generate_204");
    try { g.destroy(); } catch { /* */ }
    console.log("GOOGLE", gLine, `${Date.now() - t0}ms`);

    const t1 = Date.now();
    const o = await connectExitViaJump(exit, jump, "auth.openai.com", 443);
    const oLine = await head(o, "auth.openai.com", "/");
    try { o.destroy(); } catch { /* */ }
    console.log("OPENAI", oLine, `${Date.now() - t1}ms`);
}

main().catch((e) => {
    console.log("FAIL", String(e?.message || e).slice(0, 200));
    process.exit(1);
});
