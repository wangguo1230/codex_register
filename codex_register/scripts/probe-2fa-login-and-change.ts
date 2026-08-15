// 停队列后抽检：2 个已换 2FA 的号只测登录，2 个没换过的号只测换 2FA。
// 全程截图 + mailbox_logs。验证失败不覆盖库内密码/密钥。
//   npx tsx scripts/probe-2fa-login-and-change.ts
import {mkdirSync} from "node:fs";
import path from "node:path";
import pg from "pg";
import * as db from "../server/db.ts";
import {clearMailboxJobStop} from "../src/mail/mailbox-job-stop.ts";
import {sweepStaleBitWindows} from "../src/bitbrowser.ts";
import {withGoogleBitSession} from "../src/mail/google-secure.ts";
import {ensureGoogleLoggedIn} from "../src/mail/google-auth.ts";
import {change2faOnPage} from "../src/mail/google-manage.ts";
import {pickLiveMailProxy, setMailProxyJump} from "../src/mail/proxy-pool.ts";

function looksLikeAccountHome(url, body) {
    const u = String(url || "");
    const t = String(body || "");
    if (/accounts\.google\.com\/(v3\/)?signin|challenge\/totp|identifier/i.test(u)) return false;
    return /myaccount\.google\.com/i.test(u) || /Google Account|Security|两步验证|Two-step/i.test(t);
}

const DATABASE_URL = process.env.DATABASE_URL || "postgresql://postgres:123456@192.168.1.126:5432/all_register";
const OUT = path.resolve(process.cwd(), "captures", "probe-2fa");
mkdirSync(OUT, {recursive: true});

const LOGIN_EMAILS = [
    "oussbouajaj.abd@gmail.com",
    "rotichfelix487@gmail.com",
];
const CHANGE_EMAILS = [
    "hamedmeshao@gmail.com",
    "gabrielchoo728@gmail.com",
];

function stamp() {
    return new Date().toISOString().replace(/[:.]/g, "-");
}

async function shot(page, tag, email) {
    const file = path.join(OUT, `${String(email).split("@")[0]}_${tag}_${Date.now()}.png`);
    try {
        await page.screenshot({path: file, fullPage: true});
        return file;
    } catch (e) {
        return `shot-fail:${e?.message || e}`;
    }
}

const poolLines = await (async () => {
    try {
        const {readFileSync} = await import("node:fs");
        const s = JSON.parse(readFileSync(new URL("../data/settings.json", import.meta.url), "utf8"));
        if (s.mailProxyJump) setMailProxyJump(String(s.mailProxyJump));
        return Array.isArray(s.mailProxyPool) ? s.mailProxyPool.filter(Boolean) : [];
    } catch {
        return [];
    }
})();

const pool = new pg.Pool({connectionString: DATABASE_URL});

async function loadMb(email) {
    const {rows} = await pool.query(`SELECT * FROM mailboxes WHERE email=$1 AND deleted_at=0`, [email]);
    return rows[0] || null;
}

async function trace(mb, line) {
    const msg = `[抽检] ${line}`;
    console.log(`${mb.email} ${msg}`);
    await db.appendMailboxLog(mb.id, msg).catch(() => {});
}

async function runOne(kind, email, idx) {
    const mb = await loadMb(email);
    if (!mb) return {email, kind, ok: false, error: "库里没有这个号"};
    const proxyRaw = poolLines[idx % Math.max(1, poolLines.length)] || "";
    const picked = proxyRaw
        ? await pickLiveMailProxy(proxyRaw, {tries: 2, log: (m) => console.log(`${email} [代理] ${m}`)})
        : {ok: true, url: ""};
    const proxyUrl = picked.ok ? (picked.url || proxyRaw) : "";
    if (proxyRaw && !picked.ok) {
        await trace(mb, `代理不通 ${picked.probe?.reason || ""}`);
        return {email, kind, ok: false, error: "代理不通"};
    }
    await trace(mb, `${kind} 开始 totp_len=${String(mb.totp_secret || "").length} pw=${mb.pw_status || ""}`);
    const result = await withGoogleBitSession({
        proxyUrl, name: `probe-${kind}-${String(email).split("@")[0].slice(0, 10)}`,
        remark: "gmail-harden",
        log: (m) => { console.log(`${email} ${m}`); db.appendMailboxLog(mb.id, String(m)).catch(() => {}); },
    }, async (page) => {
        const loginOk = await ensureGoogleLoggedIn(page, "https://myaccount.google.com/security?hl=en", {
            email: mb.email,
            password: mb.password,
            totpSecret: mb.totp_secret,
            recoveryEmail: mb.recovery_email || "",
            requireInbox: false,
        }, (m) => { console.log(`${email} ${m}`); db.appendMailboxLog(mb.id, String(m)).catch(() => {}); });
        const url = String(page.url());
        const body = String(await page.innerText("body").catch(() => "")).replace(/\s+/g, " ").slice(0, 180);
        const home = loginOk || looksLikeAccountHome(url, body);
        const loginShot = await shot(page, home ? "login_ok" : "login_fail", email);
        await trace(mb, `登录 ${home ? "成功" : "失败"} url=${url.slice(0, 90)} shot=${loginShot}`);
        if (kind === "login") return {ok: !!home, login: !!home, url, shot: loginShot, body};
        if (!home) return {ok: false, login: false, url, shot: loginShot, error: "登录失败，不改 2FA", body};

        const oldTotp = String(mb.totp_secret || "");
        const changed = await change2faOnPage(page, {
            email: mb.email, password: mb.password, totpSecret: mb.totp_secret,
            recoveryEmail: mb.recovery_email || "",
            log: (m) => { console.log(`${email} ${m}`); db.appendMailboxLog(mb.id, String(m)).catch(() => {}); },
            onPersist: async (patch) => {
                const secret = typeof patch === "string" ? patch : patch?.totpSecret;
                if (!secret) {
                    await trace(mb, "换 2FA onPersist 没有 secret，不写库");
                    return;
                }
                await db.setMailboxTotp(mb.id, secret);
                await db.refreshMailboxGoogleState(mb.id, {totp: "ok", totp_rotated: true}).catch(() => {});
                await trace(mb, `新 TOTP 已验证并落库 旧=${oldTotp.slice(0, 8)} 新=${String(secret).slice(0, 8)}`);
            },
        }).catch((e) => ({ok: false, error: String(e?.message || e)}));
        const changeShot = await shot(page, changed?.ok ? "2fa_ok" : "2fa_fail", email);
        await trace(mb, `换2FA ${changed?.ok ? "成功" : "失败"} err=${changed?.error || ""} shot=${changeShot}`);
        if (!changed?.ok) {
            await trace(mb, "换 2FA 未验证成功，库内密钥不覆盖");
        }
        return {
            ok: !!changed?.ok,
            login: true,
            rotated: !!changed?.ok,
            totpSecret: changed?.totpSecret || "",
            error: changed?.error || "",
            shot: changeShot,
        };
    }).catch((e) => ({ok: false, error: String(e?.message || e)}));
    return {email, kind, ...result};
}

clearMailboxJobStop();
console.log("=== 抽检开始", stamp(), "out=", OUT, "===");
const swept = await sweepStaleBitWindows({includeClosed: true, log: (m) => console.log(m)});
console.log("清残留窗", swept);

const changeOnly = process.argv.includes("--change-only");
const loginResults = changeOnly ? [] : await Promise.all(LOGIN_EMAILS.map((e, i) => runOne("login", e, i)));
const changeResults = await Promise.all(CHANGE_EMAILS.map((e, i) => runOne("change", e, i + 2)));

const summary = {at: stamp(), login: loginResults, change: changeResults};
console.log("=== 抽检结果 ===");
console.log(JSON.stringify(summary, null, 2));
await pool.end();
const fail = [...loginResults, ...changeResults].some((r) => !r.ok);
process.exit(fail ? 1 : 0);
