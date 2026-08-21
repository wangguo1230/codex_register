import {defineConfig} from "tsup";
export default defineConfig({
  entry: {"probe-mailcom-cats-vs-smtp": "scripts/probe-mailcom-cats-vs-smtp.ts"},
  outDir: "bundle/probe",
  format: ["esm"],
  outExtension: () => ({js: ".mjs"}),
  platform: "node",
  target: "node20",
  bundle: true,
  splitting: false,
  sourcemap: false,
  clean: true,
  dts: false,
  minify: false,
  external: ["playwright", "playwright-core", "pg"],
});
