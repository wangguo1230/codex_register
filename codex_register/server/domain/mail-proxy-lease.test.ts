import assert from "node:assert/strict";
import test from "node:test";
import {createMailProxyLease} from "./mail-proxy-lease.js";

function lease(url, released) {
    return {url, release: () => { released.push(url); }};
}

test("任务结束后成对释放出口和跳板租约", async () => {
    const released = [];
    const withLease = createMailProxyLease({
        proxyPool: {lease: async () => lease("socks5://exit", released)},
        jumpPool: {urls: ["socks5://jump"], lease: async () => lease("socks5://jump", released)},
        getFallbackProxy: () => "",
        getFallbackJump: () => "",
    });

    const result = await withLease("owner", async (proxyUrl, jumpUrl) => `${proxyUrl}|${jumpUrl}`);
    assert.equal(result, "socks5://exit|socks5://jump");
    assert.deepEqual(released, ["socks5://exit", "socks5://jump"]);
});

test("跳板租约失败时仍释放已经取得的出口", async () => {
    const released = [];
    const withLease = createMailProxyLease({
        proxyPool: {lease: async () => lease("socks5://exit", released)},
        jumpPool: {urls: ["socks5://jump"], lease: async () => { throw new Error("jump busy"); }},
    });

    await assert.rejects(() => withLease("owner", async () => {}), /jump busy/);
    assert.deepEqual(released, ["socks5://exit"]);
});

test("skipJump 不租跳板并传入空跳板地址", async () => {
    let jumpCalls = 0;
    const withLease = createMailProxyLease({
        proxyPool: {lease: async () => ({url: "socks5://exit", release: () => {}})},
        jumpPool: {urls: ["socks5://jump"], lease: async () => { jumpCalls++; return {url: "", release: () => {}}; }},
        getFallbackJump: () => "socks5://fallback",
    });

    const result = await withLease("owner", async (_proxyUrl, jumpUrl) => jumpUrl, null, {skipJump: true});
    assert.equal(result, "");
    assert.equal(jumpCalls, 0);
});

test("取消信号传给租约池并释放已经取得的出口", async () => {
    const released = [];
    const controller = new AbortController();
    const withLease = createMailProxyLease({
        proxyPool: {lease: async (_owner, options) => {
            assert.equal(options.signal, controller.signal);
            return lease("socks5://exit", released);
        }},
        jumpPool: {urls: ["socks5://jump"], lease: async (_owner, options) => {
            assert.equal(options.signal, controller.signal);
            controller.abort();
            throw new Error("任务已取消");
        }},
    });

    await assert.rejects(
        () => withLease("owner", async () => {}, null, {signal: controller.signal}),
        /任务已取消/,
    );
    assert.deepEqual(released, ["socks5://exit"]);
});
