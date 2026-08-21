import {defineConfig} from "tsup";

export default defineConfig({
    entry: {
        "workers/worker-mailcom-task": "scripts/worker-mailcom-task.ts",
        "workers/worker-gmail-task": "scripts/worker-gmail-task.ts",
        "workers/worker-gmail-login": "scripts/worker-gmail-login.ts",
        "workers/worker-change-email": "scripts/worker-change-email.ts",
        "workers/worker-mail-send": "scripts/worker-mail-send.ts",
    },
    outDir: "bundle",
    format: ["esm"],
    outExtension: () => ({js: ".mjs"}),
    platform: "node",
    target: "node20",
    bundle: true,
    splitting: false,
    sourcemap: false,
    clean: false,
    dts: false,
    minify: false,
    external: ['playwright', 'playwright-core', 'electron', 'pg'],
});
