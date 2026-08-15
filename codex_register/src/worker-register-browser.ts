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
        catch { cred = {email, password: process.env.REG_PASSWORD || "", totpSecret: "", recoveryEmail: "", imapPassword: ""}; }
        if (cred.imapPassword) rememberGoogleImapPassword(email, cred.imapPassword);
        if (!String(cred.imapPassword || "").trim()) {
            emit({type: "result", status: "failed", email, error: "Gmail 没有 IMAP 应用密码，不能注册 GPT"});
            process.exit(1); return;
        }
        emit({type: "progress", stage: "imap", message: "Gmail 已有 IMAP，跳过邮箱管理，走 IMAP 收码注册"});
    }

    const shouldRotate = (err) => /代理中断|ERR_PROXY|chrome-error|代理不通|多次打开 auth\/login 失败|Cloudflare|Unable to load site|出口被|原生表单|未进验证码|邮箱输入框未出现|验证码输入框未找到|换 IP|security verification/i.test(String(err || ""));

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
            const {pickLiveMailProxy, maskProxyUrl, getMailProxyJump, setMailProxyJump} = await import("./mail/proxy-pool.js");
            setMailProxyJump(process.env.MAIL_PROXY_JUMP || getMailProxyJump() || "");
            const jump = getMailProxyJump();
            emit({type: "progress", stage: "net", message: jump ? `[网络] 经跳板 ${jump} 测出口` : "[网络] 无跳板，直连测出口"});
            const picked = await pickLiveMailProxy(bitProxy, {tries: 3, log: (m) => emit({type: "progress", stage: "net", message: `[网络] ${m}`})});
            if (!picked.ok) throw new Error(`代理不通: ${picked.probe.reason || "未知"}`);
            bitProxy = picked.url;
            emit({type: "progress", stage: "net", message: `[网络] 通 ${maskProxyUrl(bitProxy)}`});
            if (jump) {
                const {wrapExitThroughJump, timezoneFromExitUrl} = await import("./mail/proxy-chain.js");
                const wrapped = await wrapExitThroughJump(bitProxy, jump);
                closeFn = wrapped.close;
                bitProxy = wrapped.url;
                timeZone = timezoneFromExitUrl(picked.url);
                emit({type: "progress", stage: "net", message: `[网络] 链式跳板 :${wrapped.localPort}`});
            }
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
    for (let attempt = 0; attempt < 3; attempt++) {
        let opened = {id: null, cdp: "", closeFn: () => {}, proxyUrl};
        try {
            if (attempt) {
                const {mintStickySession} = await import("./mail/proxy-pool.js");
                proxyUrl = mintStickySession(process.env.PROXY_URL || proxyUrl);
                const why = /Cloudflare|Unable to load|出口被/.test(String(r?.error || "")) ? "出口被拦" : "代理断了";
                emit({type: "progress", stage: "net", message: `${why}，换新 session 重开窗（${attempt + 1}/3）`});
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
        if (attempt < 2 && shouldRotate(r?.error)) continue;
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
        let mfaClose = () => {};
        try {
            const jump = process.env.MAIL_PROXY_JUMP || "";
            if (jump && mfaProxy) {
                const {wrapExitThroughJump} = await import("./mail/proxy-chain.js");
                const wrapped = await wrapExitThroughJump(mfaProxy, jump);
                mfaProxy = wrapped.url;
                mfaClose = wrapped.close;
            }
            let mfa = await enrollTotp(r.token, {accountId, proxyUrl: mfaProxy});
            if (!mfa.ok && /fetch failed|ECONN|timeout|UND_ERR/i.test(String(mfa.reason || ""))) {
                emit({type: "progress", stage: "mfa", message: "2FA 经代理失败，直连再试一次"});
                mfa = await enrollTotp(r.token, {accountId, proxyUrl: ""});
            }
            if (mfa.ok && mfa.secret) { totpSecret = mfa.secret; mfaStatus = "✅已绑"; emit({type: "progress", stage: "mfa", message: "TOTP 已绑定"}); }
            else if (mfa.ok && mfa.already) { mfaStatus = "⚠已有2FA缺密钥"; emit({type: "progress", stage: "mfa", message: "该号已有 2FA 但本次未拿到 secret"}); }
            else { mfaStatus = "❌" + (mfa.reason || "绑定失败"); emit({type: "progress", stage: "mfa", message: "TOTP 绑定失败: " + (mfa.reason || "")}); }
        } finally {
            try { mfaClose(); } catch { /* */ }
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
