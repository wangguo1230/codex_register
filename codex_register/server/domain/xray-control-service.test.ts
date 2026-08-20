import assert from "node:assert/strict";
import test from "node:test";
import {createXrayControlService} from "./xray-control-service.js";

function createScheduler() {
    return {
        regProxyPort: 10809,
        claudeProxyPort: 10810,
        mailJumpPool: [],
        gptJumpPool: [],
        jumpFleet: [],
        saveSettings() {},
        jumpPoolSnapshot: () => ({}),
        ensureJumpFleet: async () => {},
    };
}

test("Xray 出口 IP 与 ChatGPT 探测并行执行", async () => {
    let active = 0;
    let maxActive = 0;
    const service = createXrayControlService({
        scheduler: createScheduler(),
        xray: {
            status: () => ({running: true, port: 10809}),
            start: () => ({}),
            stop: () => {},
            isVlessUrl: () => true,
            stopJumpFleet: () => {},
            listJumpXrays: () => [],
        },
        runCommand: async (_command, args) => {
            active++;
            maxActive = Math.max(maxActive, active);
            await new Promise((resolve) => setTimeout(resolve, 10));
            active--;
            return {stdout: args.some((value) => String(value).includes("api.ipify.org")) ? "1.2.3.4" : "200"};
        },
    });

    const result = await service.probeLegacy();

    assert.equal(maxActive, 2);
    assert.deepEqual(result, {ok: true, ip: "1.2.3.4", chatgpt: "200", pass: true});
});

test("代理端口拒绝冲突配置且不修改现有端口", () => {
    const scheduler = createScheduler();
    const service = createXrayControlService({
        scheduler,
        xray: {
            status: () => ({}),
            start: () => ({}),
            stop: () => {},
            isVlessUrl: () => true,
            stopJumpFleet: () => {},
            listJumpXrays: () => [],
        },
    });

    const result = service.setProxyPorts({regPort: 12000, claudePort: 12000});

    assert.match(result.error, /不能相同/);
    assert.equal(scheduler.regProxyPort, 10809);
    assert.equal(scheduler.claudeProxyPort, 10810);
});

test("代理端口拒绝占用活动跳板端口", () => {
    const scheduler = createScheduler();
    const service = createXrayControlService({
        scheduler,
        xray: {
            status: () => ({}),
            start: () => ({}),
            stop: () => {},
            isVlessUrl: () => true,
            stopJumpFleet: () => {},
            listJumpXrays: () => [{running: true, port: 12000}],
        },
    });

    const result = service.setProxyPorts({regPort: 12000, claudePort: 12001});

    assert.match(result.error, /跳板端口/);
    assert.equal(scheduler.regProxyPort, 10809);
});
