import assert from "node:assert/strict";
import {existsSync, readdirSync, readFileSync} from "node:fs";
import path from "node:path";
import test from "node:test";

function sourceFiles(root: string) {
    const files: string[] = [];
    const walk = (dir: string) => {
        for (const entry of readdirSync(dir, {withFileTypes: true})) {
            const file = path.join(dir, entry.name);
            if (entry.isDirectory()) walk(file);
            else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) files.push(file);
        }
    };
    walk(root);
    return files;
}

test("服务端相对动态导入都能解析到源码文件", () => {
    const missing = [];
    for (const file of sourceFiles(path.resolve("server"))) {
        const source = readFileSync(file, "utf8");
        for (const match of source.matchAll(/import\(["'](\.{1,2}\/[^"']+)["']\)/g)) {
            const raw = match[1];
            const target = path.resolve(path.dirname(file), raw);
            const candidates = raw.endsWith(".js")
                ? [target, target.replace(/\.js$/, ".ts")]
                : [target];
            if (!candidates.some(existsSync)) missing.push(`${path.relative(process.cwd(), file)} -> ${raw}`);
        }
    }
    assert.deepEqual(missing, []);
});
