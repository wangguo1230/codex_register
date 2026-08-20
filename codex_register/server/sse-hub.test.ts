import assert from "node:assert/strict";
import {EventEmitter} from "node:events";
import test from "node:test";
import {createSseHub} from "./sse-hub.js";

test("SSE 转发调度器事件并在连接关闭后释放心跳", async () => {
    const scheduler = new EventEmitter();
    let route;
    const writes: string[] = [];
    const timers = new Set<number>();
    const hub = createSseHub({
        scheduler,
        getInitialState: async () => ({ready: true}),
        getStats: async () => ({total: 1}),
        clock: {
            setInterval: () => { timers.add(1); return 1; },
            clearInterval: (id) => timers.delete(id),
        },
    });
    hub.bindScheduler(["status"]);
    hub.registerRoute({get: (_path, handler) => { route = handler; }});
    const request = new EventEmitter();
    const response = {set() {}, flushHeaders() {}, write: (value) => writes.push(value), end() {}};

    await route(request, response);
    scheduler.emit("status", {id: 1});
    assert.match(writes[0], /event: hello/);
    assert.match(writes[1], /event: status/);
    assert.equal(timers.size, 1);
    request.emit("close");
    assert.equal(timers.size, 0);
    assert.equal(hub.clientCount(), 0);
});

test("SSE 丢弃超过上限的事件", () => {
    const warnings: string[] = [];
    const hub = createSseHub({
        scheduler: new EventEmitter(),
        getInitialState: async () => ({}),
        getStats: async () => ({}),
        maxPayloadBytes: 8,
        logger: {warn: (message) => warnings.push(message)},
    });
    assert.equal(hub.broadcast("large", {value: "0123456789"}), false);
    assert.equal(warnings.length, 1);
});

test("SSE 客户端出现背压时立即断开并释放心跳", async () => {
    const scheduler = new EventEmitter();
    let route;
    let writes = 0;
    let destroyed = 0;
    const timers = new Set<number>();
    const hub = createSseHub({
        scheduler,
        getInitialState: async () => ({}),
        getStats: async () => ({}),
        clock: {
            setInterval: () => { timers.add(1); return 1; },
            clearInterval: (id) => timers.delete(id),
        },
        logger: {warn() {}},
    });
    hub.bindScheduler(["status"]);
    hub.registerRoute({get: (_path, handler) => { route = handler; }});
    const request = new EventEmitter();
    const response = {
        set() {},
        flushHeaders() {},
        write: () => ++writes < 2,
        end() {},
        destroy: () => { destroyed++; },
    };

    await route(request, response);
    scheduler.emit("status", {id: 1});

    assert.equal(destroyed, 1);
    assert.equal(hub.clientCount(), 0);
    assert.equal(timers.size, 0);
});
