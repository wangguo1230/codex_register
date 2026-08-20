import assert from "node:assert/strict";
import {EventEmitter} from "node:events";
import test from "node:test";
import {createChatWorkerRunner} from "./chat-worker-runner.js";

function createHarness(overrides = {}) {
    const statuses = [];
    const logs = [];
    const service = createChatWorkerRunner({
        runtime: {
            spawn: overrides.spawn || (() => new EventEmitter()),
            cleanEnv: (env) => env,
            pipeOutput: overrides.pipeOutput || (() => {}),
        },
        credentials: {readAuth: () => null},
        proxy: {pick: overrides.pickProxy || (async () => "socks5://127.0.0.1:10808")},
        effects: {
            setStatus: async (...args) => { statuses.push(args); },
            log: (...args) => { logs.push(args); },
            logError: (...args) => { logs.push(args); },
        },
    });
    return {service, statuses, logs};
}

test("代理选择异常时 Chat Worker 立即失败而不悬挂", async () => {
    const {service, statuses} = createHarness({pickProxy: async () => { throw new Error("proxy failed"); }});

    const result = await service.run({id: 1, auth_file: "auth.json"}, "hello");

    assert.deepEqual(result, {ok: false, reason: "proxy failed"});
    assert.match(statuses.at(-1)[2], /启动失败/);
});

test("Worker error 与 close 竞态只执行一次收尾", async () => {
    const child = new EventEmitter();
    const {service, statuses} = createHarness({spawn: () => child});
    const pending = service.run({id: 1, auth_file: "auth.json"}, "hello");
    await new Promise((resolve) => setImmediate(resolve));

    child.emit("error", new Error("spawn failed"));
    child.emit("close", 1);
    const result = await pending;

    assert.equal(result.ok, false);
    assert.equal(statuses.filter((entry) => entry[1] === "chat").length, 2);
    assert.match(statuses.at(-1)[2], /启动失败/);
});

test("结构化结果关闭时写入成功状态", async () => {
    const child = new EventEmitter();
    let handlers;
    const {service, statuses} = createHarness({
        spawn: () => child,
        pipeOutput: (_child, value) => { handlers = value; },
    });
    const pending = service.run({id: 1, auth_file: "auth.json"}, "hello");
    await new Promise((resolve) => setImmediate(resolve));

    handlers.onEvent({type: "result", ok: true, text: "reply"});
    child.emit("close", 0);

    assert.deepEqual(await pending, {type: "result", ok: true, text: "reply"});
    assert.equal(statuses.at(-1)[2], "✅回复成功");
});
