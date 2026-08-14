// @ts-nocheck
/**
 * 浏览器引擎注册 worker —— 由调度器在"注册引擎=浏览器"时 spawn，一个子进程注册一个邮箱。
 * 用真 Chrome(registerViaBrowser)过 CF 完成 chatgpt.com/auth/login 注册,产出网页 auth 文件(与 HTTP 引擎一致)。
 *
 * env: REG_EMAIL / MAILCOM_TOKENS_FILE(收码登录) / MAILCOM_HEADLESS / PROXY_URL(过CF代理) / REG_SIMULATE_CHAT
 * stdout: 普通行=日志; @@EVENT@@{json}=进度/结果(同 worker-register，调度器统一处理)
 */
import {registerViaBrowser} from "./register-browser.js";
import {createBitWindow, openBitWindow, closeBitWindow, deleteBitWindow, bitHealth} from "./bitbrowser.js";
import {buildAuthRecord} from "./email-reg/auth-record.js";
import {getMailboxCredential} from "./mailbox.js";
import {chromium} from "playwright-core";
import {ensureGoogleLoggedIn} from "./mail/google-auth.js";
import {
    bindGoogleLivePage, unbindGoogleLivePage, rememberGoogleImapPassword, resolveGoogleCred,
} from "./mail/google-account.js";
import {enableGmailFetch} from "./mail/google-imap.js";
import {hardenGoogleAccountOnPage} from "./mail/google-secure.js";
import {appConfig} from "./config.js";
import {OpenAIClient} from "./openai.js";
import {generateRandomDeviceProfile} from "./device-profile.js";
import {createPoolBroker} from "./sms/pool-broker.js";
import {enrollTotp} from "./mfa.js";
import {decodeJwt} from "./token-check.js";
import {writeFile, mkdir} from "node:fs/promises";
import path from "node:path";

const EVENT_PREFIX = "@@EVENT@@";
const email = (process.env.REG_EMAIL || "").trim();
const password = (process.env.GPT_PASSWORD || "").trim() || appConfig.defaultPassword.trim();
const totpSecretEnv = (process.env.TOTP_SECRET || "").trim();
const CHAT_MESSAGES = ["hello, how are you?", "what can you do?", "tell me a fun fact", "hi there!", "give me a quick productivity tip", "recommend a good book", "explain black holes simply", "what's a healthy breakfast idea?"];
function emit(ev) { process.stdout.write(EVENT_PREFIX + JSON.stringify(ev) + "\n"); }

function buildAuthFileName(email) {
    const safe = email.replace(/[^a-zA-Z0-9._-]/g, "_");
    const d = new Date().toISOString().slice(0, 10);
    return `${d}-${safe}.json`;
}
function cookieString(cookies) {
    return (cookies || [])
        .filter((c) => /chatgpt\.com|openai\.com/.test(c.domain || "") && c.value)
        .map((c) => `${c.name}=${c.value}`).join("; ");
}
function planFromToken(token) {
    try {
        const p = JSON.parse(Buffer.from(token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"));
        return p?.["https://api.openai.com/auth"]?.chatgpt_plan_type ?? "";
    } catch { return ""; }
}

async function main() {
    if (!email) { emit({type: "result", status: "failed", email: "", error: "缺少 REG_EMAIL"}); process.exit(1); return; }
    const isGoogle = process.env.MAIL_PROVIDER === "google" || /@(gmail|googlemail)\.com$/i.test(email);
    emit({type: "progress", stage: "start", email, message: isGoogle ? `开始处理 ${email}（先邮箱管理，再注册 GPT）` : `开始浏览器注册 ${email}`});

    // 养号:注册完在同一浏览器页直接发一条消息(REG_SIMULATE_CHAT=1)，免重开浏览器
    const chatMessage = process.env.REG_SIMULATE_CHAT === "1" ? CHAT_MESSAGES[Math.floor(Math.random() * CHAT_MESSAGES.length)] : "";
    // Gmail 老号强制比特窗口：先登 Google，再在同一指纹里注册 GPT
    const useBit = process.env.BITBROWSER === "1" || isGoogle;
    let bitId = null, cdpEndpoint = "";
    if (useBit) {
        try {
            if (!await bitHealth()) throw new Error("比特浏览器未启动(127.0.0.1:54345)，请先打开「比特浏览器」");
            emit({type: "progress", stage: "bit", message: "创建比特浏览器窗口(独立指纹)…"});
            bitId = await createBitWindow({
                proxy: process.env.PROXY_URL || "",
                name: isGoogle ? `gmail-${email.split("@")[0].slice(0, 12)}` : "reg",
                remark: isGoogle ? "gmail-gpt" : "codex-reg",
            });
            const {ws} = await openBitWindow(bitId);
            cdpEndpoint = ws;
            emit({type: "progress", stage: "bit", message: `比特窗口已打开(${String(bitId).slice(0, 8)}…)`});
        } catch (e) {
            emit({type: "result", status: "failed", email, error: "比特窗口创建/打开失败: " + (e?.message ?? e)});
            if (bitId) await deleteBitWindow(bitId);
            process.exit(1); return;
        }
    }

    if (isGoogle && cdpEndpoint) {
        let prepBrowser;
        try {
            prepBrowser = await chromium.connectOverCDP(cdpEndpoint);
            const ctx = prepBrowser.contexts()[0] || await prepBrowser.newContext();
            const page = ctx.pages()[0] || await ctx.newPage();
            page.setDefaultTimeout(30000);
            page.on("dialog", (d) => { d.accept().catch(() => {}); });
            bindGoogleLivePage(page);
            let cred;
            try { cred = resolveGoogleCred(email); }
            catch { cred = {email, password: process.env.REG_PASSWORD || "", totpSecret: "", recoveryEmail: ""}; }
            if (cred.imapPassword) rememberGoogleImapPassword(email, cred.imapPassword);
            const doManage = process.env.REG_GOOGLE_HARDEN !== "0"
                || process.env.REG_GOOGLE_CHANGE_PW === "1"
                || process.env.REG_GOOGLE_CHANGE_2FA === "1"
                || process.env.REG_GOOGLE_PREP === "1";
            emit({type: "progress", stage: "manage", message: "【邮箱管理】登录 Gmail…"});
            const loggedIn = await ensureGoogleLoggedIn(
                page, "https://myaccount.google.com/?hl=en",
                {
                    email: cred.email || email,
                    password: cred.password,
                    totpSecret: cred.totpSecret,
                    recoveryEmail: cred.recoveryEmail,
                },
                (m) => emit({type: "progress", stage: "manage", message: m}),
            );
            if (!loggedIn) throw new Error("【邮箱管理】Gmail 登录失败，未进入注册 GPT");

            if (doManage) {
                emit({type: "progress", stage: "manage", message: "【邮箱管理】换2FA → 改密 → 踢设备 → 删辅助邮箱 → 开 IMAP"});
                const h = await hardenGoogleAccountOnPage(page, cred, (m) => emit({type: "progress", stage: "manage", message: m}));
                if (h.password) cred.password = h.password;
                if (h.totpSecret) cred.totpSecret = h.totpSecret;
                if (h.imapPassword) rememberGoogleImapPassword(email, h.imapPassword);
                emit({
                    type: "mailbox_update", email,
                    password: h.password, totp_secret: h.totpSecret,
                    imap_password: h.imapPassword || undefined,
                    recovery_email: h.recoveryCleared ? "" : undefined,
                    manage_ok: !!h.ok,
                    manage_missing: h.missing || [],
                });
                if (!h.ok || !h.imapPassword) {
                    const miss = (h.missing || []).join("/") || (h.errors || []).join("; ");
                    throw new Error(`【邮箱管理】未完成(${miss || "未知"})，不注册 GPT`);
                }
                emit({type: "progress", stage: "manage", message: "【邮箱管理】完成，开始注册 GPT"});
            }
        } catch (e) {
            emit({type: "result", status: "failed", email, error: String(e?.message ?? e)});
            unbindGoogleLivePage();
            if (bitId) { await closeBitWindow(bitId); await deleteBitWindow(bitId); }
            process.exit(1); return;
        }
    }

    let r;
    try {
        if (isGoogle) emit({type: "progress", stage: "gpt", message: "【注册GPT】打开 ChatGPT 登录/注册"});
        r = await registerViaBrowser(email, {
            password,
            totpSecret: totpSecretEnv,
            proxyUrl: process.env.PROXY_URL || "",
            headless: process.env.CHAT_HEADLESS === "1", // 默认 headed(过 CF);无头服务器需 xvfb
            chatMessage,
            cdpEndpoint, // 有=连接比特窗口;无=launch 临时 Chrome
            preferGoogleSso: isGoogle && process.env.REG_GOOGLE_SSO !== "0",
            log: (m) => emit({type: "progress", stage: "browser", message: m}),
        });
    } finally {
        unbindGoogleLivePage();
        if (bitId) { await closeBitWindow(bitId); await deleteBitWindow(bitId); emit({type: "progress", stage: "bit", message: "已关闭并删除比特窗口(释放额度)"}); }
    }
    if (!r.ok || !r.token) {
        emit({type: "result", status: "failed", email, error: r.error || "浏览器注册未拿到 token"});
        process.exit(1); return;
    }

    // 存网页 auth 文件(auth/at/<date>-<email>.json)，格式与 HTTP 引擎一致
    let mailbox = null;
    try { mailbox = await getMailboxCredential(email); } catch { /* 取不到忽略 */ }
    const record = buildAuthRecord({accessToken: r.token, email, session: r.session, mailbox, cookie: cookieString(r.cookies)});
    const atDir = path.resolve(process.cwd(), "auth", "at");
    await mkdir(atDir, {recursive: true});
    const authFile = path.join(atDir, buildAuthFileName(email));
    await writeFile(authFile, JSON.stringify(record) + "\n", "utf8");
    emit({type: "progress", stage: "registered", email, message: `注册完成，auth 文件: ${authFile}`});

    let totpSecret = "";
    let mfaStatus = "";
    if (process.env.REG_TRY_MFA === "1") {
        emit({type: "progress", stage: "mfa", message: "注册后绑定 TOTP…"});
        const accountId = decodeJwt(r.token)?.["https://api.openai.com/auth"]?.chatgpt_account_id || "";
        const mfa = await enrollTotp(r.token, {accountId, proxyUrl: process.env.PROXY_URL || ""});
        if (mfa.ok && mfa.secret) { totpSecret = mfa.secret; mfaStatus = "✅已绑"; emit({type: "progress", stage: "mfa", message: "TOTP 已绑定"}); }
        else if (mfa.ok && mfa.already) { mfaStatus = "⚠已有2FA缺密钥"; emit({type: "progress", stage: "mfa", message: "该号已有 2FA 但本次未拿到 secret"}); }
        else { mfaStatus = "❌" + (mfa.reason || "绑定失败"); emit({type: "progress", stage: "mfa", message: "TOTP 绑定失败: " + (mfa.reason || "")}); }
    }

    // [注册后取 rt] 同 HTTP 引擎:REG_TRY_RT=1 → 新建干净 client 走 codex OAuth(authLoginHTTP,HTTP,不碰浏览器)拿可续期 rt。
    // 复用邮箱OTP(mailcom)+add-phone(接码)。失败仅记录、不影响已拿到的网页 token。
    let rtFile = "";
    if (process.env.REG_TRY_RT === "1") {
        try {
            const smsBroker = createPoolBroker({
                email,
                linkTemplate: process.env.SMS_LINK_TEMPLATE || "",
                maxBind: Number(process.env.SMS_MAX_BIND || 0),
                log: (m) => emit({type: "progress", stage: "rt", message: m}),
            });
            emit({type: "progress", stage: "rt", message: "走 codex OAuth 获取 refresh_token(邮箱OTP + add-phone 接码) ..."});
            const rtClient = new OpenAIClient({email, password, totpSecret, deviceProfile: generateRandomDeviceProfile(), manualMode: false, smsBroker});
            const rtResult = await rtClient.authLoginHTTP();
            rtFile = rtResult.authFile || "";
            const rt = (rtClient as any).lastSavedAuthRecord?.refresh_token || "";
            emit({type: "progress", stage: "rt", message: rt
                ? `✅ 拿到 refresh_token(可续期): ${rt.slice(0, 28)}...  codex文件: ${rtFile}`
                : "authLoginHTTP 完成但未解析到 refresh_token"});
        } catch (e: any) {
            emit({type: "progress", stage: "rt", message: `refresh_token 获取失败(可能需手机验证/接码不足): ${String(e?.message ?? e).slice(0, 150)}`});
        }
    }

    emit({type: "result", status: "success", email, password, gptPassword: password, totpSecret, mfaStatus, token: r.token, authFile, rtFile, plan: planFromToken(r.token)});
}

main().then(() => process.exit(0)).catch((e) => {
    emit({type: "result", status: "failed", email, error: String(e?.message ?? e)});
    process.exit(1);
});
