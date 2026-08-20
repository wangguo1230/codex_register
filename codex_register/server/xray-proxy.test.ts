import assert from "node:assert/strict";
import test from "node:test";
import * as facade from "./xray-proxy.js";
import * as jumpFleet from "./xray-jump-fleet.js";
import * as localPort from "./xray-local-port.js";
import * as processManager from "./xray-process-manager.js";

test("Xray 兼容门面保持原公开 API 引用", () => {
    assert.equal(facade.startXray, processManager.startXray);
    assert.equal(facade.xrayStatus, processManager.xrayStatus);
    assert.equal(facade.localPortListeningAsync, localPort.localPortListeningAsync);
    assert.equal(facade.startJumpFleet, jumpFleet.startJumpFleet);
    assert.equal(facade.pickXrayBrowserProxy, jumpFleet.pickXrayBrowserProxy);
});

test("预构建后端通过 CODEX_HTTP 标记识别为主 HTTP 进程", () => {
    const previous = process.env.CODEX_HTTP;
    try {
        process.env.CODEX_HTTP = "1";
        assert.equal(processManager.isMainHttpServer(), true);
    } finally {
        if (previous === undefined) delete process.env.CODEX_HTTP;
        else process.env.CODEX_HTTP = previous;
    }
});

test("VLESS 解析与本机无认证 SOCKS 判定保持原契约", () => {
    const parsed = facade.parseVless("vless://user-id@example.com:443?security=tls#node");
    assert.deepEqual(
        {uuid: parsed.uuid, host: parsed.host, port: parsed.port, name: parsed.name},
        {uuid: "user-id", host: "example.com", port: 443, name: "node"},
    );
    assert.equal(facade.isLocalNoAuthSocks("socks5://127.0.0.1:10811"), true);
    assert.equal(facade.isLocalNoAuthSocks("socks5://user:pass@127.0.0.1:10811"), false);
});

test("跳板端口从配置起始端口分配并跳过保留端口", () => {
    assert.equal(jumpFleet.pickJumpPort(new Set(), 12000), 12000);
    assert.equal(jumpFleet.pickJumpPort(new Set([12000, 12001]), 12000), 12002);
    assert.equal(jumpFleet.pickJumpPort(new Set(), 10808), 10811);
    assert.equal(jumpFleet.normalizeJumpBasePort(70000), jumpFleet.JUMP_PORT_BASE);
    assert.equal(jumpFleet.pickJumpPort(new Set(), 12000, [12000, 12001]), 12002);
});

test("跳板端口耗尽错误展示实际配置范围", () => {
    const used = new Set(Array.from({length: 40}, (_, index) => 12000 + index));
    assert.throws(() => jumpFleet.pickJumpPort(used, 12000), /12000-12039/);
});

test("浏览器候选包含只有 port 状态的运行中跳板", () => {
    const ports = jumpFleet.xrayBrowserCandidatePorts([], [
        {running: true, port: 10812},
        {running: false, port: 10813},
    ]);

    assert.deepEqual(ports, [10808, 10812, 10811]);
});
