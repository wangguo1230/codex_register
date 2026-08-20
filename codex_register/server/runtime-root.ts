// @ts-nocheck
// 源码和 bundle 的 import.meta.url 层级不同，统一解析项目根目录。
import {existsSync} from "node:fs";
import path from "node:path";
import {fileURLToPath} from "node:url";

export function resolveProjectRoot(moduleUrl = "") {
    const moduleDir = moduleUrl
        ? path.dirname(fileURLToPath(moduleUrl))
        : "";
    const candidates = [
        process.env.CODEX_ROOT,
        process.cwd(),
        moduleDir ? path.resolve(moduleDir, "..") : "",
        moduleDir ? path.resolve(moduleDir, "../..") : "",
    ].filter(Boolean);
    return candidates.find((candidate) => existsSync(path.join(candidate, "package.json"))) || process.cwd();
}

export function resolveTsxCommand(rootDir) {
    const localBin = path.join(rootDir, "node_modules", ".bin", process.platform === "win32" ? "tsx.cmd" : "tsx");
    if (existsSync(localBin)) return {command: localBin, args: []};
    const cli = path.join(rootDir, "node_modules", "tsx", "dist", "cli.mjs");
    if (existsSync(cli)) return {command: process.execPath, args: [cli]};
    return {command: "tsx", args: []};
}

function isBundleModule(moduleUrl = "") {
    if (!moduleUrl) return false;
    try {
        const modulePath = fileURLToPath(moduleUrl);
        const moduleDir = path.dirname(modulePath);
        return path.basename(moduleDir) === "bundle"
            || path.basename(path.dirname(moduleDir)) === "bundle";
    } catch {
        return false;
    }
}

/**
 * 生产服务不应依赖 TSX 的缓存和 IPC 管道；开发态才执行 TypeScript 源文件。
 */
export function resolveWorkerCommand(moduleUrl, rootDir, sourceScript, bundledScript) {
    const bundlePath = path.resolve(rootDir, bundledScript);
    if (isBundleModule(moduleUrl) && existsSync(bundlePath)) {
        return {command: process.execPath, args: [bundlePath], bundled: true};
    }
    const tsx = resolveTsxCommand(rootDir);
    return {command: tsx.command, args: [...tsx.args, sourceScript], bundled: false};
}
