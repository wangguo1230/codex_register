import {wrapExitThroughJump} from "../src/mail/proxy-chain.ts";
import {createProtocolDispatcher} from "../src/mail/protocol-dispatcher.ts";
import {mintStickySession, kookeeySessionOf, normalizeProxyUrl} from "../src/mail/proxy-pool.ts";

const jump = "socks5://127.0.0.1:10811";
const pool = [
    "socks5://2199381-9415e9b1:65b2d2ca-global-73831395@gate.kookeey.info:1000",
    "socks5://2199381-9415e9b1:65b2d2ca-global-84848019@gate.kookeey.info:1000",
];

async function ipVia(exit, label) {
    const sess = kookeeySessionOf(exit);
    const t0 = Date.now();
    let wrapped;
    try {
        wrapped = await wrapExitThroughJump(exit, jump);
        delete process.env.MAIL_PROXY_JUMP;
        const d = createProtocolDispatcher(wrapped.url);
        const ac = new AbortController();
        const timer = setTimeout(() => ac.abort(), 12000);
        const res = await fetch("https://api.ipify.org", {dispatcher: d, signal: ac.signal});
        clearTimeout(timer);
        const ip = (await res.text()).trim();
        console.log("OK ", label, `sess=${sess}`, `ip=${ip}`, `${Date.now() - t0}ms`);
        return ip;
    } catch (e) {
        console.log("FAIL", label, `sess=${sess}`, `${Date.now() - t0}ms`, String(e?.message || e).slice(0, 100), e?.cause?.message || "");
        return "";
    } finally {
        try { wrapped?.close(); } catch { /* */ }
    }
}

console.log("== 池子里两条原粘性 ==");
const a = await ipVia(normalizeProxyUrl(pool[0]), "pool-1");
const b = await ipVia(normalizeProxyUrl(pool[1]), "pool-2");

console.log("\n== 同一条池子 mint 两次（和 freshSession 一样）==");
const m1 = mintStickySession(pool[0]);
const m2 = mintStickySession(pool[0]);
const c = await ipVia(m1, "mint-1");
const d = await ipVia(m2, "mint-2");

console.log("\n== 对照 ==");
console.log("pool-1 vs pool-2", a && b ? (a === b ? "同一出口IP" : "不同出口IP") : "测不全");
console.log("mint-1 vs mint-2", c && d ? (c === d ? "同一出口IP" : "不同出口IP") : "测不全");
console.log("pool-1 vs mint-1", a && c ? (a === c ? "同一出口IP" : "不同出口IP") : "测不全");
