import assert from "node:assert/strict";
import {EventEmitter} from "node:events";
import {PassThrough} from "node:stream";
import test from "node:test";
import {createGmailRebindChangeWorker} from "./gmail-rebind-change-worker.js";

function fakeChild() {
    return Object.assign(new EventEmitter(), {
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        signals: [] as string[],
        kill(signal) { this.signals.push(signal); },
    });
}

test("取消正在执行的官方换绑会终止 Worker", async () => {
    const child = fakeChild();
    const controller = new AbortController();
    const run = createGmailRebindChangeWorker({
        root: process.cwd(),
        tsxBin: "tsx",
        timeoutMs: 60_000,
        pickProxy: async () => "http://127.0.0.1:10808",
        maskProxy: (value) => value,
        spawnProcess: () => child,
    });

    const pending = run({accessToken: "at", newEmail: "target@gmail.com", imapPassword: "imap", signal: controller.signal});
    await new Promise((resolve) => setImmediate(resolve));
    controller.abort();
    const result = await pending;

    assert.equal(result.cancelled, true);
    assert.equal(result.indeterminate, false);
    assert.deepEqual(child.signals, ["SIGTERM"]);
    child.emit("close");
});

test("verify 阶段取消标记为状态不确定", async () => {
    const child = fakeChild();
    const controller = new AbortController();
    const stages = [];
    const run = createGmailRebindChangeWorker({
        root: process.cwd(),
        tsxBin: "tsx",
        timeoutMs: 60_000,
        pickProxy: async () => "http://127.0.0.1:10808",
        maskProxy: (value) => value,
        spawnProcess: () => child,
    });

    const pending = run({
        accessToken: "at",
        newEmail: "target@gmail.com",
        imapPassword: "imap",
        signal: controller.signal,
        onStage: (stage) => stages.push(stage),
    });
    await new Promise((resolve) => setImmediate(resolve));
    child.stdout.write('@@EVENT@@{"type":"progress","stage":"verify"}\n');
    controller.abort();
    const result = await pending;

    assert.equal(result.cancelled, true);
    assert.equal(result.indeterminate, true);
    assert.deepEqual(stages, ["verify"]);
    child.emit("close");
});
