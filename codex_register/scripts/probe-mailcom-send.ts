/**
 * 找一个 mail.com 号，按 CATS mailsubmission 协议发一封测试信。
 * 本机 3100 开着时走 /api/mailcom/send（代理池+跳板+记 sticky session）。
 *   npx tsx scripts/probe-mailcom-send.ts
 */
import pg from "pg";
import {sendMailcomSmtp} from "../src/mail/mailcom-smtp.ts";

const DATABASE_URL = process.env.DATABASE_URL || "postgresql://postgres:123456@192.168.1.126:5432/all_register";
const TO = process.env.MAILCOM_SEND_TO || "wangguodong194@163.com";
const FORCE_EMAIL = (process.env.MAILCOM_SEND_FROM || "").trim().toLowerCase();
const API = process.env.MAILCOM_SEND_API || "http://127.0.0.1:3100/api/mailcom/send";

async function pickAccounts(pool: pg.Pool) {
    if (FORCE_EMAIL) {
        const r = await pool.query(
            `SELECT email, password FROM mailboxes WHERE lower(email)=$1 LIMIT 1`,
            [FORCE_EMAIL],
        );
        if (!r.rows.length) throw new Error(`指定发件号不在 mailboxes: ${FORCE_EMAIL}`);
        return r.rows;
    }
    const delivered = await pool.query(`
        SELECT m.email, m.password
        FROM recharge_queue rq
        JOIN mailboxes m ON lower(m.email) = lower(rq.email)
        WHERE rq.delivery_status = 'delivered'
          AND rq.email ILIKE '%@mail.com'
          AND COALESCE(rq.rebind_from, '') = ''
          AND COALESCE(m.password, '') <> ''
        ORDER BY rq.id DESC
        LIMIT 3
    `);
    if (delivered.rows.length) return delivered.rows;
    const hold = await pool.query(`
        SELECT email, password
        FROM mailboxes
        WHERE email ILIKE '%@mail.com'
          AND COALESCE(password, '') <> ''
        ORDER BY id DESC
        LIMIT 3
    `);
    return hold.rows;
}

async function main() {
    const pool = new pg.Pool({connectionString: DATABASE_URL});
    let lastErr = "";
    try {
        const accounts = await pickAccounts(pool);
        if (!accounts.length) throw new Error("库里没有可用的 mail.com 号");
        console.log(`[probe] 收件人 ${TO} 候选 ${accounts.map((a) => a.email).join(", ")}`);
        const payload = (email: string) => ({
            email,
            to: TO,
            fromName: email.split("@")[0],
            subject: `协议发信测试 ${new Date().toISOString().slice(11, 19)}`,
            text: `mail.com protocol send test from ${email} at ${new Date().toISOString()}`,
            html: `<html><body><p>mail.com 协议发信测试</p><p>from ${email}</p><p>${new Date().toISOString()}</p></body></html>`,
        });
        for (const acc of accounts) {
            console.log(`[probe] 尝试发件 ${acc.email}`);
            try {
                const message = payload(acc.email);
                let r: any = null;
                try {
                    const resp = await fetch(API, {
                        method: "POST",
                        headers: {"content-type": "application/json"},
                        body: JSON.stringify(message),
                    });
                    const data = await resp.json().catch(() => ({}));
                    if (resp.ok && data?.ok) {
                        console.log("[probe] 走本机 API（代理池+跳板）", JSON.stringify(data));
                        return;
                    }
                    if (resp.status) {
                        console.warn(`[probe] API ${resp.status} ${String(data?.error || "").slice(0, 160)}，改本地直发`);
                    }
                } catch (apiErr: any) {
                    console.warn(`[probe] API 不可用 (${String(apiErr?.message || apiErr).slice(0, 80)})，改本地直发`);
                }
                r = await sendMailcomSmtp({
                    email: acc.email,
                    password: acc.password,
                    to: TO,
                    fromName: acc.email.split("@")[0],
                    subject: message.subject,
                    text: message.text,
                    html: message.html,
                    timeoutMs: Number(process.env.MAILCOM_SMTP_TIMEOUT_MS || 30_000),
                    proxy: process.env.MAILCOM_PROXY || "",
                    jump: process.env.MAILCOM_JUMP || "",
                });
                console.log("[probe] 成功", JSON.stringify(r));
                return;
            } catch (e: any) {
                lastErr = String(e?.message || e);
                console.warn(`[probe] ${acc.email} 失败: ${lastErr.slice(0, 240)}`);
            }
        }
        throw new Error(lastErr || "全部候选都没发出去");
    } finally {
        await pool.end();
    }
}

main().catch((e) => {
    console.error("[probe] fatal", e?.message || e);
    process.exit(1);
});
