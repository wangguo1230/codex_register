// @ts-nocheck
/**
 * 浏览器引擎注册 worker —— 由调度器在"注册引擎=浏览器"时 spawn，一个子进程注册一个邮箱。
 * 用真 Chrome(registerViaBrowser)过 CF 完成 chatgpt.com/auth/login 注册,产出网页 auth 文件(与 HTTP 引擎一致)。
 *
 * env: REG_EMAIL / MAILCOM_TOKENS_FILE(收码登录) / MAILCOM_HEADLESS / PROXY_URL(过CF代理) / REG_SIMULATE_CHAT
 * stdout: 普通行=日志; @@EVENT@@{json}=进度/结果(同 worker-register，调度器统一处理)
 */
import {registerViaBrowser} from "./register-browser.js";
import {createBitWindow, openBitWindow, closeBitWindow, deleteBitWindow, bitHealth, sweepClosedGptWindows} from "./bitbrowser.js";
import {buildAuthRecord} from "./email-reg/auth-record.js";
import {getMailboxCredential} from "./mailbox.js";
import {
    unbindGoogleLivePage, rememberGoogleImapPassword, resolveGoogleCred,
} from "./mail/google-account.js";
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
    emit({type: "progress", stage: "start", email, message: isGoogle ? `开始处理 ${email}（Gmail 走 IMAP 收码注册 GPT）` : `开始浏览器注册 ${email}`});

    // 养号:注册完在同一浏览器页直接发一条消息(REG_SIMULATE_CHAT=1)，免重开浏览器
    const chatMessage = process.env.REG_SIMULATE_CHAT === "1" ? CHAT_MESSAGES[Math.floor(Math.random() * CHAT_MESSAGES.length)] : "";
    // Gmail 老号强制比特窗口：先登 Google，再在同一指纹里注册 GPT
    const useBit = process.env.BITBROWSER === "1" || isGoogle;
    let bitId = null, cdpEndpoint = "";
    let cred = null;
    if (isGoogle) {
        try { cred = resolveGoogleCred(email); }
        catch (e) {
            emit({type: "result", status: "failed", email, error: `Gmail 凭证池找不到，不能 IMAP 注册: ${String(e?.message || e).slice(0, 100)}`});
            process.exit(1); return;
        }
        if (cred.imapPassword) rememberGoogleImapPassword(email, cred.imapPassword);
        if (!String(cred.imapPassword || "").trim()) {
            emit({type: "result", status: "failed", email, error: "Gmail 没有 IMAP 应用密码，不能注册 GPT（必须 IMAP 收码）"});
            process.exit(1); return;
        }
        emit({type: "progress", stage: "imap", message: "Gmail 强制 IMAP 收码注册（无网页收件箱兜底）"});
    }

    const shouldRotate = async (err) => {
        const {isProxySessionDead} = await import("./mail/proxy-pool.js");
        return isProxySessionDead(err)
            || /多次打开 auth\/login 失败|原生表单|未进验证码|邮箱输入框未出现|验证码输入框未找到|换 IP|security verification|未拿到 token|IMAP 未拿到|auth\/error|Oops|ConnectionRefused|跳板连不上|代理不通|Unable to load site/i.test(String(err || ""));
    };

    async function teardownBit(id, closeFn) {
        unbindGoogleLivePage();
        if (id) {
            await closeBitWindow(id).catch(() => {});
            await deleteBitWindow(id).catch(() => {});
            emit({type: "progress", stage: "bit", message: "已关闭并删除比特窗口(释放额度)"});
        }
        try { closeFn(); } catch { /* */ }
    }

    async function openBitOnProxy(rawProxy) {
        let closeFn = () => {};
        let id = null;
        let cdp = "";
        if (!useBit) return {id, cdp, closeFn, proxyUrl: rawProxy};
        if (!await bitHealth()) throw new Error("比特浏览器未启动(127.0.0.1:54345)，请先打开「比特浏览器」");
        try {
            const n = await sweepClosedGptWindows({log: (m) => emit({type: "progress", stage: "bit", message: m})});
            if (n) emit({type: "progress", stage: "bit", message: `已清 ${n} 个关着的 GPT 残留窗`});
        } catch { /* 清残留失败不挡开窗 */ }
        emit({type: "progress", stage: "bit", message: "创建比特浏览器窗口(独立指纹)…"});
        let bitProxy = rawProxy || "";
        let timeZone = "";
        if (bitProxy) {
            let hasAuth = false;
            try {
                const u = new URL(bitProxy.includes("://") ? bitProxy.split("#")[0] : `socks5://${bitProxy}`);
                hasAuth = !!(u.username || u.password);
            } catch { /* */ }
            if (hasAuth) throw new Error("浏览器必须走 xray（本机无账密 socks），不能把 kookeey 账密交给比特/Chrome");
            emit({type: "progress", stage: "net", message: `[网络] 浏览器走 xray ${bitProxy}`});
        }
        id = await createBitWindow({
            proxy: bitProxy,
            name: isGoogle ? `gpt-${email.split("@")[0].slice(0, 12)}` : "reg",
            remark: isGoogle ? "gmail-gpt-imap" : "codex-reg",
            timeZone,
        });
        const {ws} = await openBitWindow(id, {extractIp: !timeZone});
        cdp = ws;
        emit({type: "progress", stage: "bit", message: `比特窗口已打开(${String(id).slice(0, 8)}…)`});
        return {id, cdp, closeFn, proxyUrl: bitProxy};
    }

    let r;
    let proxyUrl = process.env.PROXY_URL || "";
    for (let attempt = 0; attempt < 4; attempt++) {
        let opened = {id: null, cdp: "", closeFn: () => {}, proxyUrl};
        try {
            if (attempt) {
                const why = /Cloudflare|Unable to load|出口被/.test(String(r?.error || "")) ? "出口被拦" : "代理断了";
                emit({type: "progress", stage: "net", message: `${why}，同一 xray 重开窗（${attempt + 1}/4）`});
            }
            opened = await openBitOnProxy(proxyUrl);
            bitId = opened.id;
            cdpEndpoint = opened.cdp;
            if (isGoogle) emit({type: "progress", stage: "gpt", message: "【注册GPT】打开 ChatGPT 登录/注册"});
            r = await registerViaBrowser(email, {
                password,
                totpSecret: totpSecretEnv,
                proxyUrl: process.env.PROXY_URL || "",
                headless: process.env.CHAT_HEADLESS === "1",
                chatMessage,
                cdpEndpoint,
                preferGoogleSso: false,
                log: (m) => emit({type: "progress", stage: "browser", message: m}),
            });
        } catch (e) {
            r = {ok: false, error: String(e?.message ?? e)};
        } finally {
            await teardownBit(opened.id, opened.closeFn);
            bitId = null;
        }
        if (r?.ok && r.token) break;
        if (attempt < 3 && await shouldRotate(r?.error || "")) continue;
        emit({type: "result", status: "failed", email, error: r?.error || "浏览器注册未拿到 token"});
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
        let mfaProxy = process.env.PROXY_URL || "";
        try {
            const mfaCookie = cookieString(r.cookies) || record.cookie || "";
            const mfa = await enrollTotp(r.token, {
                accountId,
                proxyUrl: mfaProxy,
                cookie: mfaCookie,
                retryAltProxy: true,
                browserFallback: process.env.MFA_NO_BROWSER !== "1",
                headless: process.env.CHAT_HEADLESS === "1" || process.env.MAILCOM_HEADLESS === "1",
                log: (m) => emit({type: "progress", stage: "mfa", message: m}),
            });
            if (mfa.ok && mfa.secret) {
                totpSecret = mfa.secret;
                mfaStatus = "✅已绑";
                emit({type: "progress", stage: "mfa", message: `TOTP 已绑定(${mfa.via || "http"})`});
            } else if (mfa.ok && mfa.already) {
                mfaStatus = "⚠已有2FA缺密钥";
                emit({type: "progress", stage: "mfa", message: "该号已有 2FA 但本次未拿到 secret"});
            } else {
                mfaStatus = "❌" + (mfa.reason || "绑定失败");
                emit({type: "progress", stage: "mfa", message: "TOTP 未绑(不影响注册): " + (mfa.reason || "")});
            }
        } catch (e: any) {
            mfaStatus = "❌" + String(e?.message || e).slice(0, 80);
            emit({type: "progress", stage: "mfa", message: "TOTP 未绑(不影响注册): " + mfaStatus});
        }
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
