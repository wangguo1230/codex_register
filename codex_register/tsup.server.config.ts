import {defineConfig} from "tsup";

export default defineConfig({
    entry: {server: "server/index.ts"},
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
});
