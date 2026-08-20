import assert from "node:assert/strict";
import test from "node:test";
import {createRechargeSubmitter} from "./recharge-submitter.js";

function createHarness({completeError = null} = {}) {
    const queueUpdates = [];
    const cardUpdates = [];
    const failures = [];
    let completeCalls = 0;
    const submit = createRechargeSubmitter({
        getAccount: async () => ({id: 7, auth_data: {session: {accessToken: "at"}}}),
        getAuthData: (account) => account.auth_data,
        readAuthFile: () => null,
        extractSession: (auth) => auth?.session,
        callApi: async (_method, path) => {
            if (path === "/redeem-codes/validate") return {result: {status: "unused"}};
            if (path === "/submission-challenges") return {challenge: {challenge_token: "challenge"}};
            return {task: {task_no: "task-1", status: "queued", message: "accepted"}};
        },
        updateQueueItem: async (_id, updates) => { queueUpdates.push(updates); },
        updateRechargeCard: async (_id, updates) => { cardUpdates.push(updates); },
        beginSubmission: async () => {},
        completeSubmission: async () => {
            completeCalls++;
            if (completeError) throw completeError;
        },
        failSubmission: async (...args) => { failures.push(args); },
        cardBoundToOtherAccount: () => false,
    });
    return {submit, queueUpdates, cardUpdates, failures, completeCalls: () => completeCalls};
}

test("平台任务创建后事务失败不会误走解绑补偿", async () => {
    const harness = createHarness({completeError: new Error("db unavailable")});

    const result = await harness.submit(
        {id: 1, account_id: 7, email: "a@example.com"},
        {id: 2, code: "card-code"},
    );

    assert.equal(result.ok, true);
    assert.equal(result.indeterminate, true);
    assert.equal(result.recovered, false);
    assert.equal(result.taskNo, "task-1");
    assert.equal(harness.failures.length, 0);
    assert.equal(harness.completeCalls(), 2);
    assert.deepEqual(harness.queueUpdates, []);
    assert.deepEqual(harness.cardUpdates, [{
        plan_type: "",
        plan_name: "",
        product: "",
        category: "",
        auth_mode: "",
    }]);
});

test("平台任务写回被状态机拒绝时不误报恢复或触发换绑", async () => {
    const failures = [];
    const paid = [];
    let completeCalls = 0;
    const submit = createRechargeSubmitter({
        getAccount: async () => ({auth_data: {session: {accessToken: "at"}}}),
        getAuthData: (account) => account.auth_data,
        extractSession: (auth) => auth.session,
        beginSubmission: async () => {},
        callApi: async (_method, path) => {
            if (path === "/redeem-codes/validate") return {result: {status: "unused"}};
            if (path === "/submission-challenges") return {challenge: {challenge_token: "challenge"}};
            return {task: {task_no: "task-paid", status: "paid"}};
        },
        updateRechargeCard: async () => {},
        completeSubmission: async () => {
            completeCalls++;
            return {applied: false, reason: "队列已被人工修改"};
        },
        failSubmission: async (...args) => { failures.push(args); },
        cardBoundToOtherAccount: () => false,
        onPaid: async (...args) => { paid.push(args); },
    });

    const result = await submit(
        {id: 1, account_id: 7, email: "a@example.com"},
        {id: 2, code: "card-code"},
    );

    assert.equal(result.ok, true);
    assert.equal(result.indeterminate, true);
    assert.equal(result.recovered, false);
    assert.equal(result.persistError, "队列已被人工修改");
    assert.equal(completeCalls, 2);
    assert.equal(failures.length, 0);
    assert.equal(paid.length, 0);
});

test("平台接单前失败使用原子失败补偿", async () => {
    const harness = createHarness();
    harness.submit = createRechargeSubmitter({
        getAccount: async () => null,
        getAuthData: () => null,
        readAuthFile: () => null,
        extractSession: () => null,
        beginSubmission: async () => {},
        failSubmission: async (...args) => { harness.failures.push(args); },
        cardBoundToOtherAccount: () => false,
    });

    const result = await harness.submit(
        {id: 1, account_id: 7, email: "a@example.com"},
        {id: 2, code: "card-code"},
    );

    assert.equal(result.ok, false);
    assert.equal(harness.failures.length, 1);
    assert.equal(harness.failures[0][0], 1);
    assert.equal(harness.failures[0][1], 2);
});

test("创建任务响应丢失时保留 submitting 配对并进入对账", async () => {
    const failures = [];
    const unknown = [];
    const submit = createRechargeSubmitter({
        getAccount: async () => ({id: 7, auth_data: {session: {accessToken: "at"}}}),
        getAuthData: (account) => account.auth_data,
        readAuthFile: () => null,
        extractSession: (auth) => auth?.session,
        beginSubmission: async () => {},
        callApi: async (_method, path) => {
            if (path === "/redeem-codes/validate") return {result: {status: "unused"}};
            if (path === "/submission-challenges") return {challenge: {challenge_token: "challenge"}};
            throw Object.assign(new Error("POST /tasks timeout"), {indeterminate: true});
        },
        updateRechargeCard: async () => {},
        markSubmissionUnknown: async (...args) => { unknown.push(args); },
        failSubmission: async (...args) => { failures.push(args); },
        cardBoundToOtherAccount: () => false,
    });

    const result = await submit(
        {id: 1, account_id: 7, email: "a@example.com"},
        {id: 2, code: "card-code"},
    );

    assert.equal(result.ok, true);
    assert.equal(result.indeterminate, true);
    assert.equal(result.stage, "tasks");
    assert.equal(unknown.length, 1);
    assert.equal(failures.length, 0);
});

test("平台创建任务立即支付时直接触发换绑且不等待轮询", async () => {
    const paid = [];
    const completed = [];
    const submit = createRechargeSubmitter({
        getAccount: async () => ({auth_data: {session: {accessToken: "at"}}}),
        getAuthData: (account) => account.auth_data,
        extractSession: (auth) => auth.session,
        beginSubmission: async () => {},
        callApi: async (_method, path) => {
            if (path === "/redeem-codes/validate") return {result: {status: "unused"}};
            if (path === "/submission-challenges") return {challenge: {challenge_token: "challenge"}};
            return {task: {task_no: "task-paid", status: "PAID"}};
        },
        updateRechargeCard: async () => {},
        completeSubmission: async (...args) => { completed.push(args); },
        failSubmission: async () => { throw new Error("不应失败补偿"); },
        cardBoundToOtherAccount: () => false,
        onPaid: async (item) => { paid.push(item.id); },
    });

    const result = await submit(
        {id: 1, account_id: 7, email: "a@example.com"},
        {id: 2, code: "card-code"},
    );

    assert.equal(result.ok, true);
    assert.equal(result.paid, true);
    assert.equal(completed[0][2].status, "paid");
    assert.deepEqual(paid, [1]);
});

test("提交器复用刚完成的验卡快照避免重复平台请求", async () => {
    const paths = [];
    const cardUpdates = [];
    const validation = {status: "unused", plan_type: "plus", plan_name: "Plus"};
    const submit = createRechargeSubmitter({
        getAccount: async () => ({auth_data: {session: {accessToken: "at"}}}),
        getAuthData: (account) => account.auth_data,
        extractSession: (auth) => auth.session,
        beginSubmission: async () => {},
        callApi: async (_method, path) => {
            paths.push(path);
            if (path === "/submission-challenges") return {challenge: {challenge_token: "challenge"}};
            return {task: {task_no: "task-1", status: "queued"}};
        },
        updateRechargeCard: async (_id, updates) => { cardUpdates.push(updates); },
        completeSubmission: async () => ({applied: true}),
        failSubmission: async () => {},
        cardBoundToOtherAccount: () => false,
    });

    const result = await submit(
        {id: 1, account_id: 7, email: "a@example.com"},
        {id: 2, code: "card-code"},
        "",
        {validation},
    );

    assert.equal(result.ok, true);
    assert.deepEqual(paths, ["/submission-challenges", "/tasks"]);
    assert.equal(cardUpdates[0].plan_type, "plus");
});

test("平台创建任务立即失败时已收敛终态且不走本地失败补偿", async () => {
    const failures = [];
    const submit = createRechargeSubmitter({
        getAccount: async () => ({auth_data: {session: {accessToken: "at"}}}),
        getAuthData: (account) => account.auth_data,
        extractSession: (auth) => auth.session,
        beginSubmission: async () => {},
        callApi: async (_method, path) => {
            if (path === "/redeem-codes/validate") return {result: {status: "unused"}};
            if (path === "/submission-challenges") return {challenge: {challenge_token: "challenge"}};
            return {task: {task_no: "task-failed", status: "returned", message: "returned"}};
        },
        updateRechargeCard: async () => {},
        completeSubmission: async () => {},
        failSubmission: async (...args) => { failures.push(args); },
        cardBoundToOtherAccount: () => false,
    });

    const result = await submit(
        {id: 1, account_id: 7, email: "a@example.com"},
        {id: 2, code: "card-code"},
    );

    assert.equal(result.ok, false);
    assert.equal(result.terminal, true);
    assert.equal(failures.length, 0);
});

test("提交初始化事务失败时归还卡密且不执行错误卡锁定", async () => {
    const canceled = [];
    const failures = [];
    const submit = createRechargeSubmitter({
        beginSubmission: async () => { throw new Error("database unavailable"); },
        cancelSubmission: async (...args) => {
            canceled.push(args);
            return {released: true};
        },
        failSubmission: async (...args) => { failures.push(args); },
    });

    const result = await submit(
        {id: 1, account_id: 7, email: "a@example.com"},
        {id: 2, code: "card-code"},
    );

    assert.equal(result.ok, false);
    assert.equal(result.stage, "begin");
    assert.equal(result.canceled, true);
    assert.deepEqual(canceled, [[1, 2]]);
    assert.equal(failures.length, 0);
});

test("提交期间配置失效时撤销配对且不锁定卡密", async () => {
    const canceled = [];
    const failures = [];
    const submit = createRechargeSubmitter({
        getAccount: async () => ({auth_data: {session: {accessToken: "at"}}}),
        getAuthData: (account) => account.auth_data,
        extractSession: (auth) => auth.session,
        beginSubmission: async () => {},
        callApi: async () => { throw Object.assign(new Error("充值平台 API 未配置"), {kind: "configuration"}); },
        cancelSubmission: async (...args) => {
            canceled.push(args);
            return {released: true};
        },
        failSubmission: async (...args) => { failures.push(args); },
    });

    const result = await submit(
        {id: 1, account_id: 7, email: "a@example.com"},
        {id: 2, code: "card-code"},
    );

    assert.equal(result.ok, false);
    assert.equal(result.stage, "validate");
    assert.equal(result.configuration, true);
    assert.equal(result.canceled, true);
    assert.deepEqual(canceled, [[1, 2]]);
    assert.equal(failures.length, 0);
});
