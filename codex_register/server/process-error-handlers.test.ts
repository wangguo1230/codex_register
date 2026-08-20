import assert from "node:assert/strict";
import {EventEmitter} from "node:events";
import test from "node:test";
import {installProcessErrorHandlers, isImapTlsCrash} from "./process-error-handlers.js";

test("仅将 IMAP TLS 记录损坏识别为可恢复异常", () => {
    assert.equal(isImapTlsCrash(new Error("ImapFlow TLS bad record mac")), true);
    assert.equal(isImapTlsCrash(new Error("TLS certificate expired")), false);
});

test("未知未捕获异常保持退出语义且卸载后不再响应", () => {
    const runtime = new EventEmitter() as EventEmitter & {exit: (code: number) => void};
    const exits: number[] = [];
    const errors: unknown[] = [];
    runtime.exit = (code) => { exits.push(code); };
    const uninstall = installProcessErrorHandlers({
        runtime,
        logger: {warn() {}, error: (...args) => errors.push(args)},
    });

    runtime.emit("uncaughtException", new Error("boom"));
    assert.deepEqual(exits, [1]);
    assert.equal(errors.length, 1);

    uninstall();
    runtime.emit("uncaughtException", new Error("after uninstall"));
    assert.deepEqual(exits, [1]);
});
