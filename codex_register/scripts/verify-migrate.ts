// P1 迁移验证:在临时库上跑新 db.ts 的一次性迁移,核对数据完整 + 兼容形状 + 分流写入。
// 用法:REG_DB_PATH=/tmp/xxx.db tsx scripts/verify-migrate.ts   (库须为旧结构副本)
import Database from "better-sqlite3";

const P = process.env.REG_DB_PATH!;
// 迁移前:直接读旧 accounts 做对照基线
const raw = new Database(P, {readonly: true});
const legacy = raw.prepare(`SELECT * FROM accounts ORDER BY id`).all();
const legacyById = new Map(legacy.map((r: any) => [r.id, r]));
raw.close();

// 触发 db.ts 迁移(import 即执行建表 + 迁移)
const db = await import("../server/db.js");

let fail = 0;
const ok = (c: boolean, msg: string) => { console.log((c ? "✅" : "❌") + " " + msg); if (!c) fail++; };

// 1. 行数守恒
const list = db.listAccounts();
ok(list.length === legacy.length, `账号数守恒: 迁移后 ${list.length} == 旧 ${legacy.length}`);

// 2. 兼容形状:Account 接口字段齐全
const NEED = ["id", "email", "password", "status", "plan", "token", "auth_file", "rt_file", "phone", "card",
    "at_status", "rt_status", "chat_status", "dead_at", "sold_at", "pw_status", "batch", "error",
    "started_at", "finished_at", "created_at"];
const k0 = new Set(Object.keys(list[0] || {}));
ok(NEED.every((n) => k0.has(n)), `字段齐全: ${NEED.filter((n) => !k0.has(n)).join(",") || "全部命中"}`);

// 3. 逐行值一致(抽样全量比对关键字段)
let mismatch = 0;
for (const row of list as any[]) {
    const o: any = legacyById.get(row.id);
    if (!o) { mismatch++; continue; }
    for (const f of ["email", "password", "status", "token", "at_status", "rt_status", "pw_status", "batch", "dead_at", "sold_at", "phone", "card", "auth_file", "rt_file", "plan"]) {
        if ((row[f] ?? "") !== (o[f] ?? "")) { mismatch++; if (mismatch <= 5) console.log(`   ⚠ id=${row.id} 字段 ${f}: 新[${row[f]}] != 旧[${o[f]}]`); }
    }
}
ok(mismatch === 0, `逐行字段一致: ${mismatch} 处不一致`);

// 4. id 对齐:gpt_accounts.id == 原 accounts.id
const ids = new Set(list.map((r: any) => r.id));
ok([...legacyById.keys()].every((id) => ids.has(id)), `id 对齐: 原 id 全部保留`);

// 5. mailboxStats: 全部 gpt,无 free
const ms = db.mailboxStats();
ok(ms.gpt === legacy.length && ms.free === 0 && ms.claude === 0, `mailboxStats: ${JSON.stringify(ms)}`);

// 6. stats 与旧一致
const st = db.stats();
const legacyStats: any = {pending: 0, running: 0, success: 0, failed: 0, total: 0};
for (const r of legacy as any[]) { legacyStats[r.status === "running" ? "pending" : r.status]++; legacyStats.total++; } // running 启动会被重置为 pending
ok(st.total === legacyStats.total, `stats.total: ${st.total} == ${legacyStats.total}`);

// 7. 分流写:改 password 落 mailboxes,改 status 落 gpt_accounts,读回一致
const t = list[0] as any;
db.updateAccount(t.id, {password: "__TEST_PW__", status: "failed", error: "__TEST_ERR__"});
const back = db.getAccount(t.id) as any;
ok(back.password === "__TEST_PW__", `password 分流到 mailboxes 并读回`);
ok(back.status === "failed" && back.error === "__TEST_ERR__", `status/error 分流到 gpt_accounts 并读回`);
db.updatePassword(t.id, "__TEST_PW2__");
ok((db.getAccount(t.id) as any).password === "__TEST_PW2__", `updatePassword 写 mailboxes`);
db.setPwStatus(t.id, "__PWS__");
ok((db.getAccount(t.id) as any).pw_status === "__PWS__", `setPwStatus 写 mailboxes`);

// 8. importAccounts 新建 mailbox+gpt(usage=gpt),重复 email 跳过
const before = db.listAccounts().length;
const r1 = db.importAccounts([{email: "__mig_test__@x.com", password: "p1"}], "migtest");
const r2 = db.importAccounts([{email: "__mig_test__@x.com", password: "p2"}], "migtest"); // 重复
ok(r1.inserted === 1 && r2.inserted === 0 && r2.skipped === 1, `import: 新建1 重复跳过 (${JSON.stringify(r1)}/${JSON.stringify(r2)})`);
const added = db.listAccounts().find((a: any) => a.email === "__mig_test__@x.com") as any;
ok(!!added && added.batch === "migtest", `import 建号可查, batch=migtest`);

// 9. deleteAccount 连带删 mailbox(无孤儿)
db.deleteAccount(added.id);
ok(!db.getAccount(added.id), `deleteAccount 删除业务号`);
const orphan = (db.default as any).prepare(`SELECT COUNT(*) n FROM mailboxes WHERE email='__mig_test__@x.com'`).get().n;
ok(orphan === 0, `deleteAccount 连带删邮箱(无孤儿)`);

// 10. allocateMailbox: 当前无 free,返回 null(隔离入口存在)
ok(db.allocateMailbox("claude") === null, `allocateMailbox(claude): 无 free 邮箱返回 null`);

console.log(`\n${fail === 0 ? "🎉 全部通过" : "💥 " + fail + " 项失败"}`);
process.exit(fail === 0 ? 0 : 1);
