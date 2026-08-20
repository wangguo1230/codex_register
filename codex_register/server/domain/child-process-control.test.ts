import assert from "node:assert/strict";
import test from "node:test";
import {terminateChildProcess} from "./child-process-control.js";

test("终止器先 TERM，宽限期后 KILL，退出后可取消强杀", () => {
    const callbacks = new Map<number, () => void>();
    let nextId = 0;
    const child = {signals: [] as string[], kill(signal) { this.signals.push(signal); }};
    const cancel = terminateChildProcess(child, {
        graceMs: 1000,
        clock: {
            setTimeout(fn) { const id = ++nextId; callbacks.set(id, fn); return id; },
            clearTimeout(id) { callbacks.delete(id); },
        },
    });

    assert.deepEqual(child.signals, ["SIGTERM"]);
    callbacks.get(1)?.();
    assert.deepEqual(child.signals, ["SIGTERM", "SIGKILL"]);
    cancel();
    assert.equal(callbacks.size, 0);
});
