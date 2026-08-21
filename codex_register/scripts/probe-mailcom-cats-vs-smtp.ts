/**
 * 对比同一账号：SMTP AUTH vs CATS mailsubmission 发信。
 * 用 tsup 打成独立 mjs 后用 node 跑，避免 tsx 写缓存把内存打爆。
 *
 *   npx tsup scripts/probe-mailcom-cats-vs-smtp.ts --format esm --platform node --target node20 --out-dir /tmp --out-extension .mjs=mjs
 *   NODE_DISABLE_COMPILE_CACHE=1 node /tmp/probe-mailcom-cats-vs-smtp.mjs
 */
import pg from "pg";
import {sendMailcomSmtp} from "../src/mail/mailcom-smtp.ts";
import {sendMailcomMail} from "../src/mail/mailcom.ts";

const DATABASE_URL = process.env.DATABASE_URL || "postgresql://postgres:123456@192.168.1.126:5432/all_register";
const EMAIL = (process.env.MAILCOM_SEND_FROM || "juanita_cupiditatewgu@mail.com").trim().toLowerCase();
const TO = process.env.MAILCOM_SEND_TO || "wangguodong194@163.com";
const JUMP = Object.prototype.hasOwnProperty.call(process.env, "MAILCOM_JUMP")
    ? String(process.env.MAILCOM_JUMP || "").trim()
    : "socks5://127.0.0.1:10812";
const SKIP_CATS = /^(1|true|yes)$/i.test(String(process.env.SKIP_CATS || ""));
const SKIP_SMTP = /^(1|true|yes)$/i.test(String(process.env.SKIP_SMTP || ""));

function stamp() {
    return new Date().toISOString().slice(11, 19);
}

async function loadMailbox() {
    const pool = new pg.Pool({connectionString: DATABASE_URL});
    try {
        const r = await pool.query(
            `SELECT id, email, password, proxy_url, browser_fp
             FROM mailboxes WHERE lower(email)=$1 LIMIT 1`,
            [EMAIL],
        );
        if (!r.rows.length) throw new Error(`mailboxes 无此号: ${EMAIL}`);
        return r.rows[0];
    } finally {
        await pool.end();
    }
}

async function testSmtp(mb: any) {
    const subject = `SMTP probe ${stamp()}`;
    console.log(`[smtp] begin ${mb.email} -> ${TO} proxy=${mb.proxy_url ? "yes" : "no"} jump=${JUMP ? "yes" : "no"}`);
    const started = Date.now();
    try {
        const r = await sendMailcomSmtp({
            email: mb.email,
            password: mb.password,
            to: TO,
            fromName: String(mb.email).split("@")[0],
            subject,
            text: `smtp probe ${new Date().toISOString()}`,
            html: `<html><body><p>smtp probe</p></body></html>`,
            proxy: mb.proxy_url || "",
            jump: JUMP,
            timeoutMs: Number(process.env.MAILCOM_SMTP_TIMEOUT_MS || 30_000),
        });
        console.log(`[smtp] OK ${Date.now() - started}ms`, JSON.stringify({status: r.status}));
        return {ok: true, ms: Date.now() - started, status: r.status};
    } catch (e: any) {
        const error = String(e?.message || e).slice(0, 300);
        console.log(`[smtp] FAIL ${Date.now() - started}ms`, error);
        return {ok: false, ms: Date.now() - started, error};
    }
}

async function testCats(mb: any) {
    const subject = `CATS probe ${stamp()}`;
    console.log(`[cats] begin ${mb.email} -> ${TO} proxy=${mb.proxy_url ? "yes" : "no"} jump=${JUMP ? "yes" : "no"}`);
    const started = Date.now();
    try {
        const r = await sendMailcomMail(mb.email, mb.password, {
            to: TO,
            fromName: String(mb.email).split("@")[0],
            subject,
            text: `cats mailsubmission probe ${new Date().toISOString()}`,
            html: `<html><body><p>cats mailsubmission probe</p></body></html>`,
            headless: true,
            proxy: mb.proxy_url || "",
            jump: JUMP,
            profile: mb.browser_fp || undefined,
        });
        console.log(`[cats] OK ${Date.now() - started}ms`, JSON.stringify({status: r.status, location: r.location || ""}));
        return {ok: true, ms: Date.now() - started, status: r.status, location: r.location || ""};
    } catch (e: any) {
        const error = String(e?.message || e).slice(0, 400);
        console.log(`[cats] FAIL ${Date.now() - started}ms`, error);
        return {ok: false, ms: Date.now() - started, error};
    }
}

async function main() {
    const mb = await loadMailbox();
    console.log(JSON.stringify({
        id: mb.id,
        email: mb.email,
        hasPassword: !!mb.password,
        pwLen: String(mb.password || "").length,
        hasProxy: !!mb.proxy_url,
        skipCats: SKIP_CATS,
        skipSmtp: SKIP_SMTP,
        to: TO,
    }));
    const out: any = {email: mb.email, to: TO};
    if (!SKIP_SMTP) out.smtp = await testSmtp(mb);
    if (!SKIP_CATS) out.cats = await testCats(mb);
    console.log("@@RESULT@@" + JSON.stringify(out));
    if ((out.smtp && !out.smtp.ok) && (out.cats && !out.cats.ok)) process.exitCode = 2;
    else if (out.smtp && !out.smtp.ok && out.cats?.ok) process.exitCode = 0;
    else if (out.smtp?.ok || out.cats?.ok) process.exitCode = 0;
    else process.exitCode = 1;
}

main().catch((e) => {
    console.error("[fatal]", e?.message || e);
    process.exit(1);
});
