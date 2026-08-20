import assert from "node:assert/strict";
import test from "node:test";
import {formatAccountExportLine} from "./account-credential-format.js";
import {createAccountExportService} from "./account-export-service.js";

function createHarness(accounts) {
    const sold = [];
    let syncs = 0;
    const service = createAccountExportService({
        store: {
            listFull: async () => accounts,
            list: async () => accounts,
            get: async (id) => accounts.find((account) => account.id === id),
            markSold: async (ids) => { sold.push(...ids); },
        },
        credentials: {
            readAuth: (account) => account.auth_data,
            readRt: (account) => account.rt_data,
            extractTokens: (data) => data ? {
                accessToken: data.access_token || data.session?.accessToken || "",
                refreshToken: data.refresh_token || "",
            } : null,
        },
        defaultPassword: () => "default-gpt-password",
        effects: {syncAccounts: async () => { syncs++; }},
    });
    return {service, sold, syncs: () => syncs};
}

test("账号文本格式保持 Google 2FA 与非 Google IMAP 字段位次", () => {
    assert.equal(formatAccountExportLine({
        email: "g@gmail.com",
        password: "mail-pw",
        mailbox_totp: "mail-2fa",
        mailbox_imap: "imap-not-exported",
        gpt_password: "gpt-pw",
        totp_secret: "gpt-2fa",
    }, {rt: "rt", withRt: true}), "g@gmail.com----mail-pw----mail-2fa----gpt-pw----gpt-2fa----rt");

    assert.equal(formatAccountExportLine({
        email: "m@mail.com",
        password: "mail-pw",
        mailbox_imap: "imap-pw",
    }, {withGpt: true}), "m@mail.com----mail-pw----imap-pw--------");
});

test("导出保留有 GPT 密码的失效 Google 账号并优先使用独立 RT 数据", async () => {
    const accounts = [
        {
            id: 1,
            email: "g@gmail.com",
            provider: "google",
            password: "mail-pw",
            gpt_password: "gpt-pw",
            status: "failed",
            dead_at: 123,
            auth_data: {session: {accessToken: "at"}, refresh_token: "auth-rt"},
            rt_data: {refresh_token: "separate-rt"},
        },
        {id: 2, email: "dead@mail.com", status: "success", dead_at: 123},
    ];
    const h = createHarness(accounts);

    const result = await h.service.exportAccounts({format: "jsonl", markSold: true});
    const record = JSON.parse(result.text);

    assert.equal(record.email, "g@gmail.com");
    assert.equal(record.refresh_token, "separate-rt");
    assert.equal(record.access_token, "at");
    assert.deepEqual(h.sold, [1]);
    assert.equal(h.syncs(), 1);
});

test("CSV 正确转义双引号且批次按最新账号倒序", async () => {
    const accounts = [
        {id: 1, email: "a@mail.com", password: 'p"w', status: "success", batch: "old"},
        {id: 3, email: "b@mail.com", password: "pw", status: "success", batch: "new"},
        {id: 4, email: "c@mail.com", password: "pw", status: "success", batch: "old"},
    ];
    const h = createHarness(accounts);

    const csv = await h.service.exportAccounts({format: "csv", ids: [1]});
    assert.match(csv.text, /"p""w"/);
    assert.deepEqual(await h.service.listBatches(), [
        {name: "old", count: 2},
        {name: "new", count: 1},
    ]);
});

test("单号 session 返回内层对象", async () => {
    const h = createHarness([{id: 1, auth_data: {session: {accessToken: "at"}}}]);
    assert.deepEqual(await h.service.getSession(1), {session: {accessToken: "at"}});
    assert.equal((await h.service.getSession(2)).status, 404);
});
