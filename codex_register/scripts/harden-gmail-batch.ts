// 无人值守整备：默认把库里未挂 GPT、未 ready 的 Gmail 一次跑完。
//   npx tsx scripts/harden-gmail-batch.ts
//   npx tsx scripts/harden-gmail-batch.ts a@gmail.com b@gmail.com
//   CONCURRENCY=2 npx tsx scripts/harden-gmail-batch.ts
import pg from "pg";
import {readFileSync} from "node:fs";
import {runGoogleHardenWithBit} from "../src/mail/google-secure.ts";
import {deriveGoogleState} from "../src/mail/google-state.ts";
import {straightenGoogleCreds} from "../src/mfa.ts";
import {installBitCleanupSignals, sweepStaleBitWindows} from "../src/bitbrowser.ts";
import {clearMailboxJobStop, isMailboxJobStopped, writeMailboxJobProgress} from "../src/mail/mailbox-job-stop.ts";

const DATABASE_URL = process.env.DATABASE_URL || "postgresql://postgres:123456@192.168.1.126:5432/all_register";
const CONCURRENCY = Math.max(1, Math.min(5, Number(process.env.CONCURRENCY || 2)));
const ARG_EMAILS = process.argv.slice(2).map((s) => s.trim().toLowerCase()).filter((s) => s.includes("@"));

function stamp() {
    const d = new Date();
    const p = (n) => String(n).padStart(2, "0");
    return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function loadPoolLines() {
    try {
        const s = JSON.parse(readFileSync(new URL("../data/settings.json", import.meta.url), "utf8"));
        return Array.isArray(s.mailProxyPool) ? s.mailProxyPool.filter(Boolean) : [];
    } catch { return []; }
}

function isNetworkFail(r) {
    const msg = `${r?.error || ""} ${(r?.errors || []).join(" ")}`;
    return /代理不通|登录失败|网络|chrome-error|ERR_CONNECTION|ERR_SSL|SSL\/代理/i.test(msg);
}

const db = new pg.Pool({connectionString: DATABASE_URL});

async function listNeedHarden() {
    if (ARG_EMAILS.length) {
        const {rows} = await db.query(
            `SELECT * FROM mailboxes WHERE deleted_at=0 AND email = ANY($1) ORDER BY id DESC`,
            [ARG_EMAILS],
        );
        return rows;
    }
    const {rows} = await db.query(`
        SELECT * FROM mailboxes m
        WHERE m.deleted_at=0 AND m.provider='google' AND COALESCE(m.sold_at,0)=0
          AND COALESCE(m.password,'')<>''
          AND m.usage IN ('free','hold')
          AND NOT EXISTS (SELECT 1 FROM gpt_accounts g WHERE g.mailbox_id=m.id AND g.deleted_at=0)
          AND (
            COALESCE(m.google_stage,'') NOT IN ('ready','gpt_ok')
            OR COALESCE(m.imap_password,'')=''
            OR COALESCE(m.recovery_email,'')<>''
          )
        ORDER BY m.id DESC
    `);
    return rows;
}

async function writePassword(id, password, status) {
    await db.query(
        `UPDATE mailboxes
         SET password_prev=CASE WHEN password<>$1 AND COALESCE(password,'')<>'' THEN password ELSE password_prev END,
             password=$1, pw_status=$2
         WHERE id=$3`,
        [password, status, id],
    );
}

async function persist(mb, r) {
    const now = Date.now();
    if (r.passwordChanged && r.password) {
        await writePassword(mb.id, r.password, r.ok ? `✅整备 ${stamp()}` : `⚠整备部分 ${stamp()}`);
        mb.password = r.password;
    } else {
        await db.query(`UPDATE mailboxes SET pw_status=$1 WHERE id=$2`, [r.ok ? `✅整备 ${stamp()}` : `⚠整备部分 ${stamp()}`, mb.id]);
    }
    if (r.totpSecret) {
        await db.query(`UPDATE mailboxes SET totp_secret=$1 WHERE id=$2`, [r.totpSecret, mb.id]);
        mb.totp_secret = r.totpSecret;
    }
    if (r.imapPassword) await db.query(`UPDATE mailboxes SET imap_password=$1 WHERE id=$2`, [r.imapPassword, mb.id]);
    if (r.recoveryCleared) await db.query(`UPDATE mailboxes SET recovery_email='' WHERE id=$1`, [mb.id]);
    const {rows: [fresh]} = await db.query(`SELECT * FROM mailboxes WHERE id=$1`, [mb.id]);
    const state = deriveGoogleState(fresh, {
        login: r.ok || r.password || r.totpSecret ? "ok" : (r.error ? "fail" : undefined),
        password: r.password ? "ok" : undefined,
        totp: r.totpSecret ? "ok" : undefined,
        recovery: r.recoveryCleared ? "ok" : undefined,
        phone: r.phoneCleared ? "ok" : undefined,
        imap: r.imapPassword ? "ok" : undefined,
        last_error: (r.errors || [r.error]).filter(Boolean).join("; ").slice(0, 160),
    });
    await db.query(
        `UPDATE mailboxes SET google_state=$1::jsonb, google_stage=$2 WHERE id=$3`,
        [JSON.stringify(state), state.stage, mb.id],
    );
    await db.query(
        `INSERT INTO mailbox_logs(mailbox_id,ts,line) VALUES($1,$2,$3)`,
        [mb.id, now, `[整备] 批量 ${r.ok ? "完成" : "部分失败"} ${(r.errors || [r.error]).filter(Boolean).join("; ")}`.slice(0, 220)],
    );
}

async function runOne(mb, proxyUrl, idx, total) {
    const {rows: [fresh]} = await db.query(`SELECT * FROM mailboxes WHERE id=$1`, [mb.id]);
    if (fresh) Object.assign(mb, fresh);
    const short = String(mb.email).split("@")[0];
    const log = (m) => console.log(`[${idx}/${total} ${short}] ${m}`);
    const straight = straightenGoogleCreds({totpSecret: mb.totp_secret, recoveryEmail: mb.recovery_email});
    if (straight.swapped) {
        await db.query(`UPDATE mailboxes SET totp_secret=$1, recovery_email=$2 WHERE id=$3`,
            [straight.totpSecret, straight.recoveryEmail, mb.id]);
        mb.totp_secret = straight.totpSecret;
        mb.recovery_email = straight.recoveryEmail;
        log("导入字段对调已写回库");
    }
    const acc = {
        email: mb.email,
        password: mb.password,
        totpSecret: straight.totpSecret,
        totp_secret: straight.totpSecret,
        recoveryEmail: straight.recoveryEmail,
        recovery_email: straight.recoveryEmail,
    };
    const onCheckpoint = async (patch = {}) => {
        if (patch.password) {
            await writePassword(mb.id, patch.password, `✅改密 ${stamp()}`);
            mb.password = patch.password;
            acc.password = patch.password;
            await db.query(`INSERT INTO mailbox_logs(mailbox_id,ts,line) VALUES($1,$2,$3)`,
                [mb.id, Date.now(), `[落库] 新密码 ${patch.password}`.slice(0, 220)]);
            log(`[落库] 新密码已写入 ${patch.password}`);
        }
        if (patch.totpSecret) {
            await db.query(`UPDATE mailboxes SET totp_secret=$1 WHERE id=$2`, [patch.totpSecret, mb.id]);
            mb.totp_secret = patch.totpSecret;
            acc.totpSecret = patch.totpSecret;
            acc.totp_secret = patch.totpSecret;
            await db.query(`INSERT INTO mailbox_logs(mailbox_id,ts,line) VALUES($1,$2,$3)`,
                [mb.id, Date.now(), `[落库] 新 TOTP ${patch.totpSecret}`.slice(0, 220)]);
            log("[落库] 新 TOTP 已写入");
        }
        if (patch.imapPassword) {
            await db.query(`UPDATE mailboxes SET imap_password=$1 WHERE id=$2`, [patch.imapPassword, mb.id]);
            log("[落库] IMAP 应用密码已写入");
        }
        if (patch.recoveryCleared) {
            await db.query(`UPDATE mailboxes SET recovery_email='' WHERE id=$1`, [mb.id]);
        }
    };
    if (isMailboxJobStopped()) return {ok: false, error: "已停止", errors: ["已停止"]};
    let r = await runGoogleHardenWithBit(acc, {proxyUrl, log, onCheckpoint}).catch((e) => ({
        ok: false, error: String(e?.message || e), errors: [String(e?.message || e)],
    }));
    if (isMailboxJobStopped()) return {ok: false, error: "已停止", errors: ["已停止"]};
    if (!r.ok && isNetworkFail(r) && !isMailboxJobStopped()) {
        log("网络/登录失败，换出口再试一次");
        r = await runGoogleHardenWithBit(acc, {proxyUrl, log, onCheckpoint}).catch((e) => ({
            ok: false, error: String(e?.message || e), errors: [String(e?.message || e)],
        }));
    }
    await persist(mb, r);
    console.log(`RESULT ${mb.email}`, {
        ok: !!r.ok,
        missing: r.missing || [],
        totp: !!r.totpSecret,
        pw: !!r.password,
        imap: !!r.imapPassword,
        rec: !!r.recoveryCleared,
        err: (r.errors || [r.error]).filter(Boolean).join("; ").slice(0, 160),
    });
    return r;
}

async function runPool(items, worker, conc) {
    let i = 0;
    const workers = Array.from({length: Math.min(conc, items.length)}, async () => {
        while (i < items.length) {
            if (isMailboxJobStopped()) return;
            const cur = i++;
            await worker(items[cur], cur);
        }
    });
    await Promise.all(workers);
}

await db.query(`ALTER TABLE mailboxes ADD COLUMN IF NOT EXISTS password_prev TEXT DEFAULT ''`);

installBitCleanupSignals();
clearMailboxJobStop();
const swept = await sweepStaleBitWindows({log: console.log});
if (swept) console.log(`启动已清残留指纹 ${swept} 个`);

const proxies = loadPoolLines();
const list = await listNeedHarden();
if (!list.length) {
    console.log("没有需要整备的 Gmail");
    await db.end();
    process.exit(0);
}
console.log(`待整备 ${list.length} 个，并发 ${CONCURRENCY}，代理 ${proxies.length} 条`);
for (const m of list) console.log(`  - ${m.email} ${m.google_stage || "-"}`);

let ok = 0, fail = 0;
const live = new Map();
writeMailboxJobProgress({running: true, kind: "harden", done: 0, total: list.length, ok: 0, fail: 0, current: [], lastLine: `待整备 ${list.length}`, source: "cli"});
await runPool(list, async (mb, idx) => {
    const proxyUrl = proxies[idx % Math.max(proxies.length, 1)] || "";
    console.log(`\n======== ${idx + 1}/${list.length} ${mb.email} ========`);
    live.set(mb.email, {id: mb.id, email: mb.email, lastLine: "开始"});
    writeMailboxJobProgress({
        running: true, kind: "harden", done: ok + fail, total: list.length, ok, fail,
        current: [...live.values()], lastLine: `${mb.email} 开始`, source: "cli",
    });
    const r = await runOne(mb, proxyUrl, idx + 1, list.length);
    live.delete(mb.email);
    if (r.ok) ok++;
    else fail++;
    writeMailboxJobProgress({
        running: true, kind: "harden", done: ok + fail, total: list.length, ok, fail,
        current: [...live.values()], lastLine: `${mb.email} ${r.ok ? "完成" : "失败"}`, source: "cli",
    });
}, CONCURRENCY);

writeMailboxJobProgress({
    running: false, kind: "harden", done: ok + fail, total: list.length, ok, fail,
    current: [], lastLine: `结束 成功 ${ok}/${list.length}`, source: "cli",
});
console.log(`\nDONE 成功 ${ok} / 失败 ${fail} / 合计 ${list.length}`);
await db.end();
