// Gmail 两段：先邮箱管理(2FA/改密/踢设备/删辅助/IMAP)，成功后再注册 GPT。
// WAIT_IP_ROTATE=1 时串行，失败才等换 IP。
import {spawn} from "node:child_process";
import {readFileSync} from "node:fs";
import path from "node:path";
import {fileURLToPath} from "node:url";
import pg from "pg";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const waitIp = process.env.WAIT_IP_ROTATE === "1";
const conc = waitIp ? 1 : Math.max(1, Math.min(6, Number(process.env.REG_CONCURRENCY || 3)));
const argv = process.argv.slice(2);
let emails = [];
if (argv[0] === "--file" && argv[1]) {
    emails = readFileSync(argv[1], "utf8").split(/\r?\n/).map((s) => s.trim().toLowerCase()).filter((s) => s.includes("@"));
} else if (argv[0] === "--grp" && argv[1]) {
    emails = []; // filled below after pool
} else {
    emails = argv.map((e) => e.trim().toLowerCase()).filter(Boolean);
}
if (argv[0] !== "--grp" && !emails.length) process.exit(1);
const proxies = (process.env.PROXY_URLS || "socks5://127.0.0.1:10808,socks5://127.0.0.1:10809")
    .split(",").map((s) => s.trim()).filter(Boolean);

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function fetchExitIp(proxy) {
    const u = new URL(proxy);
    const {spawnSync} = await import("node:child_process");
    const r = spawnSync("curl", ["-sS", "--max-time", "15", "-x", `socks5h://${u.host}`, "https://1.1.1.1/cdn-cgi/trace"], {encoding: "utf8"});
    const m = String(r.stdout || "").match(/^ip=([0-9.]+)/m);
    return m?.[1] || "";
}

async function waitIpChange(proxy, prev, label) {
    const deadline = Date.now() + 4 * 60 * 1000;
    console.log(`... 等出口 IP 轮换(当前 ${prev || "未知"}) ${label}`);
    while (Date.now() < deadline) {
        await sleep(8000);
        const ip = await fetchExitIp(proxy);
        if (ip && ip !== prev) {
            console.log(`... 出口已换成 ${ip}`);
            return ip;
        }
        if (ip) process.stdout.write(`  still ${ip}\n`);
    }
    const last = await fetchExitIp(proxy);
    console.log(`... 等待超时，继续用 ${last || prev || "未知"}`);
    return last || prev;
}

function runOne(email, proxy): Promise<boolean> {
    return new Promise((resolve) => {
        console.log(`\n>>> START ${email} proxy=${proxy}`);
        const child = spawn("npx", ["tsx", "scripts/reg-gmail-batch.ts", email], {
            cwd: ROOT,
            env: {
                ...process.env,
                PROXY_URL: proxy,
                REG_GOOGLE_SSO: process.env.REG_GOOGLE_SSO || "0",
                GPT_BATCH: process.env.GPT_BATCH || "gmail-test-15",
            },
            shell: false,
        });
        let ok = false;
        const on = (chunk) => {
            const s = chunk.toString();
            process.stdout.write(s);
            if (s.includes(`PERSISTED ${email}`)) ok = true;
        };
        child.stdout.on("data", on);
        child.stderr.on("data", (c) => process.stderr.write(c));
        child.on("close", () => {
            console.log(ok ? `<<< OK ${email}` : `<<< FAIL ${email}`);
            resolve(ok);
        });
    });
}

if (argv[0] === "--grp" && argv[1]) {
    const boot = new pg.Pool({connectionString: process.env.DATABASE_URL || "postgresql://postgres:123456@192.168.1.126:5432/all_register"});
    const {rows} = await boot.query(
        "SELECT email FROM mailboxes WHERE grp=$1 AND deleted_at=0 AND usage<>'gpt' ORDER BY id",
        [argv[1]],
    );
    emails = rows.map((r) => r.email);
    await boot.end();
    if (!emails.length) {
        console.log("no pending emails in", argv[1]);
        process.exit(0);
    }
    console.log("QUEUE", emails.length, emails.join(","));
}
const queue = [...emails];
let i = 0;
let lastIp = "";
let needNewIp = false;
const workers = Array.from({length: Math.min(conc, queue.length)}, async () => {
    while (queue.length) {
        const email = queue.shift();
        const proxy = proxies[i++ % proxies.length];
        if (waitIp) {
            const nowIp = await fetchExitIp(proxy);
            if (needNewIp && lastIp && nowIp && nowIp === lastIp) {
                lastIp = await waitIpChange(proxy, lastIp, email);
            } else if (nowIp) {
                console.log(`... 当前出口 ${nowIp}，开始 ${email}`);
                lastIp = nowIp;
            } else {
                console.log(`... 读不到出口 IP，直接开跑 ${email}`);
            }
        }
        const ok = await runOne(email, proxy);
        if (!ok) console.log("NEED_RETRY", email);
        needNewIp = !ok;
        if (waitIp) {
            const after = await fetchExitIp(proxy);
            if (after) lastIp = after;
        }
    }
});
await Promise.all(workers);
const pool = new pg.Pool({connectionString: process.env.DATABASE_URL || "postgresql://postgres:123456@192.168.1.126:5432/all_register"});
const {rows} = await pool.query(
    "SELECT email, usage, google_stage FROM mailboxes WHERE email = ANY($1) AND deleted_at=0 ORDER BY email",
    [emails],
);
console.log("SUMMARY", rows);
await pool.end();
