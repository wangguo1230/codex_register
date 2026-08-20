import assert from "node:assert/strict";
import test from "node:test";
import {ActivationBroker} from "./activation-broker.js";
import type {SmsProvider} from "./provider.js";

function createProvider(options: {waitError?: Error} = {}) {
  const calls = {
    complete: 0,
    cancel: 0,
    wait: 0,
  };
  const provider: SmsProvider = {
    async requestActivation() {
      return {activationId: "activation-1", phoneNumber: "15550001111"};
    },
    async requestAnotherSms() {
      return "ok";
    },
    async waitForVerificationCode() {
      calls.wait += 1;
      if (options.waitError) throw options.waitError;
      return {code: "123456", source: "sms"};
    },
    async completeActivation() {
      calls.complete += 1;
      return "ok";
    },
    async cancelAndWithdraw() {
      calls.cancel += 1;
      return "ok";
    },
    async cancelActivation() {
      calls.cancel += 1;
      return "ok";
    },
  };
  return {provider, calls};
}

test("读取验证码后由业务验证结果结束 attempt", async () => {
  const {provider, calls} = createProvider();
  const broker = new ActivationBroker(provider);
  const lease = await broker.getActivation();

  assert.equal((await lease.waitForVerificationCode()).code, "123456");
  assert.equal(broker.getState().attemptActive, true);
  assert.equal(broker.getHistory().totalAttemptsSucceeded, 0);

  await broker.markAsSucceed();

  assert.equal(broker.getState().attemptActive, false);
  assert.equal(broker.getState().needsAnotherSms, true);
  assert.equal(broker.getHistory().totalAttemptsSucceeded, 1);
  assert.equal(calls.complete, 0);
});

test("收码失败不会提前释放号码，由调用方决定轮换", async () => {
  const {provider, calls} = createProvider({waitError: new Error("timeout")});
  const broker = new ActivationBroker(provider);
  const lease = await broker.getActivation();

  await assert.rejects(lease.waitForVerificationCode(), /timeout/);
  assert.equal(broker.getState().attemptActive, true);
  assert.equal(calls.complete, 0);
  assert.equal(calls.cancel, 0);

  await broker.markAsFailed(true);

  assert.equal(broker.getState().currentActivation, null);
  assert.equal(broker.getHistory().totalAttemptsFailed, 1);
  assert.equal(calls.complete, 1);
});
