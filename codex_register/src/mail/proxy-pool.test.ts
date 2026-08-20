import assert from "node:assert/strict";
import test from "node:test";

import {JumpPool, MailProxyPool} from "./proxy-pool.js";

test("统一代理池可按业务范围生成独立视图但共享租约底层", async () => {
    const pool = new MailProxyPool();
    const mail = "socks5://127.0.0.1:18080";
    const gpt = "socks5://127.0.0.1:18081";
    pool.setUrls([mail, gpt]);

    const lease = await pool.lease("mail-job", {allowedUrls: [mail], fallback: ""});
    assert.equal(lease.url, mail);
    assert.deepEqual(pool.snapshot("", [mail]), {
        total: 1,
        slots: 1,
        leased: 1,
        free: 0,
        items: [{url: mail, masked: "socks5://127.0.0.1:18080", leased: true, owner: "mail-job"}],
    });
    lease.release();
    assert.equal(pool.snapshot("", [gpt]).total, 1);
});

test("统一跳板池的范围快照只展示当前业务可用的跳板", () => {
    const pool = new JumpPool();
    pool.setUrls(["socks5://127.0.0.1:19080", "socks5://127.0.0.1:19081"]);
    assert.equal(pool.snapshot(["socks5://127.0.0.1:19080"]).total, 1);
    assert.equal(pool.snapshot().total, 2);
});

test("代理池替换配置时保留活动租约，避免新任务复用旧出口", async () => {
    const pool = new MailProxyPool();
    const oldUrl = "socks5://127.0.0.1:18082";
    const nextUrl = "socks5://127.0.0.1:18083";
    pool.setUrls([oldUrl]);
    const lease = await pool.lease("running-job", {fallback: "", timeoutMs: 1000});

    pool.setUrls([nextUrl]);
    assert.equal(pool.leased.has(oldUrl), true);
    pool.setUrls([oldUrl]);
    assert.equal(pool.snapshot().items[0].leased, true);

    lease.release();
    assert.equal(pool.leased.size, 0);
});

test("动态 session 的并发上限按代理模板计算，不在不同模板之间互相阻塞", async () => {
    const pool = new MailProxyPool();
    const urls = [
        "socks5://user:pass-US-1001-30m@a.example:1080",
        "socks5://user:pass-US-1002-30m@b.example:1080",
        "socks5://user:pass-US-1003-30m@c.example:1080",
    ];
    pool.setUrls(urls);
    const leases = [];
    try {
        for (const url of urls) leases.push(await pool.lease(`base-${url}`, {maxPerTemplate: 2, freshSession: true}));
        for (const url of urls) leases.push(await pool.lease(`extra-${url}`, {maxPerTemplate: 2, allowedUrls: [url]}));
        assert.equal(leases.length, 6);
        assert.equal(pool.leased.size, 6);
    } finally {
        for (const lease of leases) lease.release();
    }
});

test("跳板池替换配置时保留活动租约直到任务释放", async () => {
    const pool = new JumpPool();
    const oldUrl = "socks5://127.0.0.1:19082";
    const nextUrl = "socks5://127.0.0.1:19083";
    pool.setUrls([oldUrl]);
    pool.health.set(oldUrl, {ok: true, at: Date.now(), ms: 1, ip: "local", google: 204});
    const lease = await pool.lease("running-job", {timeoutMs: 1000});

    pool.setUrls([nextUrl]);
    assert.equal(pool.load(oldUrl), 1);
    pool.setUrls([oldUrl]);
    assert.equal(pool.load(oldUrl), 1);

    lease?.release();
    assert.equal(pool.load(oldUrl), 0);
});

test("分布式出口租约等待远端释放完成后再允许复用", async () => {
    const pool = new MailProxyPool();
    const url = "socks5://127.0.0.1:18084";
    let acquisitions = 0;
    let remoteReleased = false;
    let resolveRelease: (() => void) | null = null;
    pool.setLeaseBackend({
        loadConfiguration: async () => ({initialized: true, exitUrls: [url]}),
        acquire: async () => {
            if (acquisitions > 0 && !remoteReleased) return null;
            acquisitions += 1;
            return {leaseToken: `token-${acquisitions}`, url, resourceKey: url, leaseKey: url};
        },
        release: async () => {
            if (remoteReleased) return true;
            return new Promise<void>((resolve) => {
                resolveRelease = () => {
                    remoteReleased = true;
                    resolve();
                };
            });
        },
        renew: async () => true,
    });

    const first = await pool.lease("first", {timeoutMs: 1000});
    const releasePromise = first.release();
    assert.equal(typeof (releasePromise as Promise<unknown>)?.then, "function");
    assert.equal(remoteReleased, false);

    resolveRelease?.();
    await releasePromise;
    const second = await pool.lease("second", {timeoutMs: 1000});
    assert.equal(second.url, url);
    await second.release();
});
