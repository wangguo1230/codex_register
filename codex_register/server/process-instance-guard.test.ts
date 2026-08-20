import assert from "node:assert/strict";
import {EventEmitter} from "node:events";
import test from "node:test";
import {createProcessInstanceGuard} from "./process-instance-guard.js";

function createHarness(port = 3200) {
    const values = new Map<string, string>();
    const runtime = Object.assign(new EventEmitter(), {
        pid: 42,
        ppid: 21,
        platform: "linux",
        kill() {},
    });
    const files = {
        exists: (file) => values.has(file),
        mkdir() {},
        read: (file) => values.get(file) || "",
        write: (file, value) => { values.set(file, String(value)); },
        unlink: (file) => { values.delete(file); },
    };
    const guard = createProcessInstanceGuard({
        port,
        dataDir: "/tmp/app-data",
        runtime,
        files,
        execute: () => "",
        logger: {log() {}},
    });
    return {guard, runtime, values};
}

test("PID 文件按实际 HTTP 端口隔离", () => {
    const {guard} = createHarness(4321);
    assert.match(guard.pidPath, /http-4321\.pid$/);
});

test("旧实例退出时不删除新实例已经接管的 PID 文件", () => {
    const {guard, values} = createHarness();
    const unregister = guard.registerPid();
    assert.equal(values.get(guard.pidPath), "42");

    values.set(guard.pidPath, "99");
    unregister();
    assert.equal(values.get(guard.pidPath), "99");
});
