import assert from "node:assert/strict";
import {EventEmitter} from "node:events";
import test from "node:test";
import {createAccountReloginRunner, isAccountDeadReason, isAuthorizeRateLimited, isReloginRetryable} from "./account-relogin-runner.js";

function createHarness(overrides = {}) {
    let credentialWrites = 0;
    const runner = createAccountReloginRunner({
        runtime: {
            spawn: overrides.spawn || (() => { throw new Error("spawn should not run"); }),
            cleanEnv: (env) => env,
            pipeOutput() {},
            attachChild() {},
        },
        store: {
            updateAccount: async () => {},
            updateQueueAuth: async () => 0,
        },
        files: {
            writeCredential: () => { credentialWrites++; },
            readJson: () => ({}),
        },
        settings: {
            resolveExitProxy: overrides.resolveExitProxy || (() => ""),
            defaultJump: () => "",
            rechargeProxy: () => "",
            rtProxy: () => "",
            regProxy: () => "",
            mailProxyEnabled: () => true,
            mailProxy: () => "",
            defaultPassword: () => "default-password",
            poolSize: () => 0,
        },
        proxy: {
            pickXray: overrides.pickXray || (async () => ""),
            pickMailBrowser: () => "",
            hasSocksAuth: () => false,
            mask: (value) => value,
            withLease: async () => { throw new Error("unused"); },
        },
        effects: {
            logAccount() {},
            syncQueue: async () => {},
            snapshot: async () => {},
        },
    });
    return {runner, credentialWrites: () => credentialWrites};
}

test("无代理时重登立即失败且不创建临时凭证", async () => {
    const {runner, credentialWrites} = createHarness();

    const result = await runner.spawnOne({id: 1, email: "a@example.com"});

    assert.equal(result.ok, false);
    assert.match(result.reason, /无可用代理/);
    assert.equal(credentialWrites(), 0);
});

test("代理选择异常被收敛为失败结果", async () => {
    const {runner} = createHarness({
        resolveExitProxy: () => "socks5://exit",
        pickXray: async () => { throw new Error("xray failed"); },
    });

    const result = await runner.spawnOne({id: 1, email: "a@example.com"}, {script: "src/worker-register-browser.ts"});

    assert.deepEqual(result, {ok: false, reason: "选择重登代理失败: xray failed"});
});

test("重登错误分类阻止账号失效和 429 的无效重试", () => {
    assert.equal(isAccountDeadReason("account_deactivated"), true);
    assert.equal(isAuthorizeRateLimited("429 too many requests"), true);
    assert.equal(isReloginRetryable("TLS fetch failed"), true);
    assert.equal(isReloginRetryable("429 too many requests"), false);
});

test("Worker 持续输出时仍受绝对运行上限约束", async () => {
    const child = Object.assign(new EventEmitter(), {
        signals: [] as string[],
        kill(signal) { this.signals.push(signal); },
    });
    let outputHandlers;
    const runner = createAccountReloginRunner({
        runtime: {
            spawn: () => child,
            cleanEnv: (env) => env,
            pipeOutput: (_child, handlers) => { outputHandlers = handlers; },
        },
        store: {updateAccount: async () => {}, updateQueueAuth: async () => 0},
        files: {writeCredential() {}, readJson: () => ({})},
        settings: {
            resolveExitProxy: () => "http://127.0.0.1:10808",
            defaultJump: () => "",
            rechargeProxy: () => "",
            rtProxy: () => "",
            regProxy: () => "",
            mailProxyEnabled: () => false,
            mailProxy: () => "",
            defaultPassword: () => "password",
            poolSize: () => 0,
        },
        proxy: {
            pickXray: async () => "",
            pickMailBrowser: () => "",
            hasSocksAuth: () => false,
            mask: (value) => value,
        },
        effects: {logAccount() {}, syncQueue: async () => {}, snapshot: async () => {}},
        timeouts: {idleFloorMs: 5, maxMs: 12, graceMs: 3},
    });

    const pulse = setInterval(() => outputHandlers?.onLine("progress"), 2);
    const result = await runner.spawnOne({id: 1, email: "a@example.com", password: "mail-password"}, {timeoutMs: 5});
    clearInterval(pulse);

    assert.equal(result.ok, false);
    assert.match(result.reason, /绝对上限/);
    assert.deepEqual(child.signals, ["SIGTERM", "SIGKILL"]);
});
