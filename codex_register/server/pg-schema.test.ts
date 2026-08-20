import assert from "node:assert/strict";
import test from "node:test";
import {ensureSchemaWithPool, schemaStatementLabel} from "./pg-schema.js";

function createPool({lockAcquired = true} = {}) {
    const calls: any[] = [];
    let released = false;
    const client = {
        async query(query, values?) {
            calls.push({query, values});
            const text = typeof query === "string" ? query : query.text;
            if (/pg_try_advisory_lock/.test(text)) return {rows: [{acquired: lockAcquired}]};
            return {rows: [], rowCount: 0};
        },
        release() { released = true; },
    };
    return {
        pool: {connect: async () => client},
        calls,
        released: () => released,
    };
}

test("Schema 迁移设置数据库超时、持有互斥锁并创建充值索引", async () => {
    const harness = createPool();
    await ensureSchemaWithPool(harness.pool, {
        logger: {log() {}, warn() {}},
        lockTimeoutMs: 1234,
        statementTimeoutMs: 5678,
        queryTimeoutMs: 6789,
    });

    assert.equal(harness.released(), true);
    assert.equal(harness.calls[0].values[0], "1234ms");
    assert.equal(harness.calls[1].values[0], "5678ms");
    const observed = harness.calls.filter((call) => typeof call.query === "object");
    assert.ok(observed.length > 80);
    assert.ok(observed.every((call) => call.query.query_timeout === 6789));
    const sql = observed.map((call) => call.query.text).join("\n");
    assert.match(sql, /idx_recharge_queue_card/);
    assert.match(sql, /idx_recharge_queue_active_submission/);
    assert.match(sql, /idx_recharge_queue_rebind_reconcile/);
    assert.match(String(harness.calls.at(-1).query), /pg_advisory_unlock/);
});

test("Schema 迁移锁被占用时快速失败并释放连接", async () => {
    const harness = createPool({lockAcquired: false});
    await assert.rejects(
        ensureSchemaWithPool(harness.pool, {logger: {log() {}, warn() {}}}),
        /另一个实例正在执行 Schema 迁移/,
    );
    assert.equal(harness.released(), true);
    assert.equal(harness.calls.some((call) => typeof call.query === "object"), false);
});

test("Schema 日志标签不会输出整段 SQL", () => {
    assert.equal(
        schemaStatementLabel("ALTER TABLE recharge_queue ADD COLUMN IF NOT EXISTS submitted_at BIGINT DEFAULT 0"),
        "ALTER TABLE recharge_queue ADD COLUMN IF NOT EXISTS submitted_at",
    );
});
