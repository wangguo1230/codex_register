import assert from "node:assert/strict";
import test from "node:test";

import {getMailProxyJump, jumpPool, setMailProxyJump as setActiveMailProxyJump} from "../../src/mail/proxy-pool.js";
import {createSchedulerProxyService} from "./scheduler-proxy-service.js";

test("ensureJumpFleet updates the active SOCKS jump without recursively starting the fleet", async () => {
    const previousHttpMode = process.env.CODEX_HTTP;
    const previousJump = getMailProxyJump();
    const previousJumpUrls = jumpPool.urls.slice();
    process.env.CODEX_HTTP = "1";
    let nestedEnsureCalls = 0;
    let saveCalls = 0;
    const settings: any = {
        mailJumpPool: ["socks5://127.0.0.1:19081"],
        gptJumpPool: [],
        jumpFleet: [],
        mailProxyJump: "",
        gptProxyJump: "",
        resolveJumpLine: (value: string) => value,
        collectJumpLines: () => settings.mailJumpPool,
        ensureJumpFleet: async () => { nestedEnsureCalls += 1; return []; },
        saveSettings: () => { saveCalls += 1; },
    };

    try {
        const service = createSchedulerProxyService({settings});
        const fleet = await service.ensureJumpFleet();

        assert.deepEqual(fleet, []);
        assert.equal(nestedEnsureCalls, 0);
        assert.equal(saveCalls, 1);
        assert.equal(settings.mailProxyJump, "socks5://127.0.0.1:19081");
        assert.equal(getMailProxyJump(), "socks5://127.0.0.1:19081");
    } finally {
        setActiveMailProxyJump(previousJump);
        jumpPool.setUrls(previousJumpUrls);
        if (previousHttpMode === undefined) delete process.env.CODEX_HTTP;
        else process.env.CODEX_HTTP = previousHttpMode;
    }
});

test("切换跳板业务范围时保留已启动的 VLESS SOCKS 映射", () => {
    const previousUrls = jumpPool.urls.slice();
    const vless = "vless://uuid@jump.example:443?security=reality#jump";
    const socks = "socks5://127.0.0.1:19101";
    const settings: any = {
        proxyJumpPool: [vless],
        proxyJumpMailEnabled: true,
        proxyJumpGptEnabled: true,
        jumpFleet: [{vless, socks, running: true, port: 19101}],
        mailJumpPool: [vless],
        gptJumpPool: [vless],
        resolveJumpLine: (value: string, fleet: any[]) => value.startsWith("vless:") ? (fleet.find((item) => item.vless === value)?.socks || "") : value,
        collectJumpLines: () => settings.proxyJumpPool,
        jumpPoolSnapshot: () => ({}),
        saveSettings: () => {},
    };
    try {
        const service = createSchedulerProxyService({settings});
        service.syncJumpPoolsFromSettings();
        assert.deepEqual(jumpPool.urls, [socks]);
        service.setProxyJumpScopes({mail: false});
        assert.deepEqual(jumpPool.urls, [socks]);
    } finally {
        jumpPool.setUrls(previousUrls);
    }
});
