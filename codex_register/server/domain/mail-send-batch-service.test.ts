import assert from "node:assert/strict";
import test from "node:test";
import {resolveMailSendConcurrency} from "./mail-send-batch-service.js";

test("CATS 发信并发默认收敛为 1，显式上限不超过 2", () => {
    assert.equal(resolveMailSendConcurrency(undefined, 8, 1), 1);
    assert.equal(resolveMailSendConcurrency(8, 1, 2), 2);
    assert.equal(resolveMailSendConcurrency(0, 0, 2), 1);
});
