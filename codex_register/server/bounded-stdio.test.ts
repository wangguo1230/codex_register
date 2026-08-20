import assert from "node:assert/strict";
import {PassThrough} from "node:stream";
import test from "node:test";
import {attachBoundedStdio, createBoundedOutputParser} from "./bounded-stdio.js";

test("结构化事件允许跨 chunk，stdout 与 stderr 不互相污染", () => {
    const lines: string[] = [];
    const events: unknown[] = [];
    const parser = createBoundedOutputParser({
        onLine: (line) => lines.push(line),
        onEvent: (event) => events.push(event),
        stderrPrefix: "[err] ",
    });

    parser.feedStdout('@@RES');
    parser.feedStderr("network");
    parser.feedStdout('ULT@@{"ok":true}\n');
    parser.feedStderr(" failed\n");

    assert.deepEqual(events, [{ok: true}]);
    assert.deepEqual(lines, ["[err] network failed"]);
});

test("缓冲区有界且 close 时可刷新无换行尾帧", () => {
    const child = {stdout: new PassThrough(), stderr: new PassThrough()};
    const lines: string[] = [];
    const pending = attachBoundedStdio(child, {onLine: (line) => lines.push(line), maxBuf: 1024});

    child.stdout.write("x".repeat(4096));
    assert.ok(pending().length <= 512);
    pending.flush();
    assert.equal(lines[0].length, 512);
    assert.equal(pending(), "");
});
