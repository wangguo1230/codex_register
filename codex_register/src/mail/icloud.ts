// @ts-nocheck
// iCloud 邮箱 provider：通过 HTTP API 收件（无需浏览器登录），用于 GPT 注册 OTP 收码。
// 取件接口: GET https://assurivo.com/console/feed.php?mail={邮箱}&pwd={查询码}&limit=5
// 池文件格式: 邮箱----查询码（每行一个），读 ICLOUD_TOKENS_FILE 或 MAILCOM_TOKENS_FILE 环境变量
import path from "path";
import {readFileSync, existsSync} from "fs";
import {findLatestVerificationMail} from "./verification-matcher.js";

const FEED_URL = "https://assurivo.com/console/feed.php";
const POLL_ATTEMPTS = 16;
const POLL_INTERVAL_MS = 15000;

const POOL_FILE = process.env.ICLOUD_TOKENS_FILE
    || process.env.MAILCOM_TOKENS_FILE
    || path.resolve(process.cwd(), "icloud", "tokens.txt");

const passwordByEmail = new Map();
let pool = null;
let poolCursor = 0;

function normalizeEmail(value) {
    return String(value ?? "").trim().toLowerCase();
}

function loadPool() {
    if (pool) return pool;
    if (!existsSync(POOL_FILE)) throw new Error(`未找到 iCloud 邮箱池文件: ${POOL_FILE}`);
    pool = readFileSync(POOL_FILE, "utf8")
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => {
            const [email, password] = line.split("----");
            return {email: normalizeEmail(email), password: String(password ?? "").trim()};
        })
        .filter((item) => item.email && item.password);
    if (!pool.length) throw new Error(`iCloud 邮箱池为空: ${POOL_FILE}`);
    for (const item of pool) passwordByEmail.set(item.email, item.password);
    return pool;
}

function resolvePassword(email) {
    const key = normalizeEmail(email);
    if (passwordByEmail.has(key)) return passwordByEmail.get(key);
    loadPool();
    if (passwordByEmail.has(key)) return passwordByEmail.get(key);
    throw new Error(`iCloud 邮箱池中找不到查询码: ${email}`);
}

function htmlToText(s) {
    return String(s ?? "")
        .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
        .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
        .replace(/<[^>]+>/g, " ")
        .replace(/&nbsp;/gi, " ")
        .replace(/&#(\d+);/g, (_, cp) => String.fromCharCode(Number(cp)))
        .replace(/&amp;/gi, "&").replace(/&lt;/gi, "<").replace(/&gt;/gi, ">")
        .replace(/\s+/g, " ").trim();
}

function isOpenAIMail(m) {
    const from = String(m.from || m.sender || "").toLowerCase();
    const subject = String(m.subject || "").toLowerCase();
    return /openai|chatgpt|noreply.*openai/i.test(from) || /openai|chatgpt|验证码|verification|login code/i.test(subject);
}

async function fetchInbox(email, limit = 5) {
    const pwd = resolvePassword(email);
    const url = `${FEED_URL}?mail=${encodeURIComponent(email)}&pwd=${encodeURIComponent(pwd)}&limit=${limit}`;
    for (let retry = 0; retry < 3; retry++) {
        const res = await fetch(url, {headers: {"accept": "application/json"}});
        const text = await res.text();
        let json;
        try { json = JSON.parse(text); } catch { throw new Error(`iCloud API 返回非 JSON: ${text.slice(0, 200)}`); }
        if (json.status === "success") return Array.isArray(json.data) ? json.data : [];
        if (/too many|rate/i.test(json.message || "")) {
            console.warn(`[icloud] 限流,等待 ${10 + retry * 10}s 后重试(${retry + 1}/3)…`);
            await new Promise(r => setTimeout(r, (10 + retry * 10) * 1000));
            continue;
        }
        throw new Error(`iCloud API 失败: ${JSON.stringify(json).slice(0, 200)}`);
    }
    throw new Error(`iCloud API 限流重试耗尽: ${email}`);
}

export function createIcloudProvider() {
    return {
        async getEmailAddress() {
            const accounts = loadPool();
            const account = accounts[poolCursor % accounts.length];
            poolCursor += 1;
            passwordByEmail.set(account.email, account.password);
            return account.email;
        },
        async getEmailVerificationCode(email, options) {
            const excludeCode = options?.excludeCode || "";
            const minTs = options?.minTimestampMs || (Date.now() - 60000); // 提交验证码请求的时间,只接受之后到达的邮件

            for (let attempt = 1; attempt <= POLL_ATTEMPTS; attempt += 1) {
                console.log(`[icloud] pollOtp attempt=${attempt}/${POLL_ATTEMPTS} email=${email}`);
                try {
                    const mails = await fetchInbox(email, 5);
                    if (mails.length) {
                        const candidates = mails
                            .filter(isOpenAIMail)
                            .filter((m) => {
                                if (!m.saved_at) return true;
                                const ts = new Date(m.saved_at).getTime();
                                return ts >= minTs - 30000; // 允许 30 秒时钟偏差
                            })
                            .map((m) => ({
                                content: htmlToText(m.body || ""),
                                subject: m.subject || "",
                                sender: m.from || "",
                                recipient: m.to || email,
                                timestamp: m.saved_at ? new Date(m.saved_at).getTime() : 0,
                                extraTexts: [m.subject || ""],
                            }));

                        const found = findLatestVerificationMail(candidates, {targetEmail: email});
                        if (found?.verificationCode) {
                            if (excludeCode && found.verificationCode === excludeCode) {
                                console.log(`[icloud] pollOtp attempt=${attempt}: 仍是旧码 ${found.verificationCode}，等新邮件…`);
                            } else {
                                console.log(`[icloud] OTP=${found.verificationCode} subject="${(found.subject || "").slice(0, 60)}"`);
                                return found.verificationCode;
                            }
                        }
                    }
                } catch (err) {
                    console.warn(`[icloud] pollOtp attempt=${attempt} 失败: ${err?.message ?? err}`);
                }
                if (attempt < POLL_ATTEMPTS) {
                    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
                }
            }
            throw new Error(`iCloud 未找到验证码: ${email}`);
        },
    };
}
