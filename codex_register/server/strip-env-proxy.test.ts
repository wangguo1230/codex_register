import assert from "node:assert/strict";
import test from "node:test";
import {cleanSpawnEnv} from "./strip-env-proxy.js";

test("worker 环境不会继承 HTTP 主进程标记", () => {
    const previous = process.env.CODEX_HTTP;
    process.env.CODEX_HTTP = "1";
    try {
        const env = cleanSpawnEnv({WORKER_KIND: "mail-send"});
        assert.equal(env.CODEX_HTTP, undefined);
        assert.equal(env.WORKER_KIND, "mail-send");
    } finally {
        if (previous === undefined) delete process.env.CODEX_HTTP;
        else process.env.CODEX_HTTP = previous;
    }
});
