import assert from "node:assert/strict";
import {EventEmitter} from "node:events";
import test from "node:test";
import {createTokenWorkerRunner} from "./token-worker-runner.js";

test("停止 AT 会终止当前登录 Worker 并返回停止结果", async () => {
    const child = Object.assign(new EventEmitter(), {
        signals: [] as string[],
        kill(signal) { this.signals.push(signal); },
    });
    const runner = createTokenWorkerRunner({
        store: {
            getMailbox: async () => ({provider: "mailcom", password: "mail-pw"}),
            getAccount: async () => ({gpt_password: "gpt-pw"}),
        },
        runtime: {
            spawn: () => child,
            cleanEnv: (env) => env,
            pipeOutput: () => {},
        },
        settings: {
            providerOf: () => "mailcom",
            regProxy: () => "http://127.0.0.1:10808",
            mailProxy: () => "",
            defaultPassword: () => "",
        },
        files: {
            writeCredential: () => {},
            readTokens: () => ({}),
        },
        withProxy: async (_owner, task) => task("http://127.0.0.1:10808", ""),
        pickMailProxy: async () => "",
        effects: {log: () => {}},
    });

    const pending = runner.runAt("user@example.com", "mail-pw");
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(runner.stopAt(), true);
    assert.deepEqual(child.signals, ["SIGTERM"]);
    child.emit("exit", 0);
    assert.deepEqual(await pending, {ok: false, reason: "已停止"});
});
