import {defineConfig} from "tsup";

export default defineConfig({
    entry: {
        index: "src/index.ts",
        "check-auth-quota": "src/check-auth-quota.ts",
        "batch-register": "src/batch-register.ts",
    },
    outDir: "bundle",
    format: ["cjs"],
    platform: "node",
    target: "node20",
    bundle: true,
    splitting: false,
    sourcemap: false,
    // server bundle 也输出到 bundle，CLI 构建不能清理掉它。
    clean: false,
    dts: false,
    minify: false,
});
