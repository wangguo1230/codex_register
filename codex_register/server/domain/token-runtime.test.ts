import assert from "node:assert/strict";
import {PassThrough} from "node:stream";
import test from "node:test";
import {createGptProxyLease, pickBrowserCompatibleProxy, proxyHasSocksAuth} from "./gpt-proxy-lease.js";
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
