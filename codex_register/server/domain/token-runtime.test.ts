import assert from "node:assert/strict";
import {PassThrough} from "node:stream";
import test from "node:test";
import {createGptProxyLease, createGptProxyExitTracker, pickBrowserCompatibleProxy, proxyHasSocksAuth} from "./gpt-proxy-lease.js";
import {createTokenCredentials} from "./token-credentials.js";
import {pipeWorkerOutput} from "./worker-output.js";

test("Token 凭证兼容 session、顶层字段和 JWT account id", () => {
    const credentials = createTokenCredentials({
        readJson: () => ({refresh_token: "file-rt"}),
        decodeJwt: () => ({"https://api.openai.com/auth": {chatgpt_account_id: "jwt-account"}}),
    });

    assert.deepEqual(credentials.extract({session: {accessToken: "at"}, refresh_token: "rt"}), {
        accessToken: "at",
        refreshToken: "rt",
        accountId: "jwt-account",
        raw: {session: {accessToken: "at"}, refresh_token: "rt"},
    });
    assert.equal(credentials.readFile("token.json").refreshToken, "file-rt");
});

test("GPT 出口与跳板租约在任务异常时仍成对释放", async () => {
    const released = [];
    const withLease = createGptProxyLease({
        proxyPool: {lease: async () => ({url: "socks5://exit", release: () => released.push("exit")})},
        jumpPool: {urls: ["socks5://jump"], lease: async () => ({url: "socks5://jump", release: () => released.push("jump")})},
        settings: {
            rechargeProxy: () => "http://127.0.0.1:10808",
            hasJumpConfig: () => true,
            configuredJump: () => "",
            hasPoolConfig: () => true,
        },
        maskProxyUrl: (value) => value,
    });

    await assert.rejects(() => withLease("owner", async () => { throw new Error("task failed"); }), /task failed/);
    assert.deepEqual(released, ["exit", "jump"]);
});

test("代理池忙时回退充值代理且禁止 socks5 账密进入浏览器", async () => {
    const withLease = createGptProxyLease({
        proxyPool: {lease: async () => { throw new Error("代理池全忙"); }},
        jumpPool: {urls: []},
        settings: {
            rechargeProxy: () => "http://127.0.0.1:10808",
            hasJumpConfig: () => false,
            configuredJump: () => "",
            hasPoolConfig: () => true,
        },
        maskProxyUrl: (value) => value,
    });

    assert.equal(await withLease("owner", async (proxy, jump) => `${proxy}|${jump}`), "http://127.0.0.1:10808|");
    assert.equal(proxyHasSocksAuth("socks5://user:pass@example.com:1080"), true);
    assert.equal(pickBrowserCompatibleProxy("socks5://u:p@example.com:1080", "http://127.0.0.1:10808"), "http://127.0.0.1:10808");
});

test("GPT 代理出口 IP 在冷却期重复时自动轮到下一个代理", async () => {
    const released = [];
    const urls = ["socks5://exit-a.example:1080", "socks5://exit-b.example:1080"];
    const leaseSequence = [urls[0], urls[0], urls[1]];
    let index = 0;
    let active = 0;
    const proxyPool = {
        lease: async () => {
            assert.equal(active, 0, "轮换前必须释放上一个出口租约");
            const url = leaseSequence[Math.min(index++, leaseSequence.length - 1)];
            active += 1;
            return {url, release: () => { active -= 1; released.push(url); }};
        },
    };
    const withLease = createGptProxyLease({
        proxyPool,
        jumpPool: {urls: []},
        exitTracker: createGptProxyExitTracker({cooldownMs: 60 * 60 * 1000}),
        probeExit: async (url) => ({ip: url.includes("exit-a") ? "203.0.113.10" : "203.0.113.11"}),
        settings: {
            rechargeProxy: () => "",
            hasJumpConfig: () => false,
            configuredJump: () => "",
            hasPoolConfig: () => true,
        },
        maskProxyUrl: (value) => value,
    });

    assert.equal(await withLease("first-account", async (proxy) => proxy), urls[0]);
    assert.equal(await withLease("second-account", async (proxy) => proxy, {timeoutMs: 2_000}), urls[1]);
    assert.deepEqual(released, [urls[0], urls[0], urls[1]]);
});

test("GPT 代理出口缓存命中时仍重新预约共享 IP 冷却", async () => {
    let observed = null;
    const tracker = {
        get: () => observed ? {...observed} : null,
        needsProbe: () => !observed,
        reserve: () => true,
        update: (_owner, url, ip) => { observed = {url, ip, checkedAt: Date.now()}; },
    };
    const reservations = [];
    const withLease = createGptProxyLease({
        proxyPool: {lease: async () => ({url: "socks5://exit.example:1080", release() {}})},
        jumpPool: {urls: []},
        exitTracker: tracker,
        probeExit: async () => ({ip: "203.0.113.20"}),
        reserveExitIp: async (value) => { reservations.push(value.ip); return reservations.length === 1; },
        settings: {
            rechargeProxy: () => "",
            hasJumpConfig: () => false,
            configuredJump: () => "",
            hasPoolConfig: () => true,
        },
        maskProxyUrl: (value) => value,
    });

    await withLease("cached-account", async (proxy) => proxy);
    await assert.rejects(() => withLease("cached-account", async (proxy) => proxy, {timeoutMs: 1_200}), /代理出口 IP 重复/);
    // The shared cooldown conflict causes one additional bounded rotation attempt.
    assert.equal(reservations.length, 3);
    assert.ok(reservations.every((ip) => ip === "203.0.113.20"));
});

test("Worker 输出解析事件、限制普通行长度并标记 stderr", () => {
    const child = {stdout: new PassThrough(), stderr: new PassThrough()};
    const lines = [];
    const events = [];
    pipeWorkerOutput(child, {onLine: (line) => lines.push(line), onEvent: (event) => events.push(event), maxBuf: 1024});

    child.stdout.write(`@@EVENT@@{"type":"progress"}\n${"x".repeat(300)}\n`);
    child.stderr.write("network failed");

    assert.deepEqual(events, [{type: "progress"}]);
    assert.equal(lines[0].length, 220);
    assert.equal(lines[1], "[err] network failed");
});
