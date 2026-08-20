import assert from "node:assert/strict";
import test from "node:test";
import * as db from "../db.js";
import * as accounts from "./gpt-account-repository.js";
import * as googleState from "./mailbox-google-state-repository.js";
import * as gmailRebind from "./gmail-rebind-mailbox-repository.js";
import * as mailboxQuery from "./mailbox-query-repository.js";
import * as mailJobQuery from "./mail-job-query-repository.js";
import * as mailJobRuntime from "./mail-job-runtime-repository.js";
import * as recharge from "./recharge-queue-repository.js";
import * as rechargeSubmission from "./recharge-submission-repository.js";
import * as rebindExecution from "./rebind-execution-repository.js";
import {resolveInstanceId} from "./database-context.js";

test("db 兼容门面保持核心领域导出引用", () => {
    assert.equal(db.getAccount, accounts.getAccount);
    assert.equal(db.claimRechargeQueueItems, recharge.claimRechargeQueueItems);
    assert.equal(db.assignClaimedRechargeCard, rechargeSubmission.assignClaimedRechargeCard);
    assert.equal(db.listMailboxes, mailboxQuery.listMailboxes);
    assert.equal(db.refreshMailboxGoogleState, googleState.refreshMailboxGoogleState);
    assert.equal(db.claimMailboxForRebind, gmailRebind.claimMailboxForRebind);
    assert.equal(db.claimRebindExecution, rebindExecution.claimRebindExecution);
    assert.equal(db.mailJobsProgress, mailJobQuery.mailJobsProgress);
    assert.equal(db.setMailClaimPaused, mailJobRuntime.setMailClaimPaused);
    assert.equal(typeof db.enqueueMailJobs, "function");
});

test("实例标识优先使用显式配置并按端口隔离默认实例", () => {
    assert.equal(resolveInstanceId({configured: "worker-a", hostname: "host", port: "3100"}), "worker-a");
    assert.equal(resolveInstanceId({configured: "", hostname: "host", port: "3101"}), "host:3101");
});
