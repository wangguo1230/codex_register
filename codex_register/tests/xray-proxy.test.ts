import test from "node:test";
import assert from "node:assert/strict";
import {resolveXrayBin} from "../server/xray-proxy.ts";

test("resolveXrayBin throws a clear error when no xray binary exists", () => {
  const prev = process.env.XRAY_BIN;
  process.env.XRAY_BIN = "/definitely/not/a/real/xray";
  try {
    assert.throws(() => resolveXrayBin(), /未找到 xray 可执行文件/);
  } finally {
    if (prev === undefined) {
      delete process.env.XRAY_BIN;
    } else {
      process.env.XRAY_BIN = prev;
    }
  }
});
