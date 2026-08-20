import assert from "node:assert/strict";
import test from "node:test";
import {createGmailRebindExecutor} from "./gmail-rebind-executor.js";

function createHarness(changeResult, overrides = {}) {
    const {
        queueStore: queueOverrides = {},
        accountStore: accountOverrides = {},
        effects: effectOverrides = {},
        ...factoryOverrides
    } = overrides;
    const updates = [];
    const attempts = [];
    const released = [];
    const notes = [];
    const quarantined = [];
    const rebound = [];
    const executionReleases = [];
    const liveMailboxIds = new Set([11]);
    let reconciles = 0;
    let successSyncs = 0;
    const mailbox = {
        id: 11,
        email: "target@gmail.com",
        password: "mail-pw",
        imap_password: "imap-pw",
    };
    const execute = createGmailRebindExecutor({
        queueStore: {
            claimExecution: async () => ({id: 7, account_id: 9, email: "old@example.com", rebind_target: "gmail"}),
            releaseExecution: async (id) => { executionReleases.push(id); },
            update: async (id, value) => { updates.push({id, value}); },
            markAttempt: async (id, value) => { attempts.push({id, value}); },
            ...queueOverrides,
        },
        accountStore: {
            get: async () => ({id: 9, email: "old@example.com", mailbox_id: 1, auth: {cookie: "cookie"}}),
            rebindMailbox: async (accountId, mailboxId) => { rebound.push({accountId, mailboxId}); },
            completeRebind: async (id, accountId, mailboxId) => {
                rebound.push({accountId, mailboxId});
                updates.push({id, value: {rebind_status: "ok", email: mailbox.email}});
            },
            ...accountOverrides,
        },
        mailboxStore: {
            release: async (id) => { released.push(id); },
            setNote: async (id, note) => { notes.push({id, note}); },
            quarantine: async (id, reason) => { quarantined.push({id, reason}); },
            refreshGoogleState: async () => {},
        },
        authService: {
            prepare: async (account) => ({ok: true, fresh: account, token: {accountId: "a1"}, accessToken: "at"}),
            reauthenticate: async (account, context) => ({ok: true, ...context}),
        },
        claimMailbox: async () => ({ok: true, mailbox, poolHint: ""}),
        changeEmail: async () => ({...changeResult}),
        currentLoginEmailOf: async () => ({ok: true, email: "target@gmail.com"}),
        credentialStore: {
            isGoogleMailbox: () => true,
            rememberGoogle: () => {},
            rememberMailcom: () => {},
        },
        policy: {
            normalizeTarget: (value) => value,
            targetLabel: () => "Gmail",
            isRateLimited: () => false,
            capCooldownMs: 86_400_000,
            formatUntil: () => "明天",
        },
        runtime: {
            isCancelled: () => false,
            getMetadata: () => ({target: "gmail", pool: {grp: "换绑池"}}),
            liveMailboxIds,
        },
        effects: {
            log: () => {},
            syncQueue: async () => {},
            scheduleReconcile: () => { reconciles++; },
            syncSuccess: async () => { successSyncs++; },
            ...effectOverrides,
        },
        getAuthData: (account) => account.auth,
        ...factoryOverrides,
    });
    return {
        execute,
        updates,
        attempts,
        released,
        notes,
        quarantined,
        rebound,
        executionReleases,
        liveMailboxIds,
        reconciles: () => reconciles,
        successSyncs: () => successSyncs,
    };
}

test("官方换绑成功后更新账号指针和队列终态", async () => {
    const h = createHarness({ok: true, stage: "verify"});
    await h.execute(7);

    assert.deepEqual(h.rebound, [{accountId: 9, mailboxId: 11}]);
    assert.equal(h.updates.at(-1).value.rebind_status, "ok");
    assert.equal(h.updates.at(-1).value.email, "target@gmail.com");
    assert.equal(h.released.length, 0);
    assert.equal(h.successSyncs(), 1);
    assert.equal(h.liveMailboxIds.has(11), false);
});

test("verify 后状态不确定时保留目标邮箱并排队对账", async () => {
    const h = createHarness({ok: false, indeterminate: true, reason: "verify timeout", stage: "verify"});
    await h.execute(7);

    assert.equal(h.updates.at(-1).value.rebind_status, "unknown");
    assert.deepEqual(h.notes, [{id: 11, note: "换绑待核对，勿分配"}]);
    assert.equal(h.released.length, 0);
    assert.equal(h.reconciles(), 1);
});

test("官方限流时失败并且目标邮箱只归还一次", async () => {
    const h = createHarness({ok: false, rateLimited: true, reason: "429"});
    await h.execute(7);

    assert.equal(h.updates.at(-1).value.rebind_status, "fail");
    assert.deepEqual(h.released, [11]);
    assert.equal(h.quarantined.length, 0);
});

test("already linked 对账确认目标邮箱后按成功收敛", async () => {
    const h = createHarness({ok: false, alreadyLinked: true, reason: "already linked"});
    await h.execute(7);

    assert.equal(h.updates.at(-1).value.rebind_status, "ok");
    assert.deepEqual(h.rebound, [{accountId: 9, mailboxId: 11}]);
    assert.equal(h.quarantined.length, 0);
});

test("其他实例已认领时不执行换绑", async () => {
    let changed = 0;
    const h = createHarness({ok: true}, {
        queueStore: {claimExecution: async () => null},
        changeEmail: async () => { changed++; return {ok: true}; },
    });

    await h.execute(7);

    assert.equal(changed, 0);
    assert.equal(h.released.length, 0);
    assert.equal(h.executionReleases.length, 0);
});

test("取消执行中的换绑会归还目标邮箱并释放执行认领", async () => {
    const controller = new AbortController();
    let started;
    const entered = new Promise((resolve) => { started = resolve; });
    const h = createHarness({ok: false}, {
        changeEmail: async ({signal}) => {
            started();
            await new Promise((resolve) => signal.addEventListener("abort", resolve, {once: true}));
            return {ok: false, cancelled: true, indeterminate: false, reason: "已取消换绑", stage: "otp"};
        },
    });

    const pending = h.execute(7, {signal: controller.signal});
    await entered;
    controller.abort();
    await pending;

    assert.deepEqual(h.released, [11]);
    assert.deepEqual(h.rebound, []);
    assert.deepEqual(h.executionReleases, [7]);
});

test("verify 阶段取消保留目标邮箱并转为待对账", async () => {
    const controller = new AbortController();
    let started;
    const entered = new Promise((resolve) => { started = resolve; });
    const h = createHarness({ok: false}, {
        changeEmail: async ({signal}) => {
            started();
            await new Promise((resolve) => signal.addEventListener("abort", resolve, {once: true}));
            return {ok: false, cancelled: true, indeterminate: true, reason: "已取消换绑", stage: "verify"};
        },
    });

    const pending = h.execute(7, {signal: controller.signal});
    await entered;
    controller.abort();
    await pending;

    assert.equal(h.updates.at(-1).value.rebind_status, "unknown");
    assert.deepEqual(h.released, []);
    assert.deepEqual(h.notes, [{id: 11, note: "换绑待核对，勿分配"}]);
});

test("目标邮箱认领完成时并发取消仍会归还邮箱", async () => {
    const controller = new AbortController();
    const h = createHarness({ok: true}, {
        claimMailbox: async () => {
            controller.abort();
            return {
                ok: true,
                mailbox: {id: 11, email: "target@gmail.com", password: "pw", imap_password: "imap"},
                poolHint: "",
            };
        },
    });

    await h.execute(7, {signal: controller.signal});

    assert.deepEqual(h.released, [11]);
    assert.deepEqual(h.rebound, []);
    assert.deepEqual(h.executionReleases, [7]);
});

test("成功事务提交后视图刷新失败不会归还目标邮箱或改写失败", async () => {
    const h = createHarness({ok: true, stage: "verify"}, {
        effects: {
            syncQueue: async () => { throw new Error("sse unavailable"); },
            syncSuccess: async () => { throw new Error("snapshot unavailable"); },
        },
    });

    await h.execute(7);

    assert.deepEqual(h.rebound, [{accountId: 9, mailboxId: 11}]);
    assert.equal(h.released.length, 0);
    assert.equal(h.updates.filter((item) => item.value.rebind_status === "fail").length, 0);
});

test("官方成功但本地事务失败时保留目标邮箱等待对账", async () => {
    const h = createHarness({ok: true, stage: "verify"}, {
        accountStore: {
            completeRebind: async () => { throw new Error("database unavailable"); },
        },
    });

    await h.execute(7);

    assert.equal(h.updates.at(-1).value.rebind_status, "unknown");
    assert.equal(h.released.length, 0);
    assert.equal(h.reconciles(), 1);
});

test("成功边界后待对账状态也写失败时仍不释放目标邮箱", async () => {
    const h = createHarness({ok: true, stage: "verify"}, {
        accountStore: {
            completeRebind: async () => { throw new Error("database unavailable"); },
        },
        queueStore: {
            update: async () => { throw new Error("database still unavailable"); },
        },
    });

    await h.execute(7);

    assert.equal(h.released.length, 0);
    assert.equal(h.reconciles(), 1);
    assert.deepEqual(h.executionReleases, [7]);
});

test("verify 阶段写回完成后才处理不确定结果", async () => {
    let releaseStageWrite;
    const stageWrite = new Promise((resolve) => { releaseStageWrite = resolve; });
    let finished = false;
    const h = createHarness({ok: false}, {
        queueStore: {
            update: async (_id, value) => {
                if (value.rebind_attempt_stage === "verify") await stageWrite;
                h.updates.push({id: 7, value});
            },
        },
        changeEmail: async ({onStage}) => {
            onStage("verify");
            return {ok: false, indeterminate: true, reason: "verify timeout", stage: "verify"};
        },
    });

    const running = h.execute(7).finally(() => { finished = true; });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(finished, false);
    releaseStageWrite();
    await running;

    assert.equal(h.updates.at(-1).value.rebind_status, "unknown");
    assert.deepEqual(h.released, []);
});
