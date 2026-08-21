import assert from "node:assert/strict";
import test from "node:test";
import {generateTotp, generateTotpCandidates} from "./mfa.js";

test("TOTP candidates prefer the current time window", () => {
    const atMs = 1_725_000_000_000;
    const candidates = generateTotpCandidates("JBSWY3DPEHPK3PXP", atMs);
    assert.equal(candidates[0], generateTotp("JBSWY3DPEHPK3PXP", atMs));
    assert.equal(candidates[1], generateTotp("JBSWY3DPEHPK3PXP", atMs - 30_000));
    assert.equal(candidates[2], generateTotp("JBSWY3DPEHPK3PXP", atMs + 30_000));
});
