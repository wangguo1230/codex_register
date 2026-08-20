import assert from "node:assert/strict";
import test from "node:test";
import {createProxyPoolRepository} from "./proxy-pool-repository.js";

function acquireHarness({activeCount = 0, enabled = true, occupiedLeaseKey = ""} = {}) {
    const calls: Array<{text: string; values?: unknown[]}> = [];
    const client = {
        async query(queryOrText: string | {text: string}, values?: unknown[]) {
            const text = typeof queryOrText === "string" ? queryOrText : queryOrText.text;
            calls.push({text, values});
            if (/SELECT exit_mail_enabled/.test(text)) return {rows: [{enabled}]};
            if (/SELECT resource_key, url, template_key/.test(text)) {
                return {rows: [{resource_key: "proxy-a", url: "socks5://a", template_key: "template-a"}]};
            }
            if (/SELECT COUNT\(\*\)/.test(text)) return {rows: [{count: activeCount}]};
            if (/SELECT 1 FROM proxy_pool_leases/.test(text)) {
                return {rows: values?.[2] === occupiedLeaseKey && occupiedLeaseKey ? [{}] : []};
            }
            return {rows: [], rowCount: 1};
        },
    };
    const repository = createProxyPoolRepository({
        instance: "test-instance",
        clock: {now: () => 1_000},
        queryFn: async () => ({rows: [], rowCount: 0}),
        transactionFn: async (fn) => fn(client),
    });
    return {repository, calls};
}

test("公共代理租约使用行锁和模板事务锁，并返回 fencing token", async () => {
    const {repository, calls} = acquireHarness();
    const result = await repository.acquire({
        kind: "exit",
        scope: "mail",
        owner: "mail-job",
        maxPerTemplate: 1,
        leaseMs: 60_000,
        candidates: [{
            resourceKey: "proxy-a",
            baseUrl: "socks5://a",
            leaseKey: "proxy-a",
            templateKey: "template-a",
            liveUrl: "socks5://live-a",
        }],
    });

    assert.equal(result?.url, "socks5://live-a");
    assert.match(result?.leaseToken || "", /^[0-9a-f-]{36}$/);
    assert.ok(calls.some(({text}) => /FOR UPDATE SKIP LOCKED/.test(text)));
    assert.ok(calls.some(({text}) => /pg_advisory_xact_lock/.test(text)));
    const insert = calls.find(({text}) => /INSERT INTO proxy_pool_leases/.test(text));
    assert.equal(insert?.values?.[5], "test-instance:mail-job");
    assert.equal(insert?.values?.[7], 61_000);
});

test("公共代理租约达到模板并发上限时不认领", async () => {
    const {repository} = acquireHarness({activeCount: 1});
    const result = await repository.acquire({
        kind: "exit",
        owner: "second",
        maxPerTemplate: 1,
        candidates: [{resourceKey: "proxy-a", leaseKey: "proxy-a", liveUrl: "socks5://a"}],
    });
    assert.equal(result, null);
});

test("基础租约已占用但模板仍有容量时转用动态 session", async () => {
    const {repository} = acquireHarness({activeCount: 1, occupiedLeaseKey: "proxy-a"});
    const result = await repository.acquire({
        kind: "exit",
        owner: "second",
        maxPerTemplate: 2,
        candidates: [
            {resourceKey: "proxy-a", leaseKey: "proxy-a", liveUrl: "socks5://a"},
            {resourceKey: "proxy-a", leaseKey: "extra:template-a:2", liveUrl: "socks5://session-2"},
        ],
    });
    assert.equal(result?.url, "socks5://session-2");
    assert.equal(result?.leaseKey, "extra:template-a:2");
});

test("禁用业务范围时公共代理租约直接返回空", async () => {
    const {repository, calls} = acquireHarness({enabled: false});
    const result = await repository.acquire({
        kind: "exit",
        scope: "mail",
        owner: "mail-job",
        candidates: [{resourceKey: "proxy-a", leaseKey: "proxy-a", liveUrl: "socks5://a"}],
    });
    assert.equal(result, null);
    assert.equal(calls.some(({text}) => /INSERT INTO proxy_pool_leases/.test(text)), false);
});
