import assert from "node:assert/strict";
import test from "node:test";
import {createMailJobCapacityPolicy} from "./mail-job-capacity-policy.js";

function createPolicy({configured = [], urls = [], health = new Map(), running = 0} = {}) {
    const warnings = [];
    const policy = createMailJobCapacityPolicy({
        scheduler: {
            pwConcurrency: 4,
            mailProxyPoolSnap: () => ({slots: 3}),
            collectJumpLines: () => configured,
        },
        jumpPool: {urls, health, checkOne: async (url) => health.get(url)},
        maxExitsPerJump: 2,
        localRunningCount: () => running,
        effects: {warn: (line) => warnings.push(line)},
        now: () => 100_000,
    });
    return {policy, warnings};
}

test("邮箱任务容量统一受代理槽位和本机运行数约束", async () => {
    const h = createPolicy({running: 1});
    assert.equal(h.policy.capacity(), 3);
    assert.equal(h.policy.freeSlots(), 2);
    assert.equal(await h.policy.claimSlots(), 2);
});

test("配置跳板但没有健康入口时禁止认领且告警去重", async () => {
    const h = createPolicy({configured: ["vless://node"]});
    assert.equal(await h.policy.claimSlots(), 0);
    assert.equal(await h.policy.claimSlots(), 0);
    assert.equal(h.warnings.length, 1);
});

test("健康跳板按每跳板出口上限约束认领", async () => {
    const health = new Map([
        ["jump-a", {ok: true, at: 100_000}],
        ["jump-b", {ok: false, at: 100_000}],
    ]);
    const h = createPolicy({configured: ["a", "b"], urls: ["jump-a", "jump-b"], health, running: 1});
    assert.equal(await h.policy.claimSlots(), 1);
});
