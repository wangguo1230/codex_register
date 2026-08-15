// 全流程整备抽检：换2FA → 改密 → 踢设备 → 删手机 → 删辅助邮箱 → IMAP。
// 失败不把未验证的密码/密钥写成成功。4 个一组并发。
//   npx tsx scripts/probe-full-harden.ts --emails=a@gmail.com,b@gmail.com,...
import {readFileSync} from "node:fs";
import pg from "pg";
import * as db from "../server/db.ts";
import {clearMailboxJobStop} from "../src/mail/mailbox-job-stop.ts";
import {setExpectedBitTiles, sweepStaleBitWindows} from "../src/bitbrowser.ts";
import {runGoogleHardenWithBit} from "../src/mail/google-secure.ts";
import {pickLiveMailProxy, setMailProxyJump} from "../src/mail/proxy-pool.ts";

const DATABASE_URL = process.env.DATABASE_URL || "postgresql://postgres:123456@192.168.1.126:5432/all_register";
const CHUNK = 4;

function stamp() {
    return new Date().toISOString().replace(/[:.]/g, "-");
}

function pwStamp() {
    const d = new Date();
    const p = (n) => String(n).padStart(2, "0");
    return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

const emailsArg = process.argv.find((a) => a.startsWith("--emails="));
const EMAILS = (emailsArg ? emailsArg.slice("--emails=".length) : process.argv.slice(2).filter((a) => !a.startsWith("--")).join(","))
    .split(",").map((s) => s.trim().toLowerCase()).filter((s) => s.includes("@"));
if (!EMAILS.length) {
    console.error("usage: tsx scripts/probe-full-harden.ts --emails=a@gmail.com,b@gmail.com");
    process.exit(1);
}

const settings = (() => {
    try { return JSON.parse(readFileSync(new URL("../data/settings.json", import.meta.url), "utf8")); }
    catch { return {}; }
})();
if (settings.mailProxyJump) setMailProxyJump(String(settings.mailProxyJump));
const poolLines = Array.isArray(settings.mailProxyPool) ? settings.mailProxyPool.filter(Boolean) : [];

const pool = new pg.Pool({connectionString: DATABASE_URL});

async function loadMb(email) {
    const {rows} = await pool.query(`SELECT * FROM mailboxes WHERE email=$1 AND deleted_at=0`, [email]);
    return rows[0] || null;
}

async function persist(mb, r) {
    if (r.passwordChanged && r.password && r.verified !== false) {
        await db.setMailboxPassword(mb.id, r.password, r.ok ? `✅整备 ${pwStamp()}` : `⚠整备部分 ${pwStamp()}`);
    } else if (r.ok && !r.passwordChanged) {
        await pool.query(`UPDATE mailboxes SET pw_status=$1 WHERE id=$2`, [`✅整备 ${pwStamp()}`, mb.id]);
    } else if (!r.ok) {
        await pool.query(`UPDATE mailboxes SET pw_status=$1 WHERE id=$2`, [`⚠整备部分 ${pwStamp()}`, mb.id]);
    }
    if (r.totpSecret) {
        await db.setMailboxTotp(mb.id, r.totpSecret);
        await db.refreshMailboxGoogleState(mb.id, {totp: "ok", totp_rotated: true}).catch(() => {});
    }
    await db.applyMailboxUpdate(mb.email, {
        imap_password: r.imapPassword || undefined,
        recovery_email: r.recoveryCleared ? "" : undefined,
    });
    await db.refreshMailboxGoogleState(mb.id, {
        login: r.ok || r.password || r.totpSecret || r.imapPassword ? "ok" : undefined,
        password: r.passwordChanged ? "ok" : undefined,
        totp: r.totpSecret ? "ok" : undefined,
        totp_rotated: r.totpRotated ? true : undefined,
        recovery: r.recoveryCleared ? "ok" : undefined,
        phone: r.phoneCleared ? "ok" : undefined,
        devices: r.devicesDone ? "ok" : undefined,
        imap: r.imapPassword ? "ok" : (r.errors || []).some((x) => /IMAP/i.test(String(x))) ? "fail" : undefined,
        last_error: (r.errors || [r.error]).filter(Boolean).join("; ").slice(0, 160),
    }).catch(() => {});
}

async function runOne(email, idx) {
    if (idx % CHUNK) await new Promise((r) => setTimeout(r, (idx % CHUNK) * 1200));
    const mb = await loadMb(email);
    if (!mb) return {email, ok: false, error: "库里没有这个号"};
    const proxyRaw = poolLines[idx % Math.max(1, poolLines.length)] || "";
    const picked = proxyRaw
        ? await pickLiveMailProxy(proxyRaw, {tries: 2, log: (m) => console.log(`${email} [代理] ${m}`)})
        : {ok: true, url: ""};
    const proxyUrl = picked.ok ? (picked.url || proxyRaw) : "";
    if (proxyRaw && !picked.ok) {
        console.log(`${email} [整备] 代理不通`);
        return {email, ok: false, error: "代理不通"};
    }
    console.log(`${email} [整备] 开始 totp_len=${String(mb.totp_secret || "").length} pw=${mb.pw_status || ""} imap=${mb.imap_password ? "有" : "无"} rec=${mb.recovery_email ? "有" : "无"}`);
    const r = await runGoogleHardenWithBit({
        email: mb.email,
        password: mb.password,
        totpSecret: mb.totp_secret,
        totp_secret: mb.totp_secret,
        recoveryEmail: mb.recovery_email,
        recovery_email: mb.recovery_email,
        imap_password: mb.imap_password || "",
        pw_status: mb.pw_status || "",
        google_state: mb.google_state || {},
    }, {
        proxyUrl,
        log: (m) => {
            console.log(`${email} ${m}`);
            db.appendMailboxLog(mb.id, String(m)).catch(() => {});
        },
        onCheckpoint: async (patch = {}) => {
            if (patch.password) {
                if (patch.verified === false) {
                    console.log(`${email} [留痕] 改密未验证，不覆盖库内密码`);
                } else {
                    await db.setMailboxPassword(mb.id, patch.password, `✅改密(已验证) ${pwStamp()}`);
                    console.log(`${email} [落库] 新密码已写入`);
                }
            }
            if (patch.totpSecret) {
                await db.setMailboxTotp(mb.id, patch.totpSecret);
                await db.refreshMailboxGoogleState(mb.id, {totp: "ok", totp_rotated: true}).catch(() => {});
                console.log(`${email} [落库] 新 TOTP 已写入`);
            }
            if (patch.imapPassword) await db.applyMailboxUpdate(mb.email, {imap_password: patch.imapPassword});
            if (patch.recoveryCleared) await db.applyMailboxUpdate(mb.email, {recovery_email: ""});
        },
    }).catch((e) => ({ok: false, error: String(e?.message || e), errors: [String(e?.message || e)]}));
    await persist(mb, r);
    const err = (r.errors || [r.error]).filter(Boolean).join("; ").slice(0, 180);
    const login = r.login === true || (!/登录失败|代理不通|库里没有/.test(err) && r.login !== false);
    const brief = {
        email,
        login,
        ok: !!r.ok,
        totp: !!r.totpSecret || !!r.totpRotated,
        password: !!r.passwordChanged,
        imap: !!r.imapPassword,
        recovery: !!r.recoveryCleared,
        phone: !!r.phoneCleared,
        devices: !!r.devicesDone,
        missing: r.missing || [],
        error: err,
    };
    console.log(`${email} [整备] 结束`, JSON.stringify(brief));
    return brief;
}

clearMailboxJobStop();
console.log("=== 全流程抽检", stamp(), "n=", EMAILS.length, "一组", CHUNK, "===");
const swept = await sweepStaleBitWindows({includeClosed: true, log: (m) => console.log(m)});
console.log("清残留窗", swept);

const all = [];
for (let i = 0; i < EMAILS.length; i += CHUNK) {
    const chunk = EMAILS.slice(i, i + CHUNK);
    console.log(`\n======== 第 ${Math.floor(i / CHUNK) + 1} 组 ${chunk.join(" ")} ========`);
    setExpectedBitTiles(chunk.length);
    const part = await Promise.all(chunk.map((e, j) => runOne(e, i + j)));
    all.push(...part);
}

console.log("=== 全流程结果 ===");
console.log(JSON.stringify(all, null, 2));
const logged = all.filter((r) => r.login);
const force = all.filter((r) => !r.login);
const modOk = logged.filter((r) => r.password || r.totp);
console.log(`登录 ${logged.length}/${all.length}  登不上(不可抗力) ${force.length}`);
console.log(`能登录后的修改成功率 ${modOk.length}/${logged.length || 1} = ${logged.length ? Math.round(modOk.length / logged.length * 100) : 0}% （改密或换2FA）`);
console.log(`能登录后可用(改密+IMAP) ${logged.filter((r) => r.ok).length}/${logged.length || 1}`);
await pool.end();
process.exit(logged.length && modOk.length / logged.length >= 0.6 ? 0 : 1);
