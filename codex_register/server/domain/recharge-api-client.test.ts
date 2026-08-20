import assert from "node:assert/strict";
import test from "node:test";
import {createRechargeApiClient, RechargeApiError} from "./recharge-api-client.js";

const config = () => ({baseUrl: "https://recharge.test", apiKey: "key"});

test("充值 API 将配置缺失标记为确定失败", async () => {
    const call = createRechargeApiClient({getConfig: () => ({baseUrl: "", apiKey: ""})});

    await assert.rejects(
        call("POST", "/tasks", {}),
        (error) => error instanceof RechargeApiError
            && error.kind === "configuration"
            && error.indeterminate === false,
    );
});

test("充值 API 保留 HTTP 状态并区分确定失败", async () => {
    const call = createRechargeApiClient({
        getConfig: config,
        fetchImpl: async () => new Response(JSON.stringify({detail: "bad request"}), {
            status: 400,
            headers: {"content-type": "application/json"},
        }),
    });

    await assert.rejects(
        call("POST", "/tasks", {}),
        (error) => error instanceof RechargeApiError
            && error.httpStatus === 400
            && error.indeterminate === false,
    );
});

test("充值 API 将网络中断标记为结果不确定", async () => {
    const call = createRechargeApiClient({
        getConfig: config,
        fetchImpl: async () => { throw new TypeError("socket closed"); },
    });

    await assert.rejects(
        call("POST", "/tasks", {}),
        (error) => error instanceof RechargeApiError
            && error.kind === "network"
            && error.indeterminate === true,
    );
});
