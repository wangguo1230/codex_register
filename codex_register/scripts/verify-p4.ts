// P4 隔离验证:全新库上测 导入free → 分配 gpt/claude → 校验"不串"。
// 用法:REG_DB_PATH=/tmp/p4.db tsx scripts/verify-p4.ts  (库须为空/新建)
const db = await import("../server/db.js");
let fail = 0;
const ok = (c: boolean, msg: string) => { console.log((c ? "✅" : "❌") + " " + msg); if (!c) fail++; };

// 1. 导入 3 个 free 邮箱
const imp = db.importFreeMailboxes([
    {email: "F1@x.com", password: "p1"}, {email: "f2@x.com", password: "p2"}, {email: "f3@x.com", password: "p3"},
], "poolA");
ok(imp.inserted === 3, `导入 free: ${JSON.stringify(imp)}`);
ok(db.mailboxStats().free === 3, `mailboxStats.free=3: ${JSON.stringify(db.mailboxStats())}`);

// 2. 分配 2 个给 gpt(建 pending gpt_account,进注册队列)
const rg = db.allocateMailboxesTo("gpt", 2, "batchG");
ok(rg.allocated === 2, `分配 gpt 2 个: ${JSON.stringify(rg)}`);

// 3. 请求分配 5 个给 claude,但池只剩 1 → 只分到 1
const rc = db.allocateMailboxesTo("claude", 5, "batchC");
ok(rc.allocated === 1, `分配 claude(池仅剩1): allocated=${rc.allocated}`);

// 4. usage 分布:free=0 gpt=2 claude=1
const ms = db.mailboxStats();
ok(ms.free === 0 && ms.gpt === 2 && ms.claude === 1, `usage 分布: ${JSON.stringify(ms)}`);

// 5. ★不串:GPT 兼容层 listAccounts 只见 gpt 邮箱(2 条),看不到 claude 邮箱
const accs = db.listAccounts();
ok(accs.length === 2, `GPT 域账号数=2(只见 gpt): ${accs.length}`);
const claudeEmails = new Set(db.listMailboxes("claude").map((m: any) => m.email));
const gptEmails = new Set(accs.map((a: any) => a.email));
ok([...gptEmails].every((e) => !claudeEmails.has(e)), `GPT 域不含 claude 邮箱(物理隔离)`);
ok(db.listMailboxes("gpt").length === 2 && db.listMailboxes("claude").length === 1, `按 usage 查询边界正确`);

// 6. gpt_account/claude_account 均为 pending
ok(db.stats().pending === 2, `GPT 队列 pending=2(可被调度注册): ${JSON.stringify(db.stats())}`);

// 7. 池空后再分配 gpt → 0
ok(db.allocateMailboxesTo("gpt", 1).allocated === 0, `池空再分配 gpt = 0`);

// 8. 删除守卫:已被业务占用的邮箱不可从邮箱域删
const gm = db.listMailboxes("gpt")[0] as any;
const del = db.deleteMailbox(gm.id);
ok(del.ok === false, `删除守卫:占用邮箱拒删 (${del.reason || ""})`);

// 9. 导入重复 free(大小写归一)跳过
ok(db.importFreeMailboxes([{email: "f1@x.com", password: "x"}]).inserted === 0, `重复 free(大小写归一)跳过`);

// 10. usage 非法值拒绝
ok(db.allocateMailboxesTo("xxx", 1).error != null, `非法 usage 拒绝`);

console.log(`\n${fail === 0 ? "🎉 全部通过" : "💥 " + fail + " 项失败"}`);
process.exit(fail === 0 ? 0 : 1);
