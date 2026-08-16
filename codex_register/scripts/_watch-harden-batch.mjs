// 盯当前整备批：只在新失败类型 / 新失败截图 / 队列清空时打一行。
import fs from "fs";
import path from "path";
import pg from "pg";

const DATABASE_URL = process.env.DATABASE_URL || "postgresql://postgres:123456@192.168.1.126:5432/all_register";
const SHOT_DIR = path.resolve("/Users/mrwang/study/2026/custom-mail/codex_register/captures/screenshots");
const pool = new pg.Pool({ connectionString: DATABASE_URL });
const started = Date.now();
const seenSig = new Set();
const seenShot = new Set();
let lastLogId = 0;

const FAIL_RE = /登录失败|未找到|异常:|代理不通|换新 session|SSL\/代理|chrome-error|Wrong code|没有可用密钥|二次验证未过|窗口被关|token 失效|Login out|未完成|部分失败|ERR_PROXY|Target page/;
const SKIP_RE = /邮箱页仍在 Loading|动态代理可能较慢|邮箱框未就绪/;

const SKIP_SHOT = /^(secure_devices|secure_phone)$/i;

function shotSig(name) {
    const base = String(name || "").replace(/\.[a-z0-9]+$/i, "");
    const m = base.match(/^(2fa_[a-z]+(?:_[a-z]+)*|pwd_[a-z]+(?:_[a-z]+)*|gmail_[a-z]+(?:_[a-z]+)*|apppw_fail|id_stuck|secure_[a-z]+)/i);
    return m ? m[1] : "";
}

async function tick() {
    const { rows: jobs } = await pool.query(`
      SELECT status, count(*)::int n FROM mail_jobs
      WHERE kind='harden' AND (status IN ('pending','running') OR finished_at > $1)
      GROUP BY 1
    `, [started]);
    const map = Object.fromEntries(jobs.map((r) => [r.status, r.n]));
    const pending = map.pending || 0;
    const running = map.running || 0;
    const done = map.done || 0;
    const error = map.error || 0;

    if (pending === 0 && running === 0) {
        console.log(`DONE harden pending=0 running=0 done=${done} error=${error}`);
        return true;
    }

    const { rows: logs } = await pool.query(`
      SELECT l.id, l.mailbox_id, l.line, m.email
      FROM mailbox_logs l
      JOIN mailboxes m ON m.id=l.mailbox_id
      WHERE l.id > $1 AND l.ts > $2
      ORDER BY l.id ASC
      LIMIT 200
    `, [lastLogId, started - 5000]);
    for (const r of logs) {
        lastLogId = Math.max(lastLogId, r.id);
        const line = String(r.line || "");
        if (SKIP_RE.test(line) || !FAIL_RE.test(line)) continue;
        let sig = "other";
        if (/代理不通|ERR_PROXY|换新 session/.test(line)) sig = "proxy";
        else if (/SSL\/代理|chrome-error|ERR_SSL/.test(line)) sig = "ssl";
        else if (/没有可用密钥|totp 列是邮箱/.test(line)) sig = "nototp";
        else if (/未找到更改|未找到 Authenticator|未进入 Authenticator/.test(line)) sig = "2fa_ui";
        else if (/未找到密码输入框/.test(line)) sig = "pwd_ui";
        else if (/Wrong code/.test(line)) sig = "wrong_totp";
        else if (/二次验证未过/.test(line)) sig = "challenge";
        else if (/token 失效|Login out/.test(line)) sig = "bit";
        else if (/登录失败/.test(line)) sig = "login";
        else if (/部分失败|未完成/.test(line)) sig = "partial";
        const key = sig;
        if (seenSig.has(key)) continue;
        seenSig.add(key);
        console.log(`FAILED ${sig} ${r.email} ${line.replace(/\s+/g, " ").slice(0, 180)}`);
    }

    if (fs.existsSync(SHOT_DIR)) {
        for (const name of fs.readdirSync(SHOT_DIR)) {
            const full = path.join(SHOT_DIR, name);
            let st;
            try { st = fs.statSync(full); } catch { continue; }
            if (st.mtimeMs < started) continue;
            const kind = shotSig(name);
            if (!kind || SKIP_SHOT.test(kind) || seenShot.has(kind)) continue;
            seenShot.add(kind);
            console.log(`FAILED shot ${kind} ${name}`);
        }
    }
    return false;
}

let done = false;
while (!done) {
    try { done = await tick(); }
    catch (e) { console.log(`FAILED watch ${String(e?.message || e).slice(0, 160)}`); }
    if (!done) await new Promise((r) => setTimeout(r, 20000));
}
await pool.end();
process.exit(0);
