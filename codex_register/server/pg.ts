// @ts-nocheck
import pg from "pg";
import {Pool, PoolClient} from "pg";

// BIGINT (OID 20) 默认返回字符串 → 转为 number（毫秒时间戳在 Number.MAX_SAFE_INTEGER 范围内）
pg.types.setTypeParser(20, (val) => {
    const n = Number(val);
    return Number.isSafeInteger(n) ? n : val;
});

const DATABASE_URL = process.env.DATABASE_URL || "postgresql://postgres:123456@192.168.1.126:5432/all_register";
const toPositiveInt = (value, fallback) => {
    const parsed = Number(value);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
};

// 多机部署时每个实例都创建连接池，连接数必须可按数据库容量统一调节。
const PG_POOL_MAX = Math.min(100, toPositiveInt(process.env.PG_POOL_MAX, 20));

export const PG_CONNECTION_TIMEOUT_MS = toPositiveInt(process.env.PG_CONNECTION_TIMEOUT_MS, 10_000);
export const PG_STATEMENT_TIMEOUT_MS = toPositiveInt(process.env.PG_STATEMENT_TIMEOUT_MS, 60_000);
export const PG_QUERY_TIMEOUT_MS = Math.max(
    PG_STATEMENT_TIMEOUT_MS + 5_000,
    toPositiveInt(process.env.PG_QUERY_TIMEOUT_MS, 65_000),
);

export const pool = new Pool({
    connectionString: DATABASE_URL,
    max: PG_POOL_MAX,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: PG_CONNECTION_TIMEOUT_MS,
    statement_timeout: PG_STATEMENT_TIMEOUT_MS,
    query_timeout: PG_QUERY_TIMEOUT_MS,
    application_name: "codex-register",
});

pool.on("error", (err) => {
    console.error("[pg] 连接池异常:", err.message);
});

export async function query(sql: string, params?: any[]) {
    return pool.query(sql, params);
}

export async function withTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await pool.connect();
    try {
        await client.query("BEGIN");
        const result = await fn(client);
        await client.query("COMMIT");
        return result;
    } catch (e) {
        await client.query("ROLLBACK");
        throw e;
    } finally {
        client.release();
    }
}

/** 跨实例短任务单飞；使用会话锁，连接释放前必定尝试解锁。 */
export async function withAdvisoryLock<T>(name: string, fn: (client: PoolClient) => Promise<T>) {
    const client = await pool.connect();
    let acquired = false;
    try {
        const {rows: [row]} = await client.query(
            `SELECT pg_try_advisory_lock(hashtext($1)::bigint) AS acquired`,
            [String(name || "")],
        );
        acquired = row?.acquired === true;
        if (!acquired) return {acquired: false, value: undefined};
        return {acquired: true, value: await fn(client)};
    } finally {
        if (acquired) {
            try {
                await client.query(`SELECT pg_advisory_unlock(hashtext($1)::bigint)`, [String(name || "")]);
            } catch { /* 连接断开时 PostgreSQL 会自动释放会话锁 */ }
        }
        client.release();
    }
}

export async function initDb() {
    const client = await pool.connect();
    try {
        await client.query("SELECT 1");
        console.log(`[pg] 已连接 PostgreSQL: ${DATABASE_URL.replace(/\/\/.*@/, "//***@")}`);
    } finally {
        client.release();
    }
}
