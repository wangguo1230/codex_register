// @ts-nocheck
// 将本地 auth 文件内容迁移到 PostgreSQL JSONB 列
// 用法: DATABASE_URL=... npx tsx scripts/migrate-auth-to-pg.ts
import {readFileSync} from "node:fs";
import {pool} from "../server/pg.js";
import {ensureSchema} from "../server/pg-schema.js";

function readJson(p: string) {
    try { return JSON.parse(readFileSync(p, "utf8")); }
    catch { return null; }
}

async function main() {
    await ensureSchema();

    // GPT accounts: auth_data + rt_data
    const {rows: gptRows} = await pool.query(
        `SELECT id, auth_file, rt_file FROM gpt_accounts WHERE (auth_file != '' AND auth_data IS NULL) OR (rt_file != '' AND rt_data IS NULL)`
    );
    let gptAuth = 0, gptRt = 0, gptFail = 0;
    for (const r of gptRows) {
        if (r.auth_file && !r.auth_data) {
            const data = readJson(r.auth_file);
            if (data) {
                await pool.query(`UPDATE gpt_accounts SET auth_data=$1 WHERE id=$2`, [JSON.stringify(data), r.id]);
                gptAuth++;
            } else {
                gptFail++;
                console.warn(`[warn] gpt#${r.id} auth_file 读取失败: ${r.auth_file}`);
            }
        }
        if (r.rt_file && !r.rt_data) {
            const data = readJson(r.rt_file);
            if (data) {
                await pool.query(`UPDATE gpt_accounts SET rt_data=$1 WHERE id=$2`, [JSON.stringify(data), r.id]);
                gptRt++;
            } else {
                gptFail++;
                console.warn(`[warn] gpt#${r.id} rt_file 读取失败: ${r.rt_file}`);
            }
        }
    }
    console.log(`[gpt] auth_data: ${gptAuth}, rt_data: ${gptRt}, 失败: ${gptFail} (共 ${gptRows.length} 条)`);

    // Claude accounts: auth_data
    const {rows: claudeRows} = await pool.query(
        `SELECT id, auth_file FROM claude_accounts WHERE auth_file != '' AND auth_data IS NULL`
    );
    let claudeOk = 0, claudeFail = 0;
    for (const r of claudeRows) {
        const data = readJson(r.auth_file);
        if (data) {
            await pool.query(`UPDATE claude_accounts SET auth_data=$1 WHERE id=$2`, [JSON.stringify(data), r.id]);
            claudeOk++;
        } else {
            claudeFail++;
            console.warn(`[warn] claude#${r.id} auth_file 读取失败: ${r.auth_file}`);
        }
    }
    console.log(`[claude] auth_data: ${claudeOk}, 失败: ${claudeFail} (共 ${claudeRows.length} 条)`);

    // Recharge queue: 快照 auth_data
    const {rows: rqRows} = await pool.query(
        `SELECT rq.id, rq.account_id FROM recharge_queue rq WHERE rq.auth_data IS NULL`
    );
    let rqOk = 0;
    for (const r of rqRows) {
        const {rows: [acc]} = await pool.query(`SELECT auth_data FROM gpt_accounts WHERE id=$1`, [r.account_id]);
        if (acc?.auth_data) {
            await pool.query(`UPDATE recharge_queue SET auth_data=$1 WHERE id=$2`, [JSON.stringify(acc.auth_data), r.id]);
            rqOk++;
        }
    }
    console.log(`[recharge_queue] auth_data 快照: ${rqOk} (共 ${rqRows.length} 条)`);

    // 验证
    const {rows: [{n: gptWithAuth}]} = await pool.query(`SELECT COUNT(*)::int AS n FROM gpt_accounts WHERE auth_data IS NOT NULL`);
    const {rows: [{n: gptWithRt}]} = await pool.query(`SELECT COUNT(*)::int AS n FROM gpt_accounts WHERE rt_data IS NOT NULL`);
    const {rows: [{n: claudeWithAuth}]} = await pool.query(`SELECT COUNT(*)::int AS n FROM claude_accounts WHERE auth_data IS NOT NULL`);
    console.log(`\n[验证] gpt auth_data: ${gptWithAuth}, rt_data: ${gptWithRt}, claude auth_data: ${claudeWithAuth}`);

    await pool.end();
    console.log("\n迁移完成!");
}

main().catch((e) => { console.error(e); process.exit(1); });
