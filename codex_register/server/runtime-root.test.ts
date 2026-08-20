import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import {resolveProjectRoot, resolveTsxCommand, resolveWorkerCommand} from "./runtime-root.js";

test("bundle 运行时优先使用 Node worker，不依赖 tsx", () => {
    const root = process.cwd();
    const command = resolveWorkerCommand(
        pathToFileUrl(path.join(root, "bundle", "server.mjs")),
        root,
        "scripts/worker-mailcom-task.ts",
        "bundle/workers/worker-mailcom-task.mjs",
    );

    assert.equal(command.bundled, true);
    assert.equal(command.command, process.execPath);
    assert.equal(command.args[0], path.join(root, "bundle", "workers", "worker-mailcom-task.mjs"));
});

test("源码运行时仍能解析本地 TSX", () => {
    const root = resolveProjectRoot(pathToFileUrl(path.join(process.cwd(), "server", "runtime-root.ts")));
    const command = resolveTsxCommand(root);
    assert.ok(command.command);
    assert.deepEqual(command.args, []);
});

function pathToFileUrl(filePath) {
    return new URL(`file://${filePath.split(path.sep).map(encodeURIComponent).join("/")}`).href;
}
