import pg from "pg";
const c = new pg.Client({connectionString: "postgresql://postgres:123456@192.168.1.126:5432/all_register"});
await c.connect();
const batch = "1786850500362"; // created_at of current wave
const {rows: jobs} = await c.query(
    `SELECT email, status, ok, instance_id, left(coalesce(last_line,error,''), 200) AS line
     FROM mail_jobs WHERE created_at=$1 AND kind='harden' ORDER BY id`,
    [batch],
);
console.log("n", jobs.length);
const tally = {};
for (const j of jobs) tally[j.status] = (tally[j.status] || 0) + 1;
console.log("status", tally);
const fail = jobs.filter((j) => j.status === "error");
const groups = {};
for (const j of fail) {
    const s = j.line || "";
    let k = "其它";
    if (/拒绝生成应用密码/.test(s)) k = "IMAP·Google拒发应用密码";
    else if (/未能提取应用专用密码|未点到创建/.test(s)) k = "IMAP·没抽出密码";
    else if (/换2FA超时|没有出现填码框|未找到验证码/.test(s)) k = "换2FA失败";
    else if (/登录失败|邮箱页提交|登录页一直空白|signin\/rejected/.test(s)) k = "登录/出口";
    else if (/代理中断/.test(s)) k = "代理中断";
    else if (/超时失败/.test(s)) k = "整单超时";
    groups[k] = groups[k] || [];
    groups[k].push(`${j.email}  [${j.instance_id}]  ${s}`);
}
console.log("\nFAIL_GROUPS");
for (const [k, arr] of Object.entries(groups)) {
    console.log(`\n## ${k} (${arr.length})`);
    for (const x of arr) console.log(" -", x);
}
const done = jobs.filter((j) => j.status === "done");
console.log("\nOK", done.length, done.map((j) => j.email).join(", "));
await c.end();
