// @ts-nocheck
import pg from "pg";
import {Pool, PoolClient} from "pg";

// BIGINT (OID 20) 默认返回字符串 → 转为 number（毫秒时间戳在 Number.MAX_SAFE_INTEGER 范围内）
pg.types.setTypeParser(20, (val) => {
    const n = Number(val);
    return Number.isSafeInteger(n) ? n : val;
});

const DATABASE_URL = process.env.DATABASE_URL || "postgresql://postgres:123456@192.168.1.126:5432/all_register";

export const pool = new Pool({
    connectionString: DATABASE_URL,
    max: 20,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000,
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

export async function initDb() {
    const client = await pool.connect();
    try {
        await client.query("SELECT 1");
        console.log(`[pg] 已连接 PostgreSQL: ${DATABASE_URL.replace(/\/\/.*@/, "//***@")}`);
    } finally {
        client.release();
    }
}
