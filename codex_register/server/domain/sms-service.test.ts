import assert from "node:assert/strict";
import test from "node:test";
import {createSmsService} from "./sms-service.js";

function createHarness({peek, classify, template = ""} = {}) {
    const imported = [];
    const service = createSmsService({
        store: {
            import: async (rows) => {
                imported.push(...rows);
                return {inserted: rows.length, skipped: 0, total: rows.length};
            },
            list: async () => [],
            remove: async () => {},
            stats: async () => ({free: imported.length}),
        },
        sms: {
            peek: peek || (async () => "waiting"),
            classify: classify || ((raw) => ({kind: raw})),
            buildLink: (value, phone) => value ? value.replace("{phone}", phone) : "",
        },
        runPool: async (items, worker) => Promise.all(items.map(worker)),
        getLinkTemplate: () => template,
        broadcast() {},
    });
    return {service, imported};
}

test("预检时过滤 fatal 号码并保留 waiting/code 号码", async () => {
    const h = createHarness({
        peek: async (link) => link,
        classify: (raw) => raw.includes("fatal")
            ? {kind: "fatal", reason: "号码失效"}
            : {kind: raw.includes("code") ? "code" : "waiting"},
    });

    const result = await h.service.importRows([
        "+12025550101----https://sms.test/fatal",
        "+12025550102----https://sms.test/waiting",
        "+12025550103----https://sms.test/code",
    ].join("\n"));

    assert.deepEqual(h.imported.map((row) => row.phone), ["+12025550102", "+12025550103"]);
    assert.deepEqual(result.invalid, [{phone: "+12025550101", reason: "号码失效"}]);
});

test("没有单行链接和链接模板时仍可导入", async () => {
    let peekCalls = 0;
    const h = createHarness({peek: async () => { peekCalls++; return "waiting"; }});

    const result = await h.service.importRows("card-a----+12025550101");

    assert.equal(result.inserted, 1);
    assert.equal(peekCalls, 0);
    assert.equal(h.imported[0].link, "");
});
