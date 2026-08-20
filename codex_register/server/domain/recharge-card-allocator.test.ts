import assert from "node:assert/strict";
import test from "node:test";
import {createRechargeCardAllocator} from "./recharge-card-allocator.js";

test("已知绑定其他账号的卡不会被后续账号重复核验", async () => {
    const claims = [];
    let first = true;
    const allocator = createRechargeCardAllocator({
        isStopped: () => false,
        claimUnusedCards: async (_count, options = {}) => {
            claims.push(options.excludeIds || []);
            if (first) {
                first = false;
                return [{id: 1, code: "card-one"}];
            }
            return [];
        },
        reviveErrorCards: async () => 0,
        validateCard: async () => ({status: "unused", bound_email: "owner@example.com"}),
        unpairCards: async () => {},
        lockCard: async () => {},
        cardBoundToOtherAccount: (_state, email) => email !== "owner@example.com",
        isRateLimited: () => false,
    });

    await allocator("first@example.com", {maxTries: 1});
    await allocator("second@example.com", {maxTries: 1});

    assert.deepEqual(claims[0], []);
    assert.deepEqual(claims[1], [1]);
});

test("单次分配遇到核验网络错误后不会反复请求同一卡密", async () => {
    const claims = [];
    let validations = 0;
    const allocator = createRechargeCardAllocator({
        isStopped: () => false,
        claimUnusedCards: async (_count, options = {}) => {
            claims.push(options.excludeIds || []);
            return (options.excludeIds || []).includes(1) ? [] : [{id: 1, code: "card-one"}];
        },
        reviveErrorCards: async () => 0,
        validateCard: async () => {
            validations++;
            throw new Error("network timeout");
        },
        unpairCards: async () => {},
        lockCard: async () => {},
        cardBoundToOtherAccount: () => false,
        isRateLimited: () => false,
    });

    const result = await allocator("owner@example.com", {maxTries: 20});

    assert.equal(result.card, null);
    assert.equal(validations, 1);
    assert.deepEqual(claims, [[], [1]]);
});
