import assert from "node:assert/strict";
import test from "node:test";
import {initializeApplicationInfrastructure} from "./application-infrastructure.js";

test("基础设施先完成数据库，再初始化可选 Xray，并清理旧本地出口", async () => {
    const calls: string[] = [];
    const scheduler = {
        mailProxyEnabled: true,
        mailProxy: "socks5://mail",
        xrayVless: "vless://legacy",
        regProxyPort: 10809,
        regProxy: "socks5://127.0.0.1:10809",
        claudeXrayVless: "vless://claude",
        claudeProxyPort: 10810,
        xrayBinPath: "",
        saveSettings: () => calls.push("save"),
        ensureJumpFleet: async () => { calls.push("jump"); return []; },
    };
    await initializeApplicationInfrastructure({
        scheduler,
        mailbox: {setProxy: (value) => calls.push(`mail:${value}`)},
        xray: {
            stop: () => calls.push("xray:stop"),
            start: () => { calls.push("xray:start"); return {port: 10810, node: "node"}; },
        },
        database: {
            ensureSchema: async () => calls.push("schema"),
            initConnection: async () => calls.push("connection"),
        },
        logger: {log() {}, warn() {}},
    });

    assert.equal(scheduler.xrayVless, "");
    assert.equal(scheduler.regProxy, "");
    assert.equal(scheduler.claudeProxy, "socks5://127.0.0.1:10810");
    assert.deepEqual(calls, ["mail:socks5://mail", "xray:stop", "save", "schema", "connection", "xray:start", "jump"]);
});
