import assert from "node:assert/strict";
import test from "node:test";
import {createRechargeLogStore} from "./recharge-log-store.js";

test("日志写盘期间的新记录会合并到下一次异步写入", async () => {
    let releaseFirst;
    const firstWrite = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const writes: string[] = [];
    const store = createRechargeLogStore({
        filePath: "recharge.jsonl",
        writeFile: async (_file, value) => {
            writes.push(String(value));
            if (writes.length === 1) await firstWrite;
        },
    });

    store.append("first");
    const flushing = store.flush();
    await new Promise((resolve) => setImmediate(resolve));
    store.append("second");
    releaseFirst();
    await flushing;

    assert.equal(writes.length, 2);
    assert.match(writes[0], /first/);
    assert.match(writes[1], /second/);
});

test("内存日志窗口保持上限", () => {
    const store = createRechargeLogStore({
        filePath: "recharge.jsonl",
        maxEntries: 2,
        flushDelayMs: 60_000,
        writeFile: async () => {},
    });

    store.append("one");
    store.append("two");
    store.append("three");

    assert.deepEqual(store.list().map((entry) => entry.line), ["two", "three"]);
});
