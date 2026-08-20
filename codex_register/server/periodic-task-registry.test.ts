import assert from "node:assert/strict";
import test from "node:test";
import {createPeriodicTaskRegistry} from "./periodic-task-registry.js";

test("同名轮询只注册一次并可统一释放", () => {
    let nextId = 0;
    const active = new Set<number>();
    const registry = createPeriodicTaskRegistry({
        clock: {
            setInterval: () => { const id = ++nextId; active.add(id); return id; },
            clearInterval: (id) => active.delete(id),
        },
    });

    assert.equal(registry.every("jobs", 1000, () => {}), true);
    assert.equal(registry.every("jobs", 1000, () => {}), false);
    assert.equal(active.size, 1);
    registry.stopAll();
    assert.equal(active.size, 0);
});
