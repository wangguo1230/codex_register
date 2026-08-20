import assert from "node:assert/strict";
import {EventEmitter} from "node:events";
import test from "node:test";
import {createMailSendWorkerRunner} from "./mail-send-worker-runner.js";

function fakeChild() {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.signals = [];
    child.kill = (signal) => { child.signals.push(signal); return true; };
    return child;
}

test("发信 Worker 能解析跨 chunk 的结构化结果", async () => {
    const child = fakeChild();
    const runner = createMailSendWorkerRunner({
        rootDir: process.cwd(),
        timeoutMs: 5000,
        spawnProcess: () => child,
    });
    const running = runner.run({email: "a@mail.com"});

    child.stdout.emit("data", "@@RES");
    child.stdout.emit("data", 'ULT@@{"ok":true,"status":200}\n');
    child.emit("close", 0);

    assert.deepEqual(await running, {ok: true, status: 200});
    assert.equal(runner.activeCount(), 0);
});

test("发信 Worker 结构化失败事件会写入日志并返回原因", async () => {
    const child = fakeChild();
    const logs = [];
    const runner = createMailSendWorkerRunner({
        rootDir: process.cwd(),
        timeoutMs: 5000,
        spawnProcess: () => child,
    });
    const running = runner.run({email: "a@mail.com"}, (line) => logs.push(line)).catch((error) => error);

    child.stdout.emit("data", '@@RESULT@@{"ok":false,"error":"代理连接失败"}\n');
    child.emit("close", 1);

    const error = await running;
    assert.match(error.message, /代理连接失败/);
    assert.ok(logs.some((line) => /worker.*失败.*代理连接失败/.test(line)));
    assert.equal(runner.activeCount(), 0);
});

test("停止批量发信会终止全部活跃 Worker", async () => {
    const children = [fakeChild(), fakeChild()];
    const runner = createMailSendWorkerRunner({
        rootDir: process.cwd(),
        timeoutMs: 5000,
        spawnProcess: () => children.shift(),
    });
    const firstChild = children[0];
    const secondChild = children[1];
    const first = runner.run({email: "a@mail.com"}).catch((error) => error);
    const second = runner.run({email: "b@mail.com"}).catch((error) => error);

    assert.equal(runner.stopAll(), 2);
    assert.deepEqual(firstChild.signals, ["SIGTERM"]);
    assert.deepEqual(secondChild.signals, ["SIGTERM"]);
    firstChild.emit("close", null);
    secondChild.emit("close", null);
    await Promise.all([first, second]);
    assert.equal(runner.activeCount(), 0);
});
