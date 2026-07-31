// @ts-nocheck
// 一次性数据迁移：把旧 SQLite(data/register.db) 的全部业务数据搬进 PostgreSQL。
// 用法：npx tsx scripts/migrate-sqlite-to-pg.ts
//   REG_DB_PATH=xxx.db  可覆盖源 SQLite 路径
//   DATABASE_URL=...    可覆盖目标 PG 连接串(默认同 server/pg.ts)
//
// 迁移策略：
//   - 按依赖顺序搬表(mailboxes 先于引用它的 gpt_accounts/claude_accounts)
//   - 保留原 id(显式插入 id 列)，搬完后用 setval 把 SERIAL 序列对齐到 MAX(id)+1
//   - 每批 100 行、多值 INSERT，ON CONFLICT DO NOTHING 保证可重复执行(幂等)
//   - 源表不存在则跳过，不中断整体迁移
import Database from "better-sqlite3";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {pool} from "../server/pg.js";
import {ensureSchema} from "../server/pg-schema.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SQLITE_PATH = process.env.REG_DB_PATH || path.resolve(__dirname, "..", "data", "register.db");

const BATCH_SIZE = 100;

// 各表迁移的列清单(与 server/pg-schema.ts 建表列一一对应)，顺序即依赖顺序。
const TABLES = [
    {
        name: "mailboxes",
        columns: ["id", "email", "password", "provider", "usage", "grp", "pw_status", "note", "created_at"],
    },
    {
        name: "gpt_accounts",
        columns: ["id", "mailbox_id", "status", "token", "auth_file", "rt_file", "plan", "phone", "card", "engine",
            "batch", "at_status", "rt_status", "chat_status", "error", "dead_at", "sold_at", "started_at",
            "finished_at", "created_at"],
    },
    {
        name: "claude_accounts",
        columns: ["id", "mailbox_id", "status", "session_key", "org_id", "auth_file", "plan", "engine", "batch",
            "error", "dead_at", "sold_at", "started_at", "finished_at", "created_at", "claude_code"],
    },
    {
        name: "logs",
        columns: ["id", "account_id", "ts", "line"],
    },
    {
        name: "mailbox_logs",
        columns: ["id", "mailbox_id", "ts", "line"],
    },
    {
        name: "claude_logs",
        columns: ["id", "claude_id", "ts", "line"],
    },
    {
        name: "sms_pool",
        columns: ["id", "phone", "link", "status", "bound_email", "created_at", "card", "bind_count", "bind_emails"],
    },
    {
        name: "recharge_cards",
        columns: ["id", "code", "plan_type", "plan_name", "product", "category", "auth_mode", "status",
            "account_id", "account_email", "task_no", "task_status", "task_message", "error", "batch",
            "created_at", "updated_at"],
    },
    {
        name: "recharge_queue",
        columns: ["id", "account_id", "email", "auth_file", "plan", "batch", "card_id", "card_code", "status",
            "task_no", "task_status", "task_message", "error", "created_at", "plan_type"],
    },
    {
        // 旧版遗留表，可选：存在才搬
        name: "accounts",
        columns: ["id", "email", "password", "status", "plan", "token", "auth_file", "error", "started_at",
            "finished_at", "created_at", "phone", "card", "at_status", "rt_status", "chat_status", "rt_file",
            "dead_at", "sold_at", "pw_status", "batch"],
    },
];

function sqliteTableExists(db, name) {
    const row = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`).get(name);
    return !!row;
}

async function insertBatch(tableName, columns, rows) {
    if (!rows.length) return 0;
    const colList = columns.join(",");
    const valuesSql = [];
    const params = [];
    let p = 0;
    for (const row of rows) {
        const placeholders = columns.map(() => `$${++p}`);
        valuesSql.push(`(${placeholders.join(",")})`);
        for (const col of columns) {
            const v = row[col];
            params.push(v === undefined ? null : v);
        }
    }
    const sql = `INSERT INTO ${tableName}(${colList}) VALUES ${valuesSql.join(",")} ON CONFLICT DO NOTHING`;
    const res = await pool.query(sql, params);
    return res.rowCount || 0;
}

async function migrateTable(db, table) {
    const {name, columns} = table;
    if (!sqliteTableExists(db, name)) {
        console.log(`[skip] SQLite 中不存在表 ${name}，跳过`);
        return {source: 0, inserted: 0};
    }
    const rows = db.prepare(`SELECT * FROM ${name}`).all();
    let inserted = 0;
    for (let i = 0; i < rows.length; i += BATCH_SIZE) {
        const batch = rows.slice(i, i + BATCH_SIZE);
        inserted += await insertBatch(name, columns, batch);
    }
    console.log(`[migrate] ${name}: 源 ${rows.length} 行 → 插入 ${inserted} 行(跳过 ${rows.length - inserted} 行已存在)`);
    return {source: rows.length, inserted};
}

async function resetSequence(tableName) {
    try {
        await pool.query(
            `SELECT setval(pg_get_serial_sequence($1, 'id'), COALESCE((SELECT MAX(id) FROM ${tableName}), 0) + 1, false)`,
            [tableName]
        );
    } catch (e) {
        console.warn(`[warn] 重置序列失败 ${tableName}: ${e.message}`);
    }
}

async function printCounts() {
    console.log("\n=== 迁移后 PG 行数核对 ===");
    for (const {name} of TABLES) {
        try {
            const {rows} = await pool.query(`SELECT COUNT(*)::int AS n FROM ${name}`);
            console.log(`  ${name}: ${rows[0].n}`);
        } catch (e) {
            console.log(`  ${name}: 查询失败(${e.message})`);
        }
    }
}

async function main() {
    console.log(`[migrate] 源 SQLite: ${SQLITE_PATH}`);
    const db = new Database(SQLITE_PATH, {readonly: true, fileMustExist: true});

    console.log("[migrate] 确保 PG 表结构就绪...");
    await ensureSchema();

    const summary = [];
    for (const table of TABLES) {
        const r = await migrateTable(db, table);
        summary.push({name: table.name, ...r});
    }

    console.log("\n[migrate] 重置 PG 序列(避免后续插入与已迁移 id 冲突)...");
    for (const {name} of TABLES) {
        await resetSequence(name);
    }

    db.close();

    await printCounts();

    const totalSource = summary.reduce((s, r) => s + r.source, 0);
    const totalInserted = summary.reduce((s, r) => s + r.inserted, 0);
    console.log(`\n[migrate] 完成：源共 ${totalSource} 行，本次新插入 ${totalInserted} 行。`);

    await pool.end();
    process.exit(0);
}

main().catch(async (e) => {
    console.error("[migrate] 迁移失败:", e);
    try { await pool.end(); } catch (_) { /* ignore */ }
    process.exit(1);
});
