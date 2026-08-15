// @ts-nocheck
// 后端服务：REST(导入/控制/下载) + SSE(实时日志/状态/统计) + 静态托管前端
import express from "express";

function isImapTlsCrash(err) {
    const s = `${err?.code || ""} ${err?.reason || ""} ${err?.message || ""} ${err?.stack || ""}`;
    return /ERR_SSL_DECRYPTION_FAILED_OR_BAD_RECORD_MAC|bad record mac|tls_get_more_records|ImapFlow/i.test(s)
        && /SSL|TLS|imap/i.test(s);
}
process.on("uncaughtException", (err) => {
    if (isImapTlsCrash(err)) {
        console.warn("[imap] TLS 记录损坏，已忽略（不退出进程）:", err?.message || err);
        return;
    }
    console.error(err);
    process.exit(1);
});
import cors from "cors";
import {existsSync, readFileSync, writeFileSync, unlinkSync, mkdtempSync, rmSync} from "node:fs";
import os from "node:os";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {spawn} from "node:child_process";
import * as db from "./db.js";
import { initDb } from "./pg.js";
import { ensureSchema } from "./pg-schema.js";
import {scheduler} from "./scheduler.js";
import {appConfig} from "../src/config.js";
// 邮箱能力统一走邮箱域服务(不再直接依赖具体 provider 文件),满足 DIP
import {fetchInboxList, fetchMailBodyFor, setMailProxy, changeMailcomPassword, verifyMailcomLogin, scanClaudeDisabledMail} from "./domain/mailbox-service.js";
import {changePasswordOnPage, change2faOnPage} from "../src/mail/google-manage.js";
import {runGoogleHardenWithBit, withGoogleBitSession} from "../src/mail/google-secure.js";
import {mailProxyPool, gptProxyPool, mailJumpPool, gptJumpPool, maskProxyUrl, toProxyImportLine, kookeeySessionOf, probeMailProxy, JUMP_MAX_EXITS} from "../src/mail/proxy-pool.js";
import {randomPassword} from "../src/utils.js";
import {straightenImportRow, looksLikeEmail} from "../src/mfa.js";
import {openBrowserWithAuth} from "../src/simulate-chat.js";
import {bitHealth, closeTrackedBitWindows, listAutomationBitWindows, stopAutomationBitWindows} from "../src/bitbrowser.js";
import {clearMailboxJobStop, isMailboxJobStopped, requestMailboxJobStop} from "../src/mail/mailbox-job-stop.js";
import {peekSms, buildSmsLink, classifySms} from "../src/sms-broker.js";
import {probeAt, probePlan, refreshRt, buildProxyDispatcher, decodeJwt} from "../src/token-check.js";
import {enrollTotp} from "../src/mfa.js";
import {changeChatgptEmail, needsPwdReauth} from "../src/change-email.js";
import {testGmailImap} from "../src/mail/google-imap.js";
import {rememberGoogleCred} from "../src/mail/google-account.js";
import {rememberMailcomPassword} from "../src/mail/mailcom.js";
import {startXray, stopXray, xrayStatus, listJumpXrays, isVlessUrl, stopJumpFleet} from "./xray-proxy.js";
import {queryClaudeInfo, claudeChat} from "../src/claude-api.js";
import {execSync} from "node:child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// 凭证读取辅助：DB JSONB 列优先，回退文件读取
function readJsonFileSafe(p) { try { return p ? JSON.parse(readFileSync(p, "utf8")) : null; } catch { return null; } }
function getAuthData(acc) { return acc?.auth_data || readJsonFileSafe(acc?.auth_file); }
function getRtData(acc) { return acc?.rt_data || readJsonFileSafe(acc?.rt_file); }
// 邮箱池单行: email----邮箱密码----邮箱2FA----辅助邮箱----IMAP应用专用密码
function writeMailboxTokenFile(file, rec) {
    writeFileSync(file, [
        rec?.email || "",
        rec?.password || "",
        rec?.mailboxTotp || rec?.mailbox_totp || rec?.totp_secret || "",
        rec?.recoveryEmail || rec?.recovery_email || "",
        rec?.imapPassword || rec?.mailbox_imap || rec?.imap_password || "",
    ].join("----") + "\n", "utf8");
}
const PORT = Number(process.env.PORT || 3100);
const WEB_DIST = path.resolve(__dirname, "..", "web", "dist");
let httpReady = false;

function killSiblingIndexProcesses() {
    const me = process.pid;
    try {
        if (process.platform === "win32") {
            const out = execSync(
                "wmic process where \"name='node.exe'\" get ProcessId,CommandLine /FORMAT:LIST",
                {encoding: "utf8", windowsHide: true},
            );
            const blocks = out.split(/\r?\n\r?\n/);
            for (const b of blocks) {
                const cmd = (b.match(/CommandLine=(.*)/) || [])[1] || "";
                const pid = Number((b.match(/ProcessId=(\d+)/) || [])[1] || 0);
                if (!pid || pid === me) continue;
                if (!/server[/\\]index\.ts|tsx server/i.test(cmd)) continue;
                try { execSync(`taskkill /F /PID ${pid}`, {stdio: "ignore", windowsHide: true}); } catch { /* */ }
                console.log(`[server] 启动前清残留 index.ts pid=${pid}`);
            }
        } else {
            const out = execSync("ps -ax -o pid=,command=", {encoding: "utf8"});
            for (const line of out.split("\n")) {
                if (!/server\/index\.ts|tsx server/i.test(line)) continue;
                const pid = Number(line.trim().split(/\s+/)[0]);
                if (!pid || pid === me) continue;
                try { process.kill(pid, "SIGKILL"); } catch { /* */ }
            }
        }
    } catch { /* */ }
}
killSiblingIndexProcesses();

const app = express();
app.use(cors());
app.use(express.json({limit: "10mb"}));

// ---------- API 命名对称(架构 v2):/api/gpt/* = GPT 域规范命名空间 ----------
// 历史路由用具体名(/api/accounts、/api/control、/api/sms、/api/export...)。此中间件把 /api/gpt/<x>
// 透明重写到 /api/<x>,让 GPT 域获得与 /api/claude/*、/api/mailboxes/* 对称的命名空间:前端可渐进
// 迁移到 /api/gpt/*,旧路径继续可用(零移动、零风险)。跨域资源(mailboxes/claude 各有命名空间)排除,避免误 alias。
app.use((req, res, next) => {
    if (req.url.startsWith("/api/gpt/")) {
        const rest = req.url.slice("/api/gpt/".length);
        if (!rest.startsWith("mailboxes") && !rest.startsWith("claude") && !rest.startsWith("proxy-") && !rest.startsWith("jump-")) req.url = "/api/" + rest;
    }
    next();
});

// ---------- SSE ----------
const sseClients = new Set();
function broadcast(event, data) {
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of sseClients) {
        try { res.write(payload); } catch { /* ignore */ }
    }
}
scheduler.on("log", (d) => broadcast("log", d));
scheduler.on("status", (d) => broadcast("status", d));
scheduler.on("stats", (d) => broadcast("stats", d));
scheduler.on("snapshot", (d) => broadcast("snapshot", d));
scheduler.on("sms", (d) => broadcast("sms", d));
scheduler.on("claude", (d) => broadcast("claude", d));      // Claude 账号状态变化 → ClaudePanel 刷新
scheduler.on("mbLog", (d) => broadcast("mbLog", d));        // 邮箱域日志 → 邮箱详情实时
scheduler.on("claudeLog", (d) => broadcast("claudeLog", d)); // Claude 域日志(注册/查订阅/养号)→ Claude 详情实时
scheduler.on("daily", (d) => broadcast("daily", d));

app.get("/api/stream", async (req, res) => {
    res.set({
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
    });
    res.flushHeaders?.();
    sseClients.add(res);
    res.write(`event: hello\ndata: ${JSON.stringify({state: {...scheduler.state(), ...mailboxStateExtras()}, stats: await db.stats()})}\n\n`);
    const ping = setInterval(() => { try { res.write(`event: ping\ndata: {}\n\n`); } catch { /* */ } }, 25000);
    req.on("close", () => { clearInterval(ping); sseClients.delete(res); });
});

// ---------- 解析邮箱文本: 优先用配置分隔符,回退支持 空白/:/, 等常见分隔 ----------
function parseEmailPasswordLines(text) {
    const sep = scheduler.mailSeparator || "----";
    const sepRe = new RegExp(sep.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
    const rows = [];
    for (const raw of String(text || "").split(/\r?\n/)) {
        const line = raw.trim();
        if (!line) continue;
        let parts = line.includes(sep) ? line.split(sepRe).map((s) => s.trim()) : [];
        if (parts.filter(Boolean).length < 2 && line.includes("----")) parts = line.split("----").map((s) => s.trim());
        if (parts.filter(Boolean).length < 2) parts = line.split(/[\s,;|\t]+/).map((s) => s.trim()).filter(Boolean);
        const email = (parts[0] || "").toLowerCase();
        const password = parts[1] || "";
        if (/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
            // 卖家常见: 邮箱----密码----辅助邮箱----密钥；也兼容 邮箱----密码----密钥----辅助邮箱
            let rec = "", totp = "";
            if (parts.length >= 4) {
                rec = parts[2] || "";
                totp = parts[3] || "";
            } else if (parts.length === 3) {
                if (looksLikeEmail(parts[2])) rec = parts[2];
                else totp = parts[2] || "";
            }
            const straight = straightenImportRow({totp_secret: totp, recovery_email: rec});
            rows.push({email, password, totp_secret: straight.totp_secret, recovery_email: straight.recovery_email});
        }
    }
    return rows;
}
function parseAccounts(text, fallbackPassword) {
    return parseEmailPasswordLines(text)
        .map((r) => ({
            email: r.email,
            password: r.password || fallbackPassword || "",
            totp_secret: r.totp_secret || "",
            recovery_email: r.recovery_email || "",
        }))
        .filter((r) => r.password);
}

/** 从粘贴文本抽出邮箱：支持纯地址、email----pwd、email:pwd、多行混合。 */
function extractEmailsFromText(text) {
    const sep = scheduler.mailSeparator || "----";
    const sepRe = new RegExp(sep.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
    const emails = [];
    const seen = new Set();
    const push = (raw) => {
        const email = String(raw || "").trim().toLowerCase().replace(/^[<"'\[]+|[>"'\]]+$/g, "");
        if (/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) && !seen.has(email)) {
            seen.add(email);
            emails.push(email);
        }
    };
    for (const raw of String(text || "").split(/\r?\n/)) {
        const line = raw.trim();
        if (!line) continue;
        let head = "";
        if (line.includes(sep)) head = line.split(sepRe)[0];
        else if (line.includes("----")) head = line.split("----")[0];
        else head = line.split(/[\s,;:|\t]+/)[0] || "";
        push(head);
        for (const m of line.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g) || []) push(m);
    }
    return emails;
}

// ---------- REST ----------
app.post("/api/accounts/import", async (req, res) => {
    const rows = parseAccounts(req.body.text, req.body.defaultPassword);
    if (!rows.length) return res.status(400).json({error: "未解析到有效的 邮箱+密码 行(支持 email----pwd / email:pwd / email pwd)"});
    const result = await db.importAccounts(rows, String(req.body.batch || "").trim(), String(req.body.provider || "mailcom"));
    broadcast("snapshot", await db.listAccounts());
    broadcast("stats", await db.stats());
    scheduler.tick(); // 未暂停时自动调度新导入的任务
    res.json(result);
});

// ---- 邮箱域:资源池写操作(导入 free / 分配到业务 / 删除 / 改密) ----
// 导入 free 邮箱(纯管理,不进任何注册队列)
app.post("/api/mailboxes/import", async (req, res) => {
    const rows = parseAccounts(req.body.text, req.body.defaultPassword);
    if (!rows.length) return res.status(400).json({error: "未解析到有效的 邮箱+密码 行(支持 email----pwd / email:pwd / email pwd)"});
    const usage = req.body.hold ? "hold" : "free"; // hold=导入即独立(永不被业务分配),free=待分配
    const provider = String(req.body.provider || "mailcom");
    const result = await db.importFreeMailboxes(rows, String(req.body.grp || "").trim(), usage, provider);
    const extra = {emails: rows.map((r) => r.email.toLowerCase())};
    if (provider === "google" && result.ids?.length) {
        const grpLabel = String(req.body.grp || "").trim() || "—";
        for (const id of result.ids) {
            await db.refreshMailboxGoogleState(id, {stage: "imported"}).catch(() => {});
            logMailbox(id, `[导入] ${usage} grp=${grpLabel}`);
        }
    }
    broadcast("mailboxes", {stats: await db.mailboxStats()});
    // 导入后自动改密(可选):对刚导入的邮箱(free 或 hold)批量改随机20位(headed 串行,后台跑)
    if (req.body.autoChangePw && provider !== "google") {
        const emails = new Set(rows.map((r) => r.email.toLowerCase()));
        const items = (await db.listMailboxes()).filter((m) => emails.has(m.email) && (m.usage === "free" || m.usage === "hold"))
            .map((m) => ({id: m.id, email: m.email, payload: {oldPw: m.password}}));
        if (items.length) {
            await beginMailQueue();
            const enq = await db.enqueueMailJobs(items, "pw");
            afterMailEnqueue();
            return res.json({...result, ...extra, autoChangePw: enq.inserted});
        }
    }
    // Gmail:勾选「导入后自动整备」则对这批地址(含库里已有、本次跳过的)立刻开批量整备
    if (req.body.autoHarden && provider === "google") {
        const found = (await db.lookupMailboxesByEmails(rows.map((r) => r.email)))
            .filter((m) => m.provider === "google" && !(m.deleted_at > 0));
        const ids = found.map((m) => m.id);
        if (ids.length) {
            const started = await startBatchGoogleHarden(ids);
            if (started.error) return res.json({...result, ...extra, autoHarden: 0, hardenError: started.error});
            return res.json({...result, ...extra, autoHarden: started.count, hardenConcurrency: started.concurrency});
        }
    }
    res.json({...result, ...extra});
});
// 从 free 池分配邮箱给业务域(gpt/claude):CAS 锁定 + 建 pending 业务号。gpt 立即进注册队列。★隔离
// 两种范围:body.ids(指定邮箱,GPT「从邮箱选号」用) 或 body.count+fromGrp(按数量从分组盲取,邮箱管理用)。
// changePwFirst(仅 ids 路径):分批流水线——每批(并发数)改完密码立即分配注册,不等全部改完。改密时邮箱未进注册队列,无竞态。
app.post("/api/mailboxes/allocate", async (req, res) => {
    const usage = String(req.body.usage || "");
    if (usage !== "gpt" && usage !== "claude") return res.status(400).json({error: "usage 必须是 gpt 或 claude"});
    const batch = String(req.body.batch || "").trim();
    const ids = Array.isArray(req.body.ids) ? req.body.ids.map(Number).filter(Number.isInteger) : null;

    // 分配后广播刷新 + 触发调度(gpt/claude 各自的通道)
    const afterAlloc = async () => {
        if (usage === "gpt") { broadcast("snapshot", await db.listAccounts()); broadcast("stats", await db.stats()); }
        else broadcast("claude", {stats: await db.claudeStats()});
        broadcast("mailboxes", {stats: await db.mailboxStats()});
        scheduler.tick(); // 未暂停则新 pending 立即进注册队列
    };

    if (ids) { // ── 按指定 id 分配(可选先改密) ──
        if (!ids.length) return res.status(400).json({error: "未选择邮箱"});
        const changePwFirst = req.body.changePwFirst === true;
        if (changePwFirst) {
            const mbs = (await Promise.all(ids.map((id) => db.getMailbox(id)))).filter((m) => m && (m.usage === "free" || m.usage === "hold"));
            if (!mbs.length) return res.status(400).json({error: "选中的邮箱都不是待分配/独立状态,无法先改密"});
            await beginMailQueue();
            const enq = await db.enqueueMailJobs(mbs.map((m) => ({
                id: m.id, email: m.email, payload: {oldPw: m.password, afterAllocate: {usage, batch}},
            })), "pw");
            afterMailEnqueue();
            return res.json({ok: true, changePwFirst: true, willChange: enq.inserted, queued: true});
        }
        const r = await db.allocateMailboxIdsTo(usage, ids, batch); // 直接分配
        await afterAlloc();
        return res.json(r);
    }

    // ── 按数量从分组盲取(原邮箱管理路径) ──
    const count = Number(req.body.count || 0);
    if (!(count > 0)) return res.status(400).json({error: "count 必须 > 0"});
    const fromGrp = typeof req.body.fromGrp === "string" ? req.body.fromGrp : undefined;
    const r = await db.allocateMailboxesTo(usage, count, batch, fromGrp);
    await afterAlloc();
    res.json(r);
});
// 删除邮箱(仅未被业务占用的 free 邮箱;被占用则 409,应从对应业务域删)
app.delete("/api/mailboxes/:id", async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({error: "bad id"});
    const r = await db.deleteMailbox(id);
    if (!r.ok) return res.status(409).json(r);
    broadcast("mailboxes", {stats: await db.mailboxStats()});
    res.json(r);
});
// 批量删除邮箱:删除选中的 free/hold 邮箱;被 gpt/claude 占用的跳过(应从对应业务域删)。
app.post("/api/mailboxes/batch-delete", async (req, res) => {
    const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(Number) : [];
    if (!ids.length) return res.status(400).json({error: "未选择邮箱"});
    const r = await db.batchDeleteMailbox(ids);
    broadcast("mailboxes", {stats: await db.mailboxStats()});
    res.json({ok: true, ...r});
});
// 真·改邮箱密码(操作 mail.com 改密页,free 邮箱也适用),改后同步库
async function withLeasedMailProxy(owner, fn, mb = null) {
    const cap = Math.max(1, Math.min(8, scheduler.pwConcurrency || 1));
    const who = String(owner || "mail");
    const prefer = String(mb?.proxy_url || "").trim();
    let jumpLease = null;
    if (mailJumpPool.urls.length) {
        jumpLease = await mailJumpPool.lease(who, {timeoutMs: 45_000, maxPerJump: JUMP_MAX_EXITS});
    }
    const lease = await mailProxyPool.lease(who, {
        fallback: scheduler.mailProxyFallback(),
        maxPerTemplate: cap,
        freshSession: !prefer,
        preferUrl: prefer,
    });
    const remember = (url, ip = "") => {
        if (!mb?.id || !url) return;
        db.setMailboxProxy(mb.id, url, ip).catch(() => {});
        mb.proxy_url = url;
        if (ip) mb.proxy_ip = ip;
    };
    if (lease.url) remember(lease.url, mb?.proxy_ip || "");
    try { return await fn(lease.url, jumpLease?.url || scheduler.mailProxyJump || "", remember); }
    finally {
        lease.release();
        try { jumpLease?.release(); } catch { /* */ }
    }
}

function googleBitName(prefix, email) {
    return `${prefix}-${String(email || "").split("@")[0].slice(0, 12)}`;
}

async function changeGooglePasswordWithPool(mb, np, log) {
    return withLeasedMailProxy(mb.email, (proxyUrl, jumpUrl, remember) => {
        log(`代理 ${maskProxyUrl(proxyUrl)}（一号一代理 · ${mb.proxy_url ? "复用出口" : "新出口"}${jumpUrl ? " · 跳板 " + jumpUrl : ""}）`);
        return withGoogleBitSession({
            proxyUrl, jumpUrl, name: googleBitName("pw", mb.email), remark: "gmail-pw", log, onProxy: remember,
        }, (page) => changePasswordOnPage(page, {
            email: mb.email, password: mb.password, totpSecret: mb.totp_secret || "",
            recoveryEmail: mb.recovery_email || "", newPassword: np, log,
        }));
    }, mb);
}

async function changeGoogleTotpWithPool(mb, log) {
    return withLeasedMailProxy(mb.email, (proxyUrl, jumpUrl, remember) => {
        log(`代理 ${maskProxyUrl(proxyUrl)}（一号一代理 · ${mb.proxy_url ? "复用出口" : "新出口"}${jumpUrl ? " · 跳板 " + jumpUrl : ""}）`);
        return withGoogleBitSession({
            proxyUrl, jumpUrl, name: googleBitName("2fa", mb.email), remark: "gmail-2fa", log, onProxy: remember,
        }, (page) => change2faOnPage(page, {
            email: mb.email, password: mb.password, totpSecret: mb.totp_secret || "",
            recoveryEmail: mb.recovery_email || "", log,
        }));
    }, mb);
}

async function applyGoogleHardenResult(id, mb, r) {
    const {planHardenSkip} = await import("../src/mail/google-state.js");
    const alreadyUsable = planHardenSkip(mb).usable;
    if (r.passwordChanged && r.password) {
        await db.setMailboxPassword(id, r.password, r.ok ? `✅整备 ${pwStamp()}` : `✅改密 ${pwStamp()}`);
    } else if (r.ok) {
        await db.setMailboxPwStatus(id, `✅整备 ${pwStamp()}`);
    } else if (!r.skipped && !alreadyUsable && !/^✅改密/.test(String(mb.pw_status || ""))) {
        await db.setMailboxPwStatus(id, `⚠整备部分 ${pwStamp()}`);
    }
    if (r.totpSecret) await db.setMailboxTotp(id, r.totpSecret);
    await db.applyMailboxUpdate(mb.email, {
        imap_password: r.imapPassword || undefined,
        recovery_email: r.recoveryCleared ? "" : undefined,
    });
    await db.refreshMailboxGoogleState(id, {
        login: r.ok || r.password || r.totpSecret || r.imapPassword ? "ok" : undefined,
        password: r.passwordChanged ? "ok" : undefined,
        totp: r.totpSecret ? "ok" : undefined,
        totp_rotated: r.totpRotated ? true : undefined,
        recovery: r.recoveryCleared ? "ok" : undefined,
        phone: r.phoneCleared ? "ok" : undefined,
        devices: r.devicesDone ? "ok" : undefined,
        imap: r.imapPassword ? "ok" : (r.errors || []).some((x) => /IMAP/i.test(String(x))) ? "fail" : undefined,
        last_error: (r.errors || []).filter(Boolean).join("; ").slice(0, 160),
    }).catch(() => {});
}

async function runOneGoogleHarden(id, opts = {}) {
    const mb = await db.getMailbox(id);
    if (!mb) return {ok: false, error: "邮箱不存在"};
    if (mb.provider !== "google") return {ok: false, error: "仅 Gmail 老号可整备"};
    if (batchHardenStop || isMailboxJobStopped()) return {ok: false, error: "已停止"};
    const {planHardenSkip} = await import("../src/mail/google-state.js");
    const skip = planHardenSkip(mb);
    if (skip.all) {
        logMailbox(id, "[整备] 缺口已齐，不再开窗");
        return {
            ok: true, skipped: true, password: mb.password, totpSecret: mb.totp_secret,
            totpRotated: true,
            imapPassword: mb.imap_password, recoveryCleared: true, passwordChanged: true, devicesDone: true,
        };
    }
    logMailbox(id, `[整备] 续跑 ${skip.left.join("/")}${skip.usable ? "（底线已齐，补加分项）" : ""}`);
    const ac = new AbortController();
    hardenAbort.set(id, ac);
    hardenCurrent.set(id, {id, email: mb.email, lastLine: "开始整备"});
    let lineTick = 0;
    const logStep = (m) => {
        logMailbox(id, m);
        const cur = hardenCurrent.get(id);
        if (cur) cur.lastLine = String(m || "").slice(0, 180);
        batchHardenProg.lastLine = `${mb.email}: ${String(m || "").slice(0, 140)}`;
        scheduleMailboxJobBroadcast();
        if (opts.jobId && Date.now() - lineTick > 800) {
            lineTick = Date.now();
            db.setMailJobLine(opts.jobId, `${mb.email}: ${String(m || "").slice(0, 140)}`).catch(() => {});
        }
    };
    logStep(`[整备] 续跑 ${skip.left.join(" → ")}`);
    try {
        const r = await withLeasedMailProxy(mb.email, (proxyUrl, jumpUrl, remember) => {
            if (batchHardenStop || isMailboxJobStopped() || ac.signal.aborted) throw new Error("已停止");
            const sess = kookeeySessionOf(proxyUrl);
            logStep(`[整备] 代理 ${maskProxyUrl(proxyUrl)}${sess ? " session=" + sess : ""}（一号一代理 · ${mb.proxy_url ? "复用出口" : "新出口"}${jumpUrl ? " · 跳板 " + jumpUrl : ""}）`);
            return runGoogleHardenWithBit({
                email: mb.email, password: mb.password,
                totpSecret: mb.totp_secret || "", recoveryEmail: mb.recovery_email || "",
                imap_password: mb.imap_password || "", pw_status: mb.pw_status || "",
                google_state: mb.google_state || {},
            }, {
                proxyUrl, jumpUrl, signal: ac.signal, log: logStep, onProxy: remember,
                onCheckpoint: async (patch = {}) => {
                    if (patch.password) {
                        if (patch.verified === false) {
                            logStep(`[留痕] 改密未验证，不覆盖库内密码 候选=${patch.password}`);
                        } else {
                            await db.setMailboxPassword(id, patch.password, `✅改密(已验证) ${pwStamp()}`);
                            logStep("[落库] 新密码已写入（已验证）");
                        }
                    }
                    if (patch.totpSecret) {
                        await db.setMailboxTotp(id, patch.totpSecret);
                        await db.refreshMailboxGoogleState(id, {totp: "ok", totp_rotated: true}).catch(() => {});
                        logStep("[落库] 新 TOTP 已写入（已验证）");
                    }
                    if (patch.imapPassword) await db.applyMailboxUpdate(mb.email, {imap_password: patch.imapPassword});
                    if (patch.recoveryCleared) await db.applyMailboxUpdate(mb.email, {recovery_email: ""});
                },
            });
        }, mb);
        await applyGoogleHardenResult(id, mb, r);
        const miss = (r.missing || []).join("/") || (r.ok ? "" : "部分步骤失败");
        const errBrief = (r.errors || []).map((e) => String(e).split("\n")[0]).join("；").slice(0, 200);
        logStep(`[整备] ${r.ok ? "完成" : "部分失败"} 机=${db.instanceId} 缺=${miss || "无"} ${errBrief}`.slice(0, 240));
        broadcast("mailboxes", {stats: await db.mailboxStats(), proxyPool: scheduler.mailProxyPoolSnap()});
        return {
            ok: !!r.ok, password: r.password, totpSecret: r.totpSecret, totpRotated: !!r.totpRotated,
            passwordChanged: !!r.passwordChanged, imapPassword: r.imapPassword || "",
            imap: !!r.imapPassword, recoveryCleared: !!r.recoveryCleared,
            phoneCleared: !!r.phoneCleared, devicesDone: !!r.devicesDone,
            missing: r.missing || [], errors: r.errors || [], skipped: !!r.skipped,
        };
    } catch (e: any) {
        const msg = String(e?.message ?? e);
        const closed = /has been closed|Target closed|browser has been closed/i.test(msg);
        const stopped = batchHardenStop || isMailboxJobStopped() || ac.signal.aborted || (/已停止/.test(msg) && !closed);
        const err = stopped ? "已停止" : (closed ? "比特窗口被关掉（未登录或被限频踢下线）" : msg);
        logStep(`[整备] ${stopped ? "已停止" : "异常"}: ${err}`);
        if (/账号已停用/.test(err)) {
            await db.refreshMailboxGoogleState(id, {login: "fail", last_error: "账号已停用"}).catch(() => {});
        }
        return {ok: false, error: err};
    } finally {
        hardenAbort.delete(id);
        hardenCurrent.delete(id);
        scheduleMailboxJobBroadcast();
    }
}

app.post("/api/mailboxes/:id/change-passwd", async (req, res) => {
    const id = Number(req.params.id);
    const mb = await db.getMailbox(id);
    if (!mb) return res.status(404).json({error: "邮箱不存在"});
    const np = String(req.body.newPassword || "").trim() || randomPassword(20);
    await beginMailQueue();
    const enq = await db.enqueueMailJobs([{id: mb.id, email: mb.email, payload: {oldPw: mb.password, newPassword: np}}], "pw");
    logMailbox(id, `[改密] 已入队 预定新密码=${np}`);
    afterMailEnqueue();
    res.json({ok: true, queued: true, newPassword: np, count: enq.inserted});
});

app.get("/api/mailboxes/proxy-pool", (req, res) => {
    const urls = scheduler.mailProxyPool || [];
    res.json({ok: true, urls, lines: urls.map((u) => toProxyImportLine(u)), jump: scheduler.mailProxyJump || "", ...scheduler.mailProxyPoolSnap()});
});
app.post("/api/mailboxes/proxy-pool", (req, res) => {
    const text = req.body?.text != null ? String(req.body.text) : Array.isArray(req.body?.urls) ? req.body.urls.join("\n") : "";
    const append = req.body?.append === true;
    const copies = req.body?.copies;
    if (req.body?.jump != null) scheduler.setMailProxyJump(String(req.body.jump || ""));
    const snap = scheduler.setMailProxyPool(text, {append, copies});
    res.json({ok: true, urls: scheduler.mailProxyPool || [], jump: scheduler.mailProxyJump || "", ...snap});
});
app.post("/api/mailboxes/proxy-jump", async (req, res) => {
    const jump = scheduler.setMailProxyJump(String(req.body?.jump ?? ""));
    try { await scheduler.ensureJumpFleet(); } catch (e: any) { return res.status(400).json({error: String(e?.message ?? e)}); }
    res.json({ok: true, jump: scheduler.mailProxyJump || jump, jumpPool: scheduler.jumpPoolSnapshot()});
});
app.get("/api/mailboxes/jump-pool", (req, res) => {
    res.json({ok: true, ...scheduler.jumpPoolSnapshot()});
});
app.post("/api/mailboxes/jump-pool", async (req, res) => {
    const text = req.body?.text != null ? String(req.body.text) : Array.isArray(req.body?.urls) ? req.body.urls.join("\n") : "";
    const urls = text.split(/[\r\n]+/).map((s) => s.trim()).filter(Boolean);
    try {
        await scheduler.setMailJumpPool(urls);
        if (req.body?.check) await mailJumpPool.checkAll();
        res.json({ok: true, ...scheduler.jumpPoolSnapshot()});
    } catch (e: any) { res.status(400).json({error: String(e?.message ?? e)}); }
});
app.post("/api/mailboxes/jump-pool/check", async (req, res) => {
    await mailJumpPool.checkAll();
    res.json({ok: true, ...scheduler.jumpPoolSnapshot()});
});
app.post("/api/mailboxes/proxy-jump/test", async (req, res) => {
    const jump = String(req.body?.jump ?? scheduler.mailProxyJump ?? "").trim();
    if (jump) scheduler.setMailProxyJump(jump);
    const urls = scheduler.mailProxyPool || [];
    const sample = urls[0] || "";
    if (!sample) return res.status(400).json({ok: false, error: "代理池是空的"});
    const probe = await probeMailProxy(sample, {timeoutSec: 14, jump: scheduler.mailProxyJump || ""});
    res.json({
        ok: !!probe.ok, jump: scheduler.mailProxyJump || "", sample: maskProxyUrl(sample),
        ip: probe.ip, google: probe.google, ms: probe.ms, reason: probe.reason || "",
    });
});

app.get("/api/gpt/proxy-pool", (req, res) => {
    const urls = scheduler.gptProxyPool || [];
    res.json({ok: true, urls, lines: urls.map((u) => toProxyImportLine(u)), jump: scheduler.gptProxyJump || "", ...scheduler.gptProxyPoolSnap()});
});
app.post("/api/gpt/proxy-pool", (req, res) => {
    const text = req.body?.text != null ? String(req.body.text) : Array.isArray(req.body?.urls) ? req.body.urls.join("\n") : "";
    const append = req.body?.append === true;
    const copies = req.body?.copies;
    if (req.body?.jump != null) scheduler.setGptProxyJump(String(req.body.jump || ""));
    const snap = scheduler.setGptProxyPool(text, {append, copies});
    res.json({ok: true, urls: scheduler.gptProxyPool || [], jump: scheduler.gptProxyJump || "", ...snap});
});
app.post("/api/gpt/proxy-jump", async (req, res) => {
    const jump = scheduler.setGptProxyJump(String(req.body?.jump ?? ""));
    try {
        if (jump) await scheduler.setGptJumpPool([jump]);
        else await scheduler.setGptJumpPool([]);
    } catch (e: any) { return res.status(400).json({error: String(e?.message ?? e)}); }
    res.json({ok: true, jump: scheduler.gptProxyJump || jump, jumpPool: scheduler.jumpPoolSnapshot()});
});
app.get("/api/gpt/jump-pool", (req, res) => {
    res.json({ok: true, ...scheduler.jumpPoolSnapshot()});
});
app.post("/api/gpt/jump-pool", async (req, res) => {
    const text = req.body?.text != null ? String(req.body.text) : Array.isArray(req.body?.urls) ? req.body.urls.join("\n") : "";
    const urls = text.split(/[\r\n]+/).map((s) => s.trim()).filter(Boolean);
    try {
        await scheduler.setGptJumpPool(urls);
        if (req.body?.check) await gptJumpPool.checkAll();
        res.json({ok: true, ...scheduler.jumpPoolSnapshot()});
    } catch (e: any) { res.status(400).json({error: String(e?.message ?? e)}); }
});
app.post("/api/gpt/jump-pool/check", async (req, res) => {
    await gptJumpPool.checkAll();
    res.json({ok: true, ...scheduler.jumpPoolSnapshot()});
});
app.post("/api/gpt/proxy-jump/test", async (req, res) => {
    const jump = String(req.body?.jump ?? scheduler.gptProxyJump ?? "").trim();
    if (req.body?.jump != null) scheduler.setGptProxyJump(jump);
    const urls = scheduler.gptProxyPool || [];
    const sample = urls[0] || "";
    if (!sample) return res.status(400).json({ok: false, error: "代理池是空的"});
    const probe = await probeMailProxy(sample, {timeoutSec: 14, jump: scheduler.gptProxyJump || ""});
    res.json({
        ok: !!probe.ok, jump: scheduler.gptProxyJump || "", sample: maskProxyUrl(sample),
        ip: probe.ip, google: probe.google, ms: probe.ms, reason: probe.reason || "",
    });
});

app.post("/api/mailboxes/:id/google-harden", async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({error: "bad id"});
    const started = await startBatchGoogleHarden([id]);
    if (started.error) return res.status(/已有/.test(started.error) ? 409 : /不存在|仅 Gmail|未选择/.test(started.error) ? 400 : 500).json({error: started.error});
    res.json({ok: true, queued: true, ...started});
});

let batchHardenStop = false;
const batchHardenProg = {running: false, kind: "harden", done: 0, total: 0, ok: 0, stopped: false, lastLine: ""};
const hardenCurrent = new Map();
const hardenAbort = new Map();
const localMailJobIds = new Set();
let lastHardenWindows = [];
let lastMailJobProg = null;
let lastMailInstances = [];
let mailboxJobBcTimer = null;
let mailJobTickBusy = false;
let instanceShuttingDown = false;

function emailFromBitName(name) {
    const n = String(name || "");
    const m = n.match(/^harden-([^-]+)/i);
    return m ? m[1] : n;
}

function snapshotMailboxJob() {
    const dbp = lastMailJobProg || {
        running: false, kind: "mail", done: 0, total: 0, ok: 0, fail: 0,
        queued: 0, runningCount: 0, rate: 0, current: [], lastLine: "", byKind: {},
    };
    return {
        running: !!dbp.running,
        kind: dbp.kind || "mail",
        done: Number(dbp.done || 0),
        total: Number(dbp.total || 0),
        ok: Number(dbp.ok || 0),
        fail: Number(dbp.fail || 0),
        queued: Number(dbp.queued || 0),
        runningCount: Number(dbp.runningCount || 0),
        rate: Number(dbp.rate || 0),
        current: dbp.current || [],
        lastLine: dbp.lastLine || "",
        byKind: dbp.byKind || {},
        windows: lastHardenWindows,
        instances: lastMailInstances,
        source: "queue",
        instanceId: db.instanceId,
        stopped: !!dbp.paused,
        startedAt: Number(dbp.startedAt || 0) || 0,
        endedAt: Number(dbp.endedAt || 0) || 0,
        elapsedMs: Number(dbp.elapsedMs || 0) || 0,
        avgMs: Number(dbp.avgMs || 0) || 0,
        etaMs: Number(dbp.etaMs || 0) || 0,
        hourly: Array.isArray(dbp.hourly) ? dbp.hourly : [],
        hourNow: dbp.hourNow || null,
    };
}

function mailboxStateExtras() {
    const job = snapshotMailboxJob();
    return {batchPw: job, batchHarden: job, mailJob: job, mailInstances: lastMailInstances};
}

async function beginMailQueue() {
    clearMailboxJobStop();
    batchHardenStop = false;
    await db.setMailClaimPaused(false);
}

function afterMailEnqueue() {
    db.mailJobsProgress().then((p) => {
        lastMailJobProg = p;
        lastMailJobProg.paused = false;
        scheduleMailboxJobBroadcast();
    }).catch(() => {});
    tickMailJobs().catch(() => {});
}

async function stopAllMailJobs() {
    batchHardenStop = true;
    requestMailboxJobStop();
    await db.setMailClaimPaused(true);
    const canceled = await db.cancelPendingMailJobs("").catch(() => 0);
    for (const ac of hardenAbort.values()) {
        try { ac.abort(); } catch { /* */ }
    }
    lastMailJobProg = await db.mailJobsProgress().catch(() => lastMailJobProg);
    if (lastMailJobProg) lastMailJobProg.paused = true;
    await reportMailInstance().catch(() => {});
    broadcast("batchHarden", {...snapshotMailboxJob(), proxyPool: scheduler.mailProxyPoolSnap()});
    // 先停领、再等改密/换2FA 落库，不要立刻关指纹（Google 已改钥、库还是旧的会丢号）。
    void (async () => {
        const {mailJobInCritical} = await import("../src/mail/mailbox-job-stop.js");
        const t0 = Date.now();
        while (localMailJobIds.size && Date.now() - t0 < 70_000) {
            if (!mailJobInCritical() && Date.now() - t0 > 3000) break;
            await new Promise((r) => setTimeout(r, 400));
        }
        const closed = await stopAutomationBitWindows({includeClosed: true, log: (m) => console.log(m)});
        console.log(`[整备] 停止收尾关窗 ${closed} 进行中=${localMailJobIds.size}`);
        await refreshMailboxJobWindows();
        await reportMailInstance().catch(() => {});
        broadcast("batchHarden", {...snapshotMailboxJob(), proxyPool: scheduler.mailProxyPoolSnap()});
    })();
    return {ok: true, closed: 0, canceled, draining: true};
}

function scheduleMailboxJobBroadcast() {
    if (mailboxJobBcTimer) return;
    mailboxJobBcTimer = setTimeout(() => {
        mailboxJobBcTimer = null;
        broadcast("batchHarden", {...snapshotMailboxJob(), proxyPool: scheduler.mailProxyPoolSnap()});
    }, 350);
}

function mailJobFreeSlots() {
    const snap = scheduler.mailProxyPoolSnap();
    const cap = Math.max(1, Math.min(scheduler.pwConcurrency || 1, snap.slots || 1));
    return Math.max(0, cap - localMailJobIds.size);
}

let jumpGateWarned = false;
/** 配了跳板就必须真能连；一条都没有就不领 harden，避免一登录就开窗秒删。 */
async function hardenClaimSlots() {
    const free = mailJobFreeSlots();
    const configured = (scheduler.collectJumpLines() || []).filter(Boolean).length;
    if (!configured) return free;
    const urls = mailJumpPool.urls || [];
    if (!urls.length) {
        if (!jumpGateWarned) {
            console.warn("[mail-jobs] 跳板已配置但没有可用本地端口，本机不领整备");
            jumpGateWarned = true;
        }
        return 0;
    }
    let healthy = 0;
    for (const url of urls) {
        let h = mailJumpPool.health.get(url);
        if (!h || Date.now() - (h.at || 0) > 90_000) {
            h = await mailJumpPool.checkOne(url);
        }
        if (h?.ok) healthy += 1;
    }
    if (!healthy) {
        if (!jumpGateWarned) {
            console.warn("[mail-jobs] 跳板探测全失败，本机不领整备");
            jumpGateWarned = true;
        }
        return 0;
    }
    jumpGateWarned = false;
    return Math.max(0, Math.min(free, healthy * JUMP_MAX_EXITS - localMailJobIds.size));
}

function jobPayload(job) {
    const p = job?.payload;
    if (!p) return {};
    if (typeof p === "string") {
        try { return JSON.parse(p); } catch { return {}; }
    }
    return p;
}

let bitParkAnnounced = false;
async function parkJobsForBitDown(reason) {
    const {markBitLoggedOut} = await import("../src/bitbrowser.js");
    markBitLoggedOut(true);
    const n = await db.requeueRunningOnInstance(db.instanceId, "比特掉登录，退回排队").catch(() => 0);
    for (const ac of hardenAbort.values()) {
        try { ac.abort(); } catch { /* */ }
    }
    if (!bitParkAnnounced) {
        console.warn(`[mail-jobs] 比特不可用，已领任务退回排队（不当失败）: ${String(reason || "").slice(0, 120)} n=${n}`);
        bitParkAnnounced = true;
    }
    scheduleMailboxJobBroadcast();
}

async function runClaimedMailJob(job) {
    localMailJobIds.add(job.mailbox_id);
    try {
        const kind = String(job.kind || "harden");
        if (kind === "pw") {
            const payload = jobPayload(job);
            const r = await doPwChange(job.mailbox_id, job.email, payload.oldPw || "", payload.newPassword || "");
            await db.completeMailJob(job.id, !!r.ok, r.detail || "", {newPassword: r.np || ""});
            if (r.ok && payload.afterAllocate?.usage) {
                try {
                    await db.allocateMailboxIdsTo(payload.afterAllocate.usage, [job.mailbox_id], payload.afterAllocate.batch || "");
                    broadcast("snapshot", await db.listAccounts());
                    broadcast("stats", await db.stats());
                } catch (e) {
                    console.warn("[mail-jobs] 改密后分配失败:", e?.message || e);
                }
            }
        } else if (kind === "2fa") {
            const mb = await db.getMailbox(job.mailbox_id);
            if (!mb) throw new Error("邮箱不存在");
            const r = await changeGoogleTotpWithPool(mb, (m) => {
                logMailbox(job.mailbox_id, `[2FA] ${m}`);
                db.setMailJobLine(job.id, String(m).slice(0, 140)).catch(() => {});
            });
            if (r?.ok && r.totpSecret) {
                await db.setMailboxTotp(job.mailbox_id, r.totpSecret);
                await db.completeMailJob(job.id, true, "", {totpSecret: r.totpSecret});
            } else {
                await db.completeMailJob(job.id, false, r?.error || "2FA 失败");
            }
        } else {
            const r = await runOneGoogleHarden(job.mailbox_id, {jobId: job.id});
            const {formatHardenPartialError} = await import("../src/mail/google-state.js");
            const err = formatHardenPartialError(r);
            const {isBitTransientError, isProxyInfraError} = await import("../src/bitbrowser.js");
            if (!r.ok && isBitTransientError(err)) {
                await parkJobsForBitDown(err);
                await db.requeueMailJob(job.id, "比特异常，退回排队");
            } else if (!r.ok && isProxyInfraError(err)) {
                await db.requeueMailJob(job.id, "跳板/代理异常，退回排队");
            } else {
                await db.completeMailJob(job.id, !!r.ok, err, {
                    instanceId: db.instanceId,
                    imap: !!r.imapPassword || !!r.imap, totp: !!r.totpSecret, totpRotated: !!r.totpRotated,
                    password: !!r.passwordChanged, recovery: !!r.recoveryCleared,
                    phone: !!r.phoneCleared, devices: !!r.devicesDone,
                    missing: r.missing || [], errors: (r.errors || []).map((e) => String(e).split("\n")[0].slice(0, 120)),
                    skipped: !!r.skipped,
                });
            }
        }
    } catch (e) {
        const msg = String(e?.message || e);
        const {isBitTransientError, isProxyInfraError} = await import("../src/bitbrowser.js");
        if (isBitTransientError(msg)) {
            await parkJobsForBitDown(msg);
            await db.requeueMailJob(job.id, "比特异常，退回排队").catch(() => {});
        } else if (isProxyInfraError(msg)) {
            await db.requeueMailJob(job.id, "跳板/代理异常，退回排队").catch(() => {});
        } else {
            await db.completeMailJob(job.id, false, msg).catch(() => {});
        }
    } finally {
        localMailJobIds.delete(job.mailbox_id);
        hardenAbort.delete(job.mailbox_id);
        hardenCurrent.delete(job.mailbox_id);
        scheduleMailboxJobBroadcast();
        setTimeout(() => { tickMailJobs().catch(() => {}); }, 200);
    }
}

async function reportMailInstance() {
    const snap = scheduler.mailProxyPoolSnap();
    const paused = await db.isMailClaimPaused().catch(() => false);
    await db.upsertMailInstance(db.instanceId, {
        stopClaim: paused || batchHardenStop || isMailboxJobStopped(),
        proxySlots: snap.slots || 0,
        proxyLeased: snap.leased || 0,
        runningJobs: localMailJobIds.size,
    });
    lastMailInstances = await db.listMailInstances();
}

let lastBitBudgetAt = 0;
async function tickMailJobs() {
    if (!httpReady || mailJobTickBusy || instanceShuttingDown) return;
    mailJobTickBusy = true;
    try {
        const {isBitLoggedOut, ensureBitWindowBudget, setExpectedBitTiles, listAllBitWindows} = await import("../src/bitbrowser.js");
        if (isBitLoggedOut()) {
            try {
                await listAllBitWindows({force: true});
                if (!isBitLoggedOut()) {
                    const back = await db.requeueRecentBitTransientFails().catch(() => []);
                    bitParkAnnounced = false;
                    if (back.length) console.log(`[mail-jobs] 比特已恢复，误失败 ${back.length} 个重新排队`);
                }
            } catch { /* 仍未登录 */ }
        }
        if (Date.now() - lastBitBudgetAt > 45_000 && !isBitLoggedOut()) {
            lastBitBudgetAt = Date.now();
            const snap = scheduler.mailProxyPoolSnap();
            setExpectedBitTiles(Math.max(1, Math.min(scheduler.pwConcurrency || 1, snap.slots || 1)));
            const swept = await ensureBitWindowBudget({log: (m) => console.log(m)});
            if (swept) console.log(`[指纹] 本轮清超额 ${swept} 个`);
        }
        await db.reclaimStaleMailJobs(3 * 60 * 1000);
        const timed = await db.failTimedOutMailJobs(12 * 60 * 1000);
        for (const t of timed) {
            if (t.instance_id === db.instanceId) {
                const ac = hardenAbort.get(t.mailbox_id);
                try { ac?.abort(); } catch { /* */ }
            }
        }
        lastMailJobProg = await db.mailJobsProgress();
        lastMailJobProg.paused = await db.isMailClaimPaused();
        await reportMailInstance();
        if (batchHardenStop || lastMailJobProg.paused || isMailboxJobStopped()) {
            if (isMailboxJobStopped() && !batchHardenStop && !lastMailJobProg.paused) {
                console.warn("[mail-jobs] 本机有停止旗标，不再从共池认领（避免把队列领光再标失败）");
            }
            scheduleMailboxJobBroadcast();
            return;
        }
        const bitDown = isBitLoggedOut();
        const slots = bitDown ? mailJobFreeSlots() : await hardenClaimSlots();
        if (!slots) {
            scheduleMailboxJobBroadcast();
            return;
        }
        const snap = scheduler.mailProxyPoolSnap();
        const jobCap = Math.max(1, Math.min(scheduler.pwConcurrency || 1, snap.slots || 1));
        setExpectedBitTiles(jobCap);
        const jobs = await db.claimMailJobs(db.instanceId, slots, bitDown ? "pw" : "", jobCap);
        if (bitDown && !jobs.length) {
            scheduleMailboxJobBroadcast();
            return;
        }
        if (!jobs.length) {
            scheduleMailboxJobBroadcast();
            return;
        }
        console.log(`[mail-jobs] ${db.instanceId} 认领 ${jobs.length} 个（本机空位 ${slots}）`);
        for (const job of jobs) runClaimedMailJob(job);
        lastMailJobProg = await db.mailJobsProgress();
        scheduleMailboxJobBroadcast();
    } catch (e) {
        console.warn("[mail-jobs] tick 失败:", e?.message || e);
    } finally {
        mailJobTickBusy = false;
    }
}

async function refreshMailboxJobWindows({listBit = true} = {}) {
    if (listBit) {
        try { lastHardenWindows = await listAutomationBitWindows(); }
        catch { /* 比特没开/限频就沿用上次 */ }
    }
    try { lastMailJobProg = await db.mailJobsProgress(); }
    catch { /* 表未就绪 */ }
    const open = lastHardenWindows.filter((w) => w.status === 1);
    if (lastMailJobProg?.running || open.length || lastMailJobProg?.done) scheduleMailboxJobBroadcast();
}

async function startBatchGoogleHarden(ids) {
    const raw = (ids || []).map(Number).filter(Number.isInteger);
    if (!raw.length) return {error: "未选择邮箱"};
    const mbs = (await Promise.all(raw.map((id) => db.getMailbox(id)))).filter((m) => m && m.provider === "google" && !(m.deleted_at > 0));
    if (!mbs.length) return {error: "选中项没有 Gmail"};
    await beginMailQueue();
    const enq = await db.enqueueMailJobs(mbs.map((m) => ({id: m.id, email: m.email})), "harden");
    const snap = scheduler.mailProxyPoolSnap();
    lastMailJobProg = await db.mailJobsProgress();
    broadcast("batchHarden", {...snapshotMailboxJob(), proxyPool: snap});
    tickMailJobs().catch(() => {});
    return {
        ok: true,
        queued: true,
        count: enq.inserted,
        skipped: mbs.length - enq.inserted,
        batchId: enq.batchId,
        concurrency: Math.max(1, Math.min(scheduler.pwConcurrency || 1, snap.slots || 1)),
        proxies: snap.total || snap.slots,
        instanceId: db.instanceId,
    };
}

app.post("/api/mailboxes/batch-google-harden", async (req, res) => {
    const ids = (req.body?.ids || []).map(Number).filter(Number.isInteger);
    const started = await startBatchGoogleHarden(ids);
    if (started.error) return res.status(400).json({error: started.error});
    res.json(started);
});
app.post("/api/mailboxes/batch-google-harden/stop", async (req, res) => {
    res.json(await stopAllMailJobs());
});
async function resumeMailJobs({onlyError = false, ids = null} = {}) {
    await beginMailQueue();
    const dropped = await db.cancelPendingHardenIfAlreadyUsable().catch(() => 0);
    if (dropped) console.log(`[mail-jobs] 继续完成：撤掉 ${dropped} 个已整备（2FA+IMAP）的排队`);
    const scoped = Array.isArray(ids) && ids.length;
    let left = onlyError
        ? await db.listNewestBatchErrorJobs("harden").catch(() => [])
        : await db.listResumableMailJobs({
            kinds: ["harden", "pw", "2fa"], onlyError: false,
            since: scoped ? 0 : Date.now() - 3 * 60 * 60 * 1000,
        }).catch(() => []);
    if (scoped) {
        const want = new Set(ids.map(Number).filter(Number.isInteger));
        left = left.filter((it) => want.has(it.id));
    }
    const {planHardenSkip, needsHardenRetry} = await import("../src/mail/google-state.js");
    const harden = [];
    const pw = [];
    const twofa = [];
    let skippedDone = 0;
    const seen = new Set();
    for (const it of left) {
        const mb = await db.getMailbox(it.id);
        if (!mb || mb.deleted_at > 0) continue;
        if (it.kind === "harden") {
            if (mb.provider !== "google") continue;
            if (mb.google_stage === "blocked" || mb.google_stage === "gpt_ok") continue;
            if (planHardenSkip(mb).usable) { skippedDone += 1; continue; }
            harden.push(mb);
            seen.add(mb.id);
        } else if (it.kind === "pw") pw.push(mb);
        else if (it.kind === "2fa" && mb.provider === "google") twofa.push(mb);
    }
    if (!onlyError && Array.isArray(ids) && ids.length) {
        const gaps = await db.listGoogleHardenGaps(ids).catch(() => []);
        for (const mb of gaps) {
            if (seen.has(mb.id) || !needsHardenRetry(mb)) continue;
            harden.push(mb);
            seen.add(mb.id);
        }
    }
    if (!harden.length && !pw.length && !twofa.length) {
        return {
            ok: true, count: 0, skippedDone,
            msg: onlyError
                ? (skippedDone
                    ? `任务条上这批失败里有 ${skippedDone} 个 2FA+IMAP 已齐，无需再跑`
                    : "当前这批没有仍需重跑的失败")
                : "没有可续跑的任务",
        };
    }
    let inserted = 0;
    if (harden.length) {
        const enq = await db.enqueueMailJobs(harden.map((m) => ({id: m.id, email: m.email})), "harden");
        inserted += enq.inserted;
    }
    if (pw.length) {
        const enq = await db.enqueueMailJobs(pw.map((m) => ({id: m.id, email: m.email, payload: {oldPw: m.password}})), "pw");
        inserted += enq.inserted;
    }
    if (twofa.length) {
        const enq = await db.enqueueMailJobs(twofa.map((m) => ({id: m.id, email: m.email})), "2fa");
        inserted += enq.inserted;
    }
    lastMailJobProg = await db.mailJobsProgress();
    broadcast("batchHarden", {...snapshotMailboxJob(), proxyPool: scheduler.mailProxyPoolSnap()});
    tickMailJobs().catch(() => {});
    return {ok: true, queued: true, count: inserted, skippedDone};
}

app.post("/api/mailboxes/batch-google-harden/resume", async (req, res) => {
    const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(Number) : null;
    res.json(await resumeMailJobs({onlyError: false, ids}));
});
app.post("/api/mailboxes/jobs/retry-failed", async (req, res) => {
    const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(Number) : null;
    res.json(await resumeMailJobs({onlyError: true, ids}));
});
app.get("/api/mailboxes/job", async (req, res) => {
    await refreshMailboxJobWindows({listBit: false});
    const job = snapshotMailboxJob();
    res.json({ok: true, batchHarden: job, batchPw: job, job, instances: lastMailInstances});
});

app.post("/api/mailboxes/:id/google-2fa", async (req, res) => {
    const id = Number(req.params.id);
    const mb = await db.getMailbox(id);
    if (!mb) return res.status(404).json({error: "邮箱不存在"});
    if (mb.provider !== "google") return res.status(400).json({error: "仅 Gmail 老号可换 Google 2FA"});
    await beginMailQueue();
    const enq = await db.enqueueMailJobs([{id: mb.id, email: mb.email}], "2fa");
    logMailbox(id, "[2FA] 已入队，空闲代理会认领");
    afterMailEnqueue();
    res.json({ok: true, queued: true, count: enq.inserted, skipped: enq.inserted ? 0 : 1});
});

// 切换邮箱状态:free(待分配) ↔ hold(独立/永不被业务分配)。仅这两态可切,gpt/claude 会被拒(保护业务关联)。
app.post("/api/mailboxes/:id/usage", async (req, res) => {
    const id = Number(req.params.id);
    const usage = String(req.body?.usage || "");
    const r = await db.setMailboxUsage(id, usage);
    if (!r.ok) return res.status(400).json(r.error ? r : {error: "切换失败(邮箱不存在或已归属业务,不能改)"});
    broadcast("mailboxes", {stats: await db.mailboxStats()});
    res.json({ok: true, usage});
});
// 批量切换:ids 设为 free 或 hold
app.post("/api/mailboxes/usage", async (req, res) => {
    const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(Number) : [];
    const usage = String(req.body?.usage || "");
    const r = await db.setMailboxesUsage(ids, usage);
    if (r.error) return res.status(400).json(r);
    broadcast("mailboxes", {stats: await db.mailboxStats()});
    res.json({ok: true, count: r.count, usage});
});
app.post("/api/mailboxes/grp", async (req, res) => {
    const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(Number) : [];
    const grp = String(req.body?.grp ?? "");
    if (!ids.length) return res.status(400).json({error: "未选择邮箱"});
    const r = await db.setMailboxesGrp(ids, grp);
    broadcast("mailboxes", {stats: await db.mailboxStats()});
    res.json({ok: true, count: r.count, grp});
});

// ---- 邮箱域:收件箱/正文/操作日志(架构 v2:收件箱等邮箱能力集中到邮箱管理,覆盖 free/gpt/claude 所有邮箱)----
// Gmail → IMAP 应用专用密码；mail.com → Playwright 登录 maillist。
app.get("/api/mailboxes/:id/inbox", async (req, res) => {
    const id = Number(req.params.id);
    const mb = await db.getMailbox(id);
    if (!mb) return res.status(404).json({error: "邮箱不存在"});
    const isGoogle = mb.provider === "google" || /@(gmail|googlemail)\.com$/i.test(mb.email || "");
    logMailbox(id, isGoogle ? "[收信] 经 IMAP 拉取 Gmail 收件箱…" : "[收信] 登录 mail.com 拉取收件箱…");
    try {
        const mails = await fetchInboxList(mb, 40);
        logMailbox(id, `[收信] 成功,收件箱 ${mails.length} 封${isGoogle ? " (IMAP)" : ""}`);
        res.json({email: mb.email, mails, via: isGoogle ? "imap" : "mailcom"});
    } catch (e: any) { logMailbox(id, `[收信] 失败: ${e?.message ?? e}`); res.status(500).json({error: String(e?.message ?? e)}); }
});
// 按需拉单封正文(Gmail IMAP 缓存 / mail.com 会话)
app.get("/api/mailboxes/:id/mail/:mailId/body", async (req, res) => {
    const mb = await db.getMailbox(Number(req.params.id));
    if (!mb) return res.status(404).json({error: "邮箱不存在"});
    try { res.json({body: await fetchMailBodyFor(mb, req.params.mailId)}); }
    catch (e: any) { res.status(500).json({error: String(e?.message ?? e)}); }
});
// 邮箱操作日志(登录/改密/收信,独立表 mailbox_logs,与 GPT 注册日志隔离)
app.get("/api/mailboxes/:id/logs", async (req, res) => res.json(await db.listMailboxLogs(Number(req.params.id))));

// ---- 邮箱域:资源池只读(P5 邮箱管理 tab 用)。usage 过滤:free 待分配 / gpt / claude ----
app.get("/api/mailboxes", async (req, res) => {
    const usage = req.query.usage ? String(req.query.usage) : undefined;
    // groups=独立(free)邮箱的分组分布(恒返回,不受 usage 过滤影响),供前端"按分组分配"下拉
    res.json({list: await db.listMailboxes(usage), stats: await db.mailboxStats(), groups: await db.freeMailboxGroups()});
});
// 按邮箱批量查询(含已删除),给复制账密用
app.post("/api/mailboxes/lookup", async (req, res) => {
    const raw = req.body?.emails ?? req.body?.text ?? "";
    const emails = [...new Set(
        (Array.isArray(raw) ? raw.flatMap((s) => extractEmailsFromText(String(s))) : extractEmailsFromText(String(raw)))
            .map((s) => String(s || "").trim().toLowerCase())
            .filter(Boolean),
    )];
    const list = await db.lookupMailboxesByEmails(emails);
    const have = new Set(list.map((m) => String(m.email || "").toLowerCase()));
    res.json({
        list,
        queried: emails,
        found: emails.filter((e) => have.has(e)),
        missing: emails.filter((e) => !have.has(e)),
    });
});

// ---- Claude 域(架构 v2:与 GPT 对称命名空间 /api/claude/*)。----
// 邮箱经 POST /api/mailboxes/allocate {usage:'claude'} 从池分配 → 建 pending claude_accounts(占位)。
// 注册类接口待 Claude 机制逆向(见 docs/ARCHITECTURE-v2.md §8 D1),暂返回 501,但列表/分配已可用。
app.get("/api/claude/accounts", async (req, res) => res.json({list: await db.listClaudeAccounts(), stats: await db.claudeStats()}));
// Claude 独立的 开始/暂停/停止(只控制 Claude 域,不影响 GPT)。
app.post("/api/claude/register", (req, res) => { scheduler.startClaude(); res.json({ok: true, ...scheduler.state()}); }); // 开始=解除 Claude 暂停+tick
app.post("/api/claude/pause", (req, res) => { scheduler.pauseClaude(); res.json({ok: true, ...scheduler.state()}); });    // 软暂停:不再认领,运行中跑完
app.post("/api/claude/stop", (req, res) => { scheduler.stopClaude(); res.json({ok: true, ...scheduler.state()}); });      // 停止:暂停+杀正在跑的 Claude worker
// Claude 独立代理:直接填 socks/http;或填 vless 起独立 xray(claude 实例,端口 10810)并把 claudeProxy 指向它。
app.post("/api/control/claude-proxy", (req, res) => { if (typeof req.body?.proxy === "string") { scheduler.claudeProxy = req.body.proxy.trim(); scheduler.saveSettings(); } res.json({ok: true, claudeProxy: scheduler.claudeProxy}); });
// 配置独立 xray 的本地端口(持久化):用专属端口与系统 v2rayN/其他服务隔离,避免端口冲突与清理误杀。改后若已起 xray 则用新端口重启。
app.post("/api/control/proxy-ports", (req, res) => {
    const rp = Number(req.body?.regPort), cp = Number(req.body?.claudePort);
    const valid = (p: number) => Number.isInteger(p) && p >= 1024 && p <= 65535;
    if (req.body?.regPort != null && !valid(rp)) return res.status(400).json({error: "reg 端口需为 1024-65535"});
    if (req.body?.claudePort != null && !valid(cp)) return res.status(400).json({error: "claude 端口需为 1024-65535"});
    const nextReg = valid(rp) ? rp : scheduler.regProxyPort, nextClaude = valid(cp) ? cp : scheduler.claudeProxyPort;
    if (nextReg === nextClaude) return res.status(400).json({error: "reg 与 claude 端口不能相同"});
    scheduler.regProxyPort = nextReg; scheduler.claudeProxyPort = nextClaude; scheduler.saveSettings();
    // GPT 不再起独立 vless。Claude 端口变了且还在跑则用新端口重启。
    try { if (scheduler.claudeXrayVless) { const r = startXray(scheduler.claudeXrayVless, {name: "claude", localPort: scheduler.claudeProxyPort, binPath: scheduler.xrayBinPath || undefined}); scheduler.claudeProxy = `socks5://127.0.0.1:${r.port}`; } } catch { /* */ }
    scheduler.saveSettings();
    res.json({ok: true, regProxyPort: scheduler.regProxyPort, claudeProxyPort: scheduler.claudeProxyPort, regProxy: scheduler.regProxy, claudeProxy: scheduler.claudeProxy});
});
app.post("/api/control/claude-xray", (req, res) => {
    const vlessUrl = String(req.body?.vlessUrl || "").trim();
    if (!vlessUrl) return res.status(400).json({error: "缺少 vless 链接"});
    try {
        const r = startXray(vlessUrl, {name: "claude", localPort: scheduler.claudeProxyPort, binPath: scheduler.xrayBinPath || undefined});
        scheduler.claudeXrayVless = vlessUrl; scheduler.claudeProxy = `socks5://127.0.0.1:${r.port}`; scheduler.saveSettings();
        res.json({ok: true, xray: xrayStatus("claude"), claudeProxy: scheduler.claudeProxy});
    } catch (e: any) { res.status(400).json({error: String(e?.message ?? e)}); }
});
app.post("/api/control/claude-xray/stop", (req, res) => { stopXray("claude"); scheduler.claudeXrayVless = ""; scheduler.saveSettings(); res.json({ok: true, xray: xrayStatus("claude")}); });
// 邮箱/GPT 共用跳板：每条 vless 起一个独立 xray（10811 起），不占用用户 10808。
async function applyJumpXray(vlessUrl: string) {
    const v = String(vlessUrl || "").trim();
    if (!isVlessUrl(v)) throw new Error("跳板要 vless:// ，我会自己起 xray");
    const have = (scheduler.mailJumpPool || []).includes(v);
    if (!have) {
        scheduler.mailJumpPool = [...(scheduler.mailJumpPool || []), v];
        scheduler.gptJumpPool = [...(scheduler.gptJumpPool || []), v];
    }
    scheduler.jumpXrayVless = v;
    await scheduler.ensureJumpFleet();
    scheduler.saveSettings();
    const row = (scheduler.jumpFleet || []).find((f) => f.vless === v) || (scheduler.jumpFleet || [])[0];
    return {
        xray: row
            ? {running: !!row.running, port: row.port, node: row.node, vless: row.vless, pid: 0, error: row.error || ""}
            : xrayStatus("jump"),
        jump: row?.socks || "",
        jumpPool: scheduler.jumpPoolSnapshot(),
    };
}
app.post("/api/control/jump-xray", async (req, res) => {
    const vlessUrl = String(req.body?.vlessUrl || scheduler.jumpXrayVless || "").trim();
    if (!vlessUrl) return res.status(400).json({error: "缺少 vless 链接"});
    try { res.json({ok: true, ...await applyJumpXray(vlessUrl)}); }
    catch (e: any) { res.status(400).json({error: String(e?.message ?? e)}); }
});
app.post("/api/control/jump-xray/stop", (req, res) => {
    stopJumpFleet();
    scheduler.jumpXrayVless = "";
    scheduler.jumpFleet = [];
    scheduler.saveSettings();
    res.json({ok: true, xray: xrayStatus("jump"), xrays: listJumpXrays()});
});
// 删除 Claude 账号(始终软删邮箱)
app.delete("/api/claude/accounts/:id", async (req, res) => {
    const id = Number(req.params.id);
    if (scheduler.isRunning(id, "claude")) return res.status(409).json({error: "运行中，无法删除"});
    await db.deleteClaudeAccount(id);
    broadcast("claude", {stats: await db.claudeStats()}); broadcast("mailboxes", {stats: await db.mailboxStats()});
    res.json({ok: true});
});
// 重跑单个 failed/异常 Claude 号:重置为 pending(清 error/时间戳)→ 未暂停则立即进注册队列
app.post("/api/claude/accounts/:id/retry", async (req, res) => {
    const id = Number(req.params.id);
    const acc = await db.getClaudeAccount(id);
    if (!acc) return res.status(404).json({error: "账号不存在"});
    if (scheduler.isRunning(id, "claude")) return res.status(409).json({error: "正在运行中"});
    await db.resetClaudeToPending(id);
    scheduler.tick(); // 未暂停则立即认领重跑
    broadcast("claude", {stats: await db.claudeStats()});
    res.json({ok: true});
});
// Claude 批次列表(筛选用)
app.get("/api/claude/batches", async (req, res) => res.json(await db.claudeBatches()));
// Claude 批量删除(运行中跳过;始终软删邮箱)
app.post("/api/claude/batch-delete", async (req, res) => {
    const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(Number) : [];
    let n = 0, skipped = 0;
    for (const id of ids) { if (scheduler.isRunning(id, "claude")) { skipped += 1; continue; } try { await db.deleteClaudeAccount(id); n += 1; } catch { /* ignore */ } }
    broadcast("claude", {stats: await db.claudeStats()}); broadcast("mailboxes", {stats: await db.mailboxStats()});
    res.json({ok: true, count: n, skipped});
});
// Claude 选中导出(邮箱----密码----sessionKey----org_id)+ 可选标记已售出。返回纯文本供前端 blob 下载
app.post("/api/claude/export/selected", async (req, res) => {
    const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(Number) : [];
    const accs = (await Promise.all(ids.map((id) => db.getClaudeAccount(id)))).filter(Boolean);
    const text = accs.map((a) => `${a.email}----${a.password}----${a.session_key || ""}----${a.org_id || ""}`).join("\n");
    if (req.body?.markSold && accs.length) { await db.markClaudeSold(accs.map((a) => a.id)); broadcast("claude", {stats: await db.claudeStats()}); }
    res.type("text/plain").send(text);
});
// 读 Claude auth 数据(DB JSONB 优先，回退文件)
function readClaudeAuth(acc) { return getAuthData(acc); }
// Claude 域日志(独立表 claude_logs,与邮箱/GPT 日志分开)+ SSE。id=claude_accounts.id
function logClaude(id, line) { db.appendClaudeLog(id, line).catch(() => {}); broadcast("claudeLog", {id, line, ts: Date.now()}); }
// Claude 账号操作日志(注册/查订阅/养号)
app.get("/api/claude/accounts/:id/logs", async (req, res) => res.json(await db.listClaudeLogs(Number(req.params.id))));
// 查存活 + 订阅/claude_code(比特浏览器注入 sessionKey 过 CF)。后台跑,SSE 推每号结果。ids=claude_account id
app.post("/api/claude/query", async (req, res) => {
    const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(Number) : [];
    const accs = (await Promise.all(ids.map((id) => db.getClaudeAccount(id)))).filter((a) => a && (a.auth_data || a.auth_file));
    if (!accs.length) return res.json({ok: true, count: 0, msg: "无可查账号(需注册成功且有 auth 数据)"});
    res.json({ok: true, count: accs.length});
    (async () => {
        await runPool(accs, async (a) => {
            const auth = readClaudeAuth(a);
            if (!auth) { await db.setClaudeInfo(a.id, {alive: false}); broadcast("claude", {stats: await db.claudeStats(), result: {id: a.id, email: a.email, alive: false, reason: "无 auth 数据"}}); return; }
            logClaude(a.id, "[订阅] 查存活/套餐(比特浏览器过 CF)…");
            try {
                const r = await queryClaudeInfo(auth, {proxyUrl: scheduler.claudeProxy || scheduler.regProxy, log: (m) => logClaude(a.id, `[订阅] ${m}`)});
                await db.setClaudeInfo(a.id, {plan: r.plan || "", claudeCode: r.claudeCode || "", alive: !!r.alive});
                logClaude(a.id, r.alive ? `[订阅] ✓ ${r.plan} · claude_code=${r.claudeCode} · tier=${r.tier}` : `[订阅] ✗ ${r.reason}`);
                broadcast("claude", {stats: await db.claudeStats(), result: {id: a.id, email: a.email, ...r}});
            } catch (e) { await db.setClaudeInfo(a.id, {alive: false}); broadcast("claude", {stats: await db.claudeStats(), result: {id: a.id, email: a.email, alive: false, reason: String(e?.message || e).slice(0, 60)}}); }
        }, 2);
        broadcast("claude", {stats: await db.claudeStats()});
    })();
});
// ---- 扫邮箱检测账号是否禁用(双重判定:先扫邮箱找 Anthropic 禁用通知[快],未命中再 API 探测存活[准]) ----
// 只在"明确证据"下置 dead_at:邮件命中 / API 明确 alive=false。API 异常仅记存疑,不误标(避免把好号当废号)。
async function scanOneClaudeDisabled(a) {
    // 1) 邮箱扫描(轻量,缓存会话秒级)。命中禁用通知邮件即判定,且只标 dead_at(保留已有 plan/claude_code)。
    logClaude(a.id, "[禁用检测] 扫邮箱找 Anthropic 禁用/封号通知…");
    try {
        const mail = await scanClaudeDisabledMail(a.email, a.password, {log: (m) => logClaude(a.id, `[禁用检测] ${m}`)});
        if (mail.hit) {
            await db.setClaudeDeadAt(a.id, Date.now()); // 只置失效时间,不动 plan/claude_code
            const reason = `禁用通知邮件(${mail.via}): ${(mail.subject || "").slice(0, 80)}`;
            logClaude(a.id, `[禁用检测] ❌ 判定禁用 — ${reason}`);
            return {id: a.id, email: a.email, alive: false, reason, source: "mail"};
        }
    } catch (e) { logClaude(a.id, `[禁用检测] 扫邮箱异常 ${String(e?.message || e).slice(0, 60)}(转 API 探测)`); }
    // 2) API 探测(准,慢:比特浏览器过 CF)。需 auth 文件;无则仅凭邮箱无法确证,判存疑不改状态。
    const auth = readClaudeAuth(a);
    if (!auth) {
        logClaude(a.id, "[禁用检测] 无 auth 数据,邮箱未见禁用 → 存疑(无法 API 探测,不改状态)");
        return {id: a.id, email: a.email, alive: null, reason: "邮箱无禁用邮件;无 auth 无法 API 探测", source: "mail-only"};
    }
    logClaude(a.id, "[禁用检测] 邮箱未见禁用 → API 探测存活(比特浏览器过 CF)…");
    try {
        const r = await queryClaudeInfo(auth, {proxyUrl: scheduler.claudeProxy || scheduler.regProxy, log: (m) => logClaude(a.id, `[禁用检测] ${m}`)});
        await db.setClaudeInfo(a.id, {plan: r.plan || "", claudeCode: r.claudeCode || "", alive: !!r.alive}); // API 探测本就更新套餐,一并回写
        logClaude(a.id, r.alive ? `[禁用检测] ✅ 存活 · ${r.plan || "?"} · claude_code=${r.claudeCode || "?"}` : `[禁用检测] ❌ 判定禁用 — API: ${r.reason || "不存活"}`);
        return {id: a.id, email: a.email, alive: !!r.alive, reason: r.reason, plan: r.plan, claudeCode: r.claudeCode, source: "api"};
    } catch (e) {
        // API 异常(网络/CF/比特未开)不等于禁用 → 存疑,不改 dead_at,避免误杀
        const reason = String(e?.message || e).slice(0, 60);
        logClaude(a.id, `[禁用检测] ⚠ API 探测异常(不改状态,存疑):${reason}`);
        return {id: a.id, email: a.email, alive: null, reason, source: "api-error"};
    }
}
// 单个检测:后台跑,结果走 SSE(claude 事件 result + claudeLog 实时日志)
app.post("/api/claude/accounts/:id/scan-disabled", async (req, res) => {
    const id = Number(req.params.id);
    const a = await db.getClaudeAccount(id);
    if (!a) return res.status(404).json({error: "账号不存在"});
    res.json({ok: true});
    (async () => {
        const result = await scanOneClaudeDisabled(a);
        broadcast("claude", {stats: await db.claudeStats(), result});
    })();
});
// 批量检测:选中账号并发 2(混浏览器探测,与查订阅一致),SSE 推 claudeScan 进度 + 每号 claude.result。可停止。
let scanDisabledRunning = false, scanDisabledStop = false;
app.post("/api/claude/scan-disabled", async (req, res) => {
    const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(Number) : [];
    const accs = (await Promise.all(ids.map((id) => db.getClaudeAccount(id)))).filter(Boolean);
    if (!accs.length) return res.json({ok: true, count: 0, msg: "无可检测账号"});
    if (scanDisabledRunning) return res.status(409).json({error: "已有禁用检测在跑"});
    res.json({ok: true, count: accs.length});
    scanDisabledRunning = true; scanDisabledStop = false;
    (async () => {
        let done = 0;
        broadcast("claudeScan", {running: true, done, total: accs.length});
        await runPool(accs, async (a) => {
            if (scanDisabledStop) return;
            try { const result = await scanOneClaudeDisabled(a); broadcast("claude", {stats: await db.claudeStats(), result}); }
            catch (e) { logClaude(a.id, `[禁用检测] 异常 ${String(e?.message || e).slice(0, 60)}`); }
            done += 1;
            broadcast("claudeScan", {running: true, done, total: accs.length});
        }, 2);
        scanDisabledRunning = false;
        broadcast("claudeScan", {running: false, done, total: accs.length});
        broadcast("claude", {stats: await db.claudeStats()});
    })();
});
app.post("/api/claude/scan-disabled/stop", (req, res) => { scanDisabledStop = true; res.json({ok: true}); });
// 养号:对选中 Claude 账号发一条消息(completion)
app.post("/api/claude/chat", async (req, res) => {
    const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(Number) : [];
    const message = String(req.body?.message || "").trim();
    const accs = (await Promise.all(ids.map((id) => db.getClaudeAccount(id)))).filter((a) => a && (a.auth_data || a.auth_file));
    if (!accs.length) return res.json({ok: true, count: 0, msg: "无可养号账号"});
    res.json({ok: true, count: accs.length});
    (async () => {
        await runPool(accs, async (a) => {
            const auth = readClaudeAuth(a); if (!auth) return;
            logClaude(a.id, "[养号] 发消息…");
            try { const r = await claudeChat(auth, {proxyUrl: scheduler.claudeProxy || scheduler.regProxy, log: (m) => logClaude(a.id, `[养号] ${m}`)}, message || undefined); logClaude(a.id, r.ok ? "[养号] ✓ 已回复" : `[养号] ✗ ${r.reason || "HTTP " + r.status}`); }
            catch (e) { logClaude(a.id, `[养号] 异常 ${String(e?.message || e).slice(0, 60)}`); }
        }, 2);
    })();
});

app.get("/api/accounts", async (req, res) => res.json(await db.listAccounts(req.query.status, false, req.query.deleted === '1')));
app.get("/api/accounts/:id", async (req, res) => { const id = Number(req.params.id); const a = Number.isInteger(id) ? await db.getAccount(id) : null; return a ? res.json(a) : res.status(404).json({error: "账号不存在"}); });
app.get("/api/accounts/:id/logs", async (req, res) => res.json(await db.listLogs(Number(req.params.id))));
// GPT 域收件箱已迁至邮箱管理(GET /api/mailboxes/:id/inbox|/mail/:mailId/body,覆盖所有邮箱)
app.post("/api/accounts/:id/retry", (req, res) => res.json({ok: scheduler.retry(Number(req.params.id))}));
// 编辑账号记录(修正/整理本地库字段,不触发真邮箱改密)。支持编辑全部可改字段 + 失效/已售开关。
app.patch("/api/accounts/:id", async (req, res) => {
    const id = Number(req.params.id);
    const acc = await db.getAccount(id);
    if (!acc) return res.status(404).json({error: "账号不存在"});
    if (scheduler.isRunning(id)) return res.status(409).json({error: "运行中，无法编辑"});
    const b = req.body || {};
    const fields = {};
    for (const k of ["email", "password", "status", "plan", "phone", "card", "at_status", "rt_status", "chat_status", "error", "gpt_password", "totp_secret", "mfa_status"]) {
        if (typeof b[k] === "string") fields[k] = b[k].trim();
    }
    if (typeof b.dead === "boolean") fields.dead_at = b.dead ? (acc.dead_at || Date.now()) : 0; // 失效开关
    if (typeof b.sold === "boolean") fields.sold_at = b.sold ? (acc.sold_at || Date.now()) : 0; // 已售开关
    try {
        if (Object.keys(fields).length) await db.updateAccount(id, fields);
    } catch (e) {
        return res.status(400).json({error: `更新失败(邮箱可能重复): ${e?.message || e}`});
    }
    broadcast("snapshot", await db.listAccounts());
    res.json({ok: true, account: await db.getAccount(id)});
});
const pwStamp = () => { const d = new Date(); const p = (n) => String(n).padStart(2, "0"); return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`; };
// 真·改 mail.com 邮箱密码(Playwright 操作 Wicket 改密表单),成功后同步 DB。
// body.newPassword 留空则随机生成 20 位(大小写+数字)。
// GPT 域邮箱改密(单个/确认)已移除:所有邮箱改密统一在邮箱管理(POST /api/mailboxes/:id/change-passwd + 批量)
// 批量删除:删除选中的号(运行中的跳过,连日志一起删)。
app.post("/api/accounts/batch-delete", async (req, res) => {
    const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(Number) : [];
    if (!ids.length) return res.status(400).json({error: "未选择账号"});
    let n = 0, skipped = 0;
    for (const id of ids) {
        if (scheduler.isRunning(id)) { skipped += 1; continue; } // 运行中不删
        try { await db.deleteAccount(id); n += 1; } catch (_) { /* ignore */ }
    }
    broadcast("snapshot", await db.listAccounts());
    broadcast("stats", await db.stats());
    broadcast("mailboxes", {stats: await db.mailboxStats()}); // 邮箱可能退回 free 池 → 刷新邮箱管理
    res.json({ok: true, count: n, skipped});
});
// 批量设置批次:给选中号打/改/清批次名(便于分组筛选、导出)。
app.post("/api/accounts/set-batch", async (req, res) => {
    const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(Number) : [];
    const batch = String(req.body?.batch || "").trim();
    if (!ids.length) return res.status(400).json({error: "未选择账号"});
    let n = 0;
    for (const id of ids) { try { await db.updateAccount(id, {batch}); n += 1; } catch (_) { /* ignore */ } }
    broadcast("snapshot", await db.listAccounts());
    res.json({ok: true, count: n});
});
// 批量设置售出状态:sold=true 标已售出,false 改回未售出(误标/退回重新上架用)。
app.post("/api/accounts/set-sold", async (req, res) => {
    const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(Number).filter(Number.isInteger) : [];
    const sold = req.body?.sold !== false;
    if (!ids.length) return res.status(400).json({error: "未选择账号"});
    const count = await db.markSold(ids, sold);
    broadcast("snapshot", await db.listAccounts());
    broadcast("stats", await db.stats());
    res.json({ok: true, count, sold});
});
// ========== 批量改密引擎(双模式:队列模式 + 直跑模式) ==========
// 队列模式(batch-change-passwd):任务入 pw_queue 表,各实例 FOR UPDATE SKIP LOCKED 认领,多实例并行。
// 直跑模式(startBatchPasswd):内存列表驱动,单实例,支持 onDone 回调(changePwFirst / 导入后改密)。
let batchPwRunning = false, batchPwStop = false;
const batchPwProg = {running: false, done: 0, total: 0, ok: 0, stopped: false};

// 邮箱改密结果写库(mailboxes 表)+ 广播
const mailboxPwApply = async (it, {ok, np, verified, detail}) => {
    const mb = await db.getMailbox(it.id);
    if (ok) await db.setMailboxPassword(it.id, np, `✅已改 ${pwStamp()}${verified ? "(验证)" : "?未验证"}`);
    else await db.setMailboxPassword(it.id, mb?.password ?? "", `❌试过 ${np}·${String(detail).slice(0, 30)}`);
    broadcast("mailboxes", {stats: await db.mailboxStats()});
};

// 执行单个改密(队列/直跑共用)
async function doPwChange(mailboxId, email, oldPw, forcedNp = "") {
    const np = String(forcedNp || "").trim() || randomPassword(20);
    const mb = await db.getMailbox(mailboxId);
    logMailbox(mailboxId, `[改密] 新密码=${np} provider=${mb?.provider || "mailcom"}`);
    try {
        const r = mb?.provider === "google"
            ? await changeGooglePasswordWithPool(mb, np, (m) => logMailbox(mailboxId, `[改密] ${m}`))
            : await changeMailcomPassword(email, oldPw, np, (m) => logMailbox(mailboxId, `[改密] ${m}`));
        const ok = !!r?.ok;
        await mailboxPwApply({id: mailboxId}, {ok, np, verified: r?.verified, detail: r?.detail || "失败"});
        logMailbox(mailboxId, ok ? `[改密] 成功` : `[改密] 失败(新密码 ${np} 已记录)`);
        return {ok, np, detail: r?.detail || ""};
    } catch (e) {
        await mailboxPwApply({id: mailboxId}, {ok: false, np, detail: String(e?.message || e)});
        logMailbox(mailboxId, `[改密] 异常(新密码 ${np} 已记录): ${e?.message || e}`);
        return {ok: false, np, detail: String(e?.message || e)};
    }
}

// ---- 队列模式:pw_queue 表驱动,多实例认领 ----
let pwQueueWorkerRunning = false, pwQueueStop = false;

async function broadcastPwProgress() {
    const prog = await db.pwQueueProgress();
    Object.assign(batchPwProg, {running: pwQueueWorkerRunning || batchPwRunning, done: prog.done, total: prog.total, ok: prog.done, stopped: false});
    broadcast("batchPw", {...batchPwProg});
}

async function startPwQueueWorker() {
    if (pwQueueWorkerRunning) return;
    pwQueueWorkerRunning = true; pwQueueStop = false;
    scheduler.acquireLock("batch-pw");
    await broadcastPwProgress();
    (async () => {
        const conc = scheduler.pwConcurrency || 1;
        while (!pwQueueStop) {
            const tasks = await db.claimPwTasks(db.instanceId, conc);
            if (!tasks.length) break;
            await runPool(tasks, async (t) => {
                if (pwQueueStop) return;
                const r = await doPwChange(t.mailbox_id, t.email, t.old_pw);
                await db.completePwTask(t.id, r.ok, r.np, r.detail);
                await broadcastPwProgress();
            }, conc);
        }
        pwQueueWorkerRunning = false;
        scheduler.releaseLock("batch-pw"); scheduler.tick();
        await broadcastPwProgress();
        console.log(`[队列改密] ${pwQueueStop ? "已停止" : "队列处理完毕"}`);
        pwQueueStop = false;
    })();
}

// 改密已并入 mail_jobs，不再从 pw_queue 拉活
// （启动时 drainPendingPwQueueToMailJobs 会把残留 pending 迁走）

// 入口:选中邮箱 → 入队 → 启动本实例 worker
app.post("/api/mailboxes/batch-change-passwd", async (req, res) => {
    const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(Number) : [];
    const mbs = (await Promise.all(ids.map((id) => db.getMailbox(id)))).filter(Boolean);
    if (!mbs.length) return res.json({ok: true, count: 0, msg: "未选择有效邮箱"});
    await beginMailQueue();
    const enq = await db.enqueueMailJobs(mbs.map((m) => ({id: m.id, email: m.email, payload: {oldPw: m.password}})), "pw");
    afterMailEnqueue();
    res.json({ok: true, count: enq.inserted, skipped: mbs.length - enq.inserted, queued: true});
});

// 停止:暂停认领 + 取消排队 + 中止本机 running
app.post("/api/control/batch-passwd/stop", async (req, res) => {
    const r = await stopAllMailJobs();
    res.json({ok: true, cancelled: r.canceled, closed: r.closed});
});

// 清理已完成的改密队列
app.post("/api/control/pw-queue/clear", async (req, res) => {
    await db.clearPwQueue();
    await broadcastPwProgress();
    res.json({ok: true});
});

app.post("/api/control/pw-concurrency", (req, res) => res.json({ok: true, pwConcurrency: scheduler.setPwConcurrency(req.body?.pwConcurrency)}));

// ---- 直跑模式(changePwFirst / 导入后改密):内存列表,单实例,支持 onDone 回调 ----
function startBatchPasswd(items, apply, tag = "批量改密", onDone) {
    const lockOwner = scheduler.maintLock;
    batchPwRunning = true; batchPwStop = false;
    Object.assign(batchPwProg, {running: true, done: 0, total: items.length, ok: 0, stopped: false});
    broadcast("batchPw", {...batchPwProg});
    (async () => {
        let done = 0, okc = 0;
        const conc = scheduler.pwConcurrency || 1;
        await runPool(items, async (it) => {
            if (batchPwStop) return;
            const r = await doPwChange(it.id, it.email, it.oldPw);
            if (r.ok) okc++;
            done += 1;
            Object.assign(batchPwProg, {done, ok: okc});
            broadcast("batchPw", {...batchPwProg});
        }, conc);
        const stopped = batchPwStop;
        batchPwRunning = false; batchPwStop = false;
        Object.assign(batchPwProg, {running: false, done, ok: okc, stopped});
        broadcast("batchPw", {...batchPwProg});
        console.log(`[${tag}] ${stopped ? "已停止" : "完成"} ${okc}/${items.length} 成功`);
        if (onDone) { try { onDone({done, ok: okc, stopped}); } catch (e) { console.warn(`[${tag}] onDone 异常:`, e?.message ?? e); } }
        if (lockOwner && scheduler.maintLock === lockOwner) { scheduler.releaseLock(lockOwner); scheduler.tick(); }
    })();
}
// 打开一个已登录 chatgpt 的真浏览器(注入该号 at 会话 sessionToken + CF cookie),供人工操作;不关闭,用户关窗口即断开。
const openedBrowsers = new Map(); // id -> browser(防 GC + 支持重开时关旧的)
app.post("/api/accounts/:id/open-browser", async (req, res) => {
    const id = Number(req.params.id);
    const acc = await db.getAccount(id);
    if (!acc) return res.status(404).json({error: "账号不存在"});
    const rec = getAuthData(acc);
    if (!rec) return res.status(400).json({error: "无 at 授权数据(该号可能未注册成功/未拿到 at)"});
    const sess = rec.session || rec;
    const auth = {sessionToken: sess.sessionToken || "", cookieString: rec.cookie || ""};
    if (!auth.sessionToken && !auth.cookieString) return res.status(400).json({error: "授权文件缺 sessionToken/cookie"});
    const old = openedBrowsers.get(id); // 关掉该号已开的旧浏览器
    if (old) { try { await old.close(); } catch { /* ignore */ } openedBrowsers.delete(id); }
    logAcct(id, "[浏览器] 注入 at 打开 chatgpt …");
    try {
        const browser = await openBrowserWithAuth(auth, scheduler.regProxy, (m) => logAcct(id, `[浏览器] ${m}`));
        openedBrowsers.set(id, browser);
        browser.on("disconnected", () => openedBrowsers.delete(id));
        res.json({ok: true});
    } catch (e) {
        logAcct(id, `[浏览器] 打开失败: ${e?.message || e}`);
        res.status(500).json({error: String(e?.message || e)});
    }
});
// 独立小工具:批量校验 mail.com 邮箱密码(试登录),可勾选验证通过后改密(随机20位)并返回新密码。不入库、不影响账号表。
app.post("/api/tools/mail-check", async (req, res) => {
    const items = Array.isArray(req.body?.items) ? req.body.items : [];
    const changePassword = !!req.body?.changePassword;
    if (!items.length) return res.status(400).json({error: "无输入(每行 邮箱----密码)"});
    const results = [];
    const CONC = changePassword ? 2 : 4; // 改密 headed 弹窗,并发压低;纯验证无头可高些
    let idx = 0;
    async function worker() {
        while (idx < items.length) {
            const i = idx; idx += 1;
            const email = String(items[i]?.email || "").trim();
            const password = String(items[i]?.password || "").trim();
            if (!email || !password) { results[i] = {email, ok: false, reason: "邮箱或密码为空"}; continue; }
            try {
                if (changePassword) {
                    const np = randomPassword(20);
                    const r = await changeMailcomPassword(email, password, np);
                    results[i] = r?.ok
                        ? {email, ok: true, changed: true, newPassword: np}
                        : {email, ok: false, changed: false, reason: r?.detail ? `登录成功但改密失败: ${String(r.detail).slice(0, 60)}` : "改密未成功"};
                } else {
                    const r = await verifyMailcomLogin(email, password);
                    results[i] = {email, ok: r.ok, reason: r.reason};
                }
            } catch (e) {
                results[i] = {email, ok: false, reason: String(e?.message || e).slice(0, 120)};
            }
        }
    }
    await Promise.all(Array.from({length: Math.min(CONC, items.length)}, () => worker()));
    res.json({results, changePassword});
});
app.delete("/api/accounts/:id", async (req, res) => {
    const id = Number(req.params.id);
    if (scheduler.isRunning(id)) return res.status(409).json({error: "运行中，无法删除"});
    await db.deleteAccount(id);
    broadcast("snapshot", await db.listAccounts());
    broadcast("stats", await db.stats());
    broadcast("mailboxes", {stats: await db.mailboxStats()}); // 邮箱可能退回 free 池 → 刷新邮箱管理
    res.json({ok: true});
});

app.post("/api/control/start", (req, res) => {
    if (req.body?.concurrency) scheduler.setConcurrency(req.body.concurrency);
    scheduler.start();
    res.json({ok: true, ...scheduler.state()});
});
app.post("/api/control/pause", (req, res) => { scheduler.pause(); res.json({ok: true, ...scheduler.state()}); });
app.post("/api/control/stop", (req, res) => { scheduler.stopAll(); res.json({ok: true, ...scheduler.state()}); });
app.post("/api/control/concurrency", (req, res) => res.json({ok: true, concurrency: scheduler.setConcurrency(req.body?.concurrency)}));
app.post("/api/control/otp", (req, res) => { scheduler.otpSingle = !!req.body?.single; scheduler.saveSettings(); res.json({ok: true, otpSingle: scheduler.otpSingle}); });
app.post("/api/control/mail-separator", (req, res) => { const s = String(req.body?.separator || "").trim(); if (!s) return res.status(400).json({error: "分隔符不能为空"}); scheduler.mailSeparator = s; scheduler.saveSettings(); res.json({ok: true, mailSeparator: scheduler.mailSeparator}); });
app.post("/api/control/chat", (req, res) => { scheduler.simulateChat = !!req.body?.simulate; scheduler.saveSettings(); res.json({ok: true, simulateChat: scheduler.simulateChat}); });
app.post("/api/control/sms", (req, res) => {
    if (typeof req.body?.enabled === "boolean") scheduler.smsEnabled = req.body.enabled;
    if (typeof req.body?.linkTemplate === "string") scheduler.smsLinkTemplate = req.body.linkTemplate.trim();
    if (typeof req.body?.maxBind === "number") scheduler.smsMaxBind = Math.max(0, Math.floor(req.body.maxBind)); // 每号绑定上限(0=不限)
    scheduler.saveSettings();
    res.json({ok: true, smsEnabled: scheduler.smsEnabled, smsLinkTemplate: scheduler.smsLinkTemplate, smsMaxBind: scheduler.smsMaxBind});
});
// 注册引擎:http(sentinel HTTP 模拟) / browser(真 Chrome 过 CF)
app.post("/api/control/engine", (req, res) => {
    const e = String(req.body?.engine || "").trim();
    if (e === "http" || e === "browser") { scheduler.regEngine = e; scheduler.saveSettings(); }
    res.json({ok: true, regEngine: scheduler.regEngine});
});
// delete-mailbox 开关已废弃，所有删除一律软删邮箱
app.post("/api/control/delete-mailbox", (_req, res) => {
    res.json({ok: true});
});
// 注册成功后是否额外走 codex OAuth 拿可续期 rt(强制 add-phone 接码，有成本)
app.post("/api/control/rt", (req, res) => {
    if (typeof req.body?.enabled === "boolean") scheduler.rtEnabled = req.body.enabled;
    scheduler.saveSettings();
    res.json({ok: true, rtEnabled: scheduler.rtEnabled});
});
app.post("/api/control/mfa", (req, res) => {
    if (typeof req.body?.enabled === "boolean") scheduler.mfaEnabled = req.body.enabled;
    scheduler.saveSettings();
    res.json({ok: true, mfaEnabled: scheduler.mfaEnabled !== false});
});

// 注册后自动改密已移除:邮箱改密全归邮箱管理域(导入后自动改密/手动/批量),注册流程不越界(职责归一化)。
// 浏览器引擎是否用比特浏览器(每号独立指纹窗口)。开启前探测比特 Local API 是否在跑。
app.post("/api/control/bit", async (req, res) => {
    if (req.body?.enabled === true) {
        const ok = await bitHealth();
        if (!ok) return res.status(400).json({error: "比特浏览器 Local API 未响应(127.0.0.1:54345)，请先打开比特客户端"});
    }
    if (typeof req.body?.enabled === "boolean") scheduler.bitBrowser = req.body.enabled;
    scheduler.saveSettings();
    res.json({ok: true, bitBrowser: scheduler.bitBrowser});
});

// ========== token 测试(at/rt) ==========
// 从凭证对象解析各类 token（不再直接读文件）
function extractTokens(d) {
    if (!d) return null;
    const s = (d && d.session) || {};
    const accessToken = s.accessToken || d.access_token || "";
    const refreshToken = d.refresh_token || "";
    let accountId = d.account_id || "";
    if (!accountId && accessToken) {
        const c = decodeJwt(accessToken) || {};
        accountId = (c["https://api.openai.com/auth"] || {}).chatgpt_account_id || "";
    }
    if (!accountId && s.account) accountId = s.account.account_id || s.account.id || "";
    return {accessToken, refreshToken, accountId, raw: d};
}
// 兼容：从文件路径读取 token（worker 产出的新文件尚未入 DB 时用）
function readAuthTokens(authFile) {
    const d = readJsonFileSafe(authFile);
    return d ? {...extractTokens(d), path: authFile} : null;
}
// 等待注册队列排空(running map 清空)。maintLock 设置后 tick 不再认领,等已跑的自然结束。
function waitRegIdle(): Promise<void> {
    if (scheduler.running.size === 0) return Promise.resolve();
    return new Promise((resolve) => {
        const check = () => { if (scheduler.running.size === 0) { scheduler.removeListener("stats", check); resolve(); } };
        scheduler.on("stats", check); // onExit → emit("stats") → check
    });
}

// 简单并发池
async function runPool(items, worker, concurrency = 6) {
    let i = 0;
    const runners = Array.from({length: Math.min(concurrency, items.length || 1)}, async () => {
        while (i < items.length) { const idx = i++; try { await worker(items[idx]); } catch { /* 单个失败不影响整体 */ } }
    });
    await Promise.all(runners);
}
// 默认全部 success 账号；传 ids 则只测选中的
async function pickAccounts(ids) {
    if (Array.isArray(ids) && ids.length) return (await Promise.all(ids.map((id) => db.getAccount(Number(id))))).filter(Boolean);
    return await db.listAccounts("success");
}
// 写状态 + SSE 推整行(前端 status 事件已合并进表格)
async function pushTestStatus(id, kind, status) {
    await db.setTestStatus(id, kind, status);
    broadcast("status", {id, ...(await db.getAccount(id))});
}
// relogin=true:at 失效时走【完整浏览器登录流程】重新拿 at(headed,慢)。单点测 at / 定时保活(串行) 均可用;批量快速探测用 false。
// at 确认存活 → 若该号被定格"已失效"(dead_at 非空),清除并刷新前端。存活的号绝不该停留在"已失效"。
// 只复活、不误杀(手动测 at 失败仍不判死,判死只在定时保活综合 at+rt)。
async function reviveIfAlive(id) {
    const a = await db.getAccount(id);
    if (a && a.dead_at) { await db.setDeadAt(id, 0); broadcast("status", {id, ...(await db.getAccount(id))}); }
}
// at 与 rt 解耦:测 at 只测 at,失效直接走浏览器登录重登,★不用 rt 去续 at。
async function testOneAt(acc, {relogin = false} = {}) {
    await pushTestStatus(acc.id, "at", "测试中…");
    const tok = extractTokens(getAuthData(acc));
    if (tok && tok.accessToken) {
        const r = await probeAt(tok.accessToken, tok.accountId, buildProxyDispatcher(scheduler.regProxy));
        if (r.ok) { await pushTestStatus(acc.id, "at", "✅有效"); await reviveIfAlive(acc.id); return r; }
        if (!relogin) { await pushTestStatus(acc.id, "at", "❌" + r.reason); return r; } // 不重登→只标记失效
    } else if (!relogin) { await pushTestStatus(acc.id, "at", "无at"); return {ok: false, reason: "无at"}; }
    // at 失效/无at 且 relogin → 直接走完整浏览器登录流程重新拿 at(不用 rt)
    await pushTestStatus(acc.id, "at", "at失效,走浏览器登录重新获取…");
    const re = await runReloginAtWorker(acc);
    if (!re.ok) { await pushTestStatus(acc.id, "at", "❌登录获取失败:" + String(re.reason || "").slice(0, 40)); return {ok: false, reason: re.reason}; }
    const fresh = readAuthTokens(re.authFile);
    const r2 = fresh && fresh.accessToken ? await probeAt(fresh.accessToken, fresh.accountId, buildProxyDispatcher(scheduler.regProxy)) : {ok: false, reason: "新 auth 无 at"};
    await pushTestStatus(acc.id, "at", r2.ok ? "✅有效(已重登)" : ("❌" + r2.reason));
    if (r2.ok) await reviveIfAlive(acc.id);
    return r2;
}
// 按需获取 rt：spawn worker-rt 走 codex OAuth(邮箱OTP + add-phone 接码)。preferPhone=复用已绑定号(过期重取)。
// mailcom provider 收邮箱 OTP 需临时单行池文件(email----邮箱密码)，与注册 worker 同套。
// test worker(rt/chat)日志:同时落库(db.appendLog)+SSE,以便事后在库里查失败过程(如 rt 的 add-phone/接码/400)
function logAcct(id, line) { db.appendLog(id, line).catch(() => {}); broadcast("log", {id, line, ts: Date.now()}); }
// 邮箱域操作日志(登录/改密/收信):写独立 mailbox_logs 表 + 独立 SSE 事件 mbLog,与 GPT 注册日志隔离,分别管理。
function logMailbox(id, line) { db.appendMailboxLog(id, line).catch(() => {}); broadcast("mbLog", {id, line, ts: Date.now()}); }
function runRtWorker(acc, preferPhone, {onProgress, timeoutMs = 180000} = {}) {
    return new Promise((resolve) => {
        let settled = false;
        let timer = null;
        const finish = (v) => { if (settled) return; settled = true; if (timer) clearTimeout(timer); resolve(v); };
        const note = (m) => { logAcct(acc.id, `[rt] ${m}`); try { onProgress?.(m); } catch { /* */ } };
        const tmpDir = mkdtempSync(path.join(os.tmpdir(), "codex-rt-"));
        const tmpFile = path.join(tmpDir, `mc-${acc.id}.txt`);
        writeMailboxTokenFile(tmpFile, {
            email: acc.email,
            password: acc.password,
            mailboxTotp: acc.mailbox_totp || "",
            recoveryEmail: acc.recovery_email || "",
            imapPassword: acc.mailbox_imap || "",
        });
        const useSessionRt = !!(acc.totp_secret || "").trim()
            || acc.provider === "mailcom"
            || /pro|plus|team/i.test(String(acc.plan || ""));
        const mailcomHeadless = process.env.MAILCOM_HEADED === "1" ? "0" : "1";
        const mailProxy = (scheduler.mailProxyEnabled !== false ? (scheduler.mailProxy || "") : "")
            || scheduler.rtProxy || scheduler.regProxy || "";
        note(`启动 worker 获取 refresh_token${useSessionRt ? "(会话换rt,不接码)" : ""}${preferPhone ? `(复用绑定号 +${preferPhone})` : ""}${acc.mailbox_imap ? " +IMAP" : ""}…`);
        const child = spawn(CHAT_TSX_BIN, [useSessionRt ? "scripts/worker-rt-nosms.ts" : "src/worker-rt.ts"], { shell: IS_WIN,
            cwd: CHAT_ROOT,
            env: {
                ...process.env,
                REG_EMAIL: acc.email,
                MAIL_PROVIDER: acc.provider || "mailcom",
                MAILCOM_TOKENS_FILE: tmpFile, ICLOUD_TOKENS_FILE: tmpFile,
                MAILCOM_HEADLESS: mailcomHeadless,
                SMS_LINK_TEMPLATE: scheduler.smsLinkTemplate || "",
                SMS_MAX_BIND: String(scheduler.smsMaxBind ?? 0),
                RT_PREFER_PHONE: preferPhone || "",
                PROXY_URL: scheduler.rtProxy || scheduler.regProxy || "",
                MAILCOM_PROXY: mailProxy,
                GPT_PASSWORD: (acc.gpt_password || appConfig.defaultPassword || "").trim(),
                TOTP_SECRET: acc.totp_secret || "",
                // PG 迁移后 worker 通过 process.env.DATABASE_URL 继承连接
            },
        });
        timer = setTimeout(() => {
            try { child.kill("SIGKILL"); } catch { /* */ }
            note(`超时(${Math.round(timeoutMs / 1000)}s)，已杀掉 worker`);
            finish({ok: false, reason: `超时(${Math.round(timeoutMs / 1000)}s)，取码/OAuth卡住`});
        }, timeoutMs);
        let buf = "";
        let result = null;
        child.on("error", async (e) => {
            try { rmSync(tmpDir, {recursive: true, force: true}); } catch { /* ignore */ }
            await pushTestStatus(acc.id, "rt", "❌启动失败:" + (e?.message ?? e));
            finish({ok: false, reason: String(e?.message || e)});
        });
        child.stdout.on("data", (d) => {
            buf += d.toString();
            let idx;
            while ((idx = buf.indexOf("\n")) >= 0) {
                const line = buf.slice(0, idx); buf = buf.slice(idx + 1);
                if (line.startsWith("@@EVENT@@")) {
                    try {
                        const ev = JSON.parse(line.slice(9));
                        if (ev.type === "progress") note(ev.message);
                        else if (ev.type === "result") result = ev;
                    } catch { /* ignore */ }
                } else if (line.trim()) note(line.trim());
            }
        });
        child.stderr.on("data", (d) => {
            const msg = String(d).trim();
            if (msg) note(`[stderr] ${msg.slice(0, 160)}`);
        });
        child.on("close", async () => {
            try { rmSync(tmpDir, {recursive: true, force: true}); } catch { /* ignore */ }
            if (settled) return;
            if (result && result.status === "success") {
                const rtData = readJsonFileSafe(result.rtFile);
                await db.setAccountRtFile(acc.id, result.rtFile || "", rtData);
                if (result.phone) await db.setAccountPhone(acc.id, result.phone);
                if (result.card) await db.setAccountCard(acc.id, result.card);
                await pushTestStatus(acc.id, "rt", "✅已获取rt");
                scheduler.emit("sms", {stats: await db.smsStats()});
                const tok = extractTokens(rtData);
                const plan = await syncAccountPlan(acc, tok?.accessToken, tok?.accountId);
                if (plan) note(`套餐 → ${plan}`);
                finish({ok: true, refresh_token: result.rt, plan_type: plan || ""});
            } else {
                const reason = result?.error || "获取失败";
                await pushTestStatus(acc.id, "rt", "❌获取失败:" + String(reason).slice(0, 60));
                finish({ok: false, reason});
            }
        });
    });
}

// 充值页代理:rtProxy 优先,空则回退注册代理。重登/验卡浏览器与 RT 刷新共用。
function rechargeProxy() {
    return scheduler.rtProxy || scheduler.regProxy || "";
}

/** Playwright/Chromium 不支持 socks5 账密；链式 kookeey 本地转发仍带 user:pass，不能给 mail.com。 */
function proxyHasSocksAuth(raw) {
    try {
        const cleaned = String(raw || "").trim().replace(/#.*$/, "");
        if (!cleaned) return false;
        const u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(cleaned) ? cleaned : `socks5://${cleaned}`);
        return u.protocol.startsWith("socks") && !!(u.username || u.password);
    } catch {
        return /socks[^:]*:\/\/[^/@]+@/i.test(String(raw || ""));
    }
}

/** mail.com 收码专用：只要无账密 socks/http（优先配置的 mailProxy → 充值代理 10808）。 */
function pickMailcomBrowserProxy(...candidates) {
    for (const c of candidates) {
        const u = String(c || "").trim();
        if (!u) continue;
        if (proxyHasSocksAuth(u)) continue;
        return u;
    }
    return "";
}

/**
 * 与邮箱整备同款：从 GPT 代理池租一条（1 代理 = 1 任务 · 新 sticky session）。
 * 池空则 fallback 充值代理；池满超时则回退充值代理，不堵死换绑。
 * 协议重登/authorize 429 靠换出口，不能全挤在 10808 一条线上。
 */
async function withLeasedGptProxy(owner, fn, {timeoutMs = 45_000, log} = {}) {
    const who = String(owner || "gpt-relogin");
    let jumpLease = null;
    let lease = null;
    const runFallback = async (why) => {
        const proxyUrl = rechargeProxy() || "";
        try { log?.(`GPT 代理池${why}，回退充值代理 ${maskProxyUrl(proxyUrl) || "直连"}`); } catch { /* */ }
        return fn(proxyUrl, "");
    };
    try {
        if (gptJumpPool.urls.length) {
            jumpLease = await gptJumpPool.lease(who, {timeoutMs: Math.min(timeoutMs, 20_000), maxPerJump: JUMP_MAX_EXITS});
        }
        lease = await gptProxyPool.lease(who, {
            fallback: rechargeProxy(),
            maxPerTemplate: 1,
            freshSession: true,
            timeoutMs,
        });
        const proxyUrl = lease.url || rechargeProxy() || "";
        const jumpUrl = jumpLease?.url || scheduler.gptProxyJump || "";
        try {
            log?.(`GPT 代理池 ${maskProxyUrl(proxyUrl) || "直连"}${jumpUrl ? " · 跳板 " + maskProxyUrl(jumpUrl) : ""}（一号一代理 · 新 session）`);
        } catch { /* */ }
        return await fn(proxyUrl, jumpUrl);
    } catch (e) {
        const msg = String(e?.message || e);
        if (/代理池全忙|等待超时/i.test(msg)) return runFallback("忙");
        // 无可用槽且无 fallback 时 lease 也可能抛别的错
        if (!rechargeProxy() && !scheduler.gptProxyPool?.length) throw e;
        return runFallback(`租约失败(${msg.slice(0, 60)})`);
    } finally {
        try { lease?.release(); } catch { /* */ }
        try { jumpLease?.release(); } catch { /* */ }
    }
}

/** 连续这么久没有一条新日志才当卡住。还在跑、还在出日志就不杀。 */
function reloginIdleMs(_acc) {
    return 90_000;
}
// at 失效优先协议登录(密码/邮箱码/TOTP);协议失败再回退浏览器。
// opts.proxy=出口；opts.jump=跳板。有跳板时 wrap 成本机链式 SOCKS 再塞给 worker（与比特整备同套 proxy-chain）。
function spawnReloginWorker(acc, {proxy, jump = "", script = "src/worker-login-http.ts", timeoutMs = 0, skipMfa = false, onProgress} = {}) {
    return new Promise(async (resolve) => {
        let settled = false;
        let beatTimer = null;
        let chainClose = () => {};
        const note = (m) => {
            logAcct(acc.id, `[relogin-at] ${m}`);
            try { onProgress?.(m); } catch { /* */ }
        };
        const finish = (v) => {
            if (settled) return;
            settled = true;
            if (beatTimer) { clearInterval(beatTimer); beatTimer = null; }
            try { chainClose(); } catch { /* */ }
            resolve(v);
        };
        const tmpDir = mkdtempSync(path.join(os.tmpdir(), "codex-relogin-"));
        const tmpFile = path.join(tmpDir, `mc-${acc.id}.txt`);
        writeMailboxTokenFile(tmpFile, {
            email: acc.email,
            password: acc.password,
            mailboxTotp: acc.mailbox_totp || "",
            recoveryEmail: acc.recovery_email || "",
            imapPassword: acc.mailbox_imap || "",
        });
        // 换绑/重登收码默认无头；要看窗设 MAILCOM_HEADED=1。
        const mailcomHeadless = process.env.MAILCOM_HEADED === "1" ? "0" : "1";
        let exitProxy = (proxy !== undefined ? proxy : scheduler.regProxy) || "";
        const jumpUrl = String(jump || "").trim()
            || String(scheduler.gptProxyJump || scheduler.mailProxyJump || "").trim();
        // 出口是外网网关时：本机 → 跳板 → kookeey。之前只日志「租到跳板」，PROXY_URL 仍直连 gate，国内必超时。
        const exitHostLocal = (() => {
            try {
                const u = new URL(exitProxy.includes("://") ? exitProxy.split("#")[0] : `socks5://${exitProxy}`);
                return u.hostname === "127.0.0.1" || u.hostname === "localhost";
            } catch { return false; }
        })();
        if (exitProxy && jumpUrl && !exitHostLocal) {
            try {
                const {wrapExitThroughJump} = await import("../src/mail/proxy-chain.js");
                const wrapped = await wrapExitThroughJump(exitProxy, jumpUrl);
                note(`链式已接通 跳板 ${maskProxyUrl(jumpUrl)} → 出口 ${maskProxyUrl(exitProxy)} · 本机 :${wrapped.localPort}`);
                chainClose = wrapped.close;
                exitProxy = wrapped.url;
            } catch (e) {
                note(`跳板链式失败(${String(e?.message || e).slice(0, 80)})，仍直连出口（国内易超时）`);
            }
        } else if (exitProxy && !jumpUrl && !exitHostLocal) {
            note(`无跳板，直连出口 ${maskProxyUrl(exitProxy)}（国内访问 kookeey 常超时）`);
        }
        // OpenAI 协议登录：PROXY_URL 可用 kookeey 账密（undici socks 支持）
        // mail.com Playwright：绝不能带 socks 账密 → 用无账密本地充值代理（如 10808）
        const mailProxyConfigured = (scheduler.mailProxyEnabled !== false && scheduler.mailProxy)
            ? scheduler.mailProxy
            : "";
        const mailProxy = pickMailcomBrowserProxy(mailProxyConfigured, rechargeProxy());
        const viaJump = !!(jumpUrl && String(exitProxy).includes("127.0.0.1"));
        note(
            `邮箱密码用库内当前值 ${String(acc.password || "").slice(0, 4)}…(${String(acc.password || "").length}位)`
            + `${mailcomHeadless === "0" ? "；mail.com 有头" : "；mail.com 无头收码"}`
            + ` · GPT代理=${exitProxy ? maskProxyUrl(exitProxy) : "直连"}${viaJump ? "（经跳板）" : ""}`
            + ` · 收码代理=${mailProxy ? maskProxyUrl(mailProxy) : "直连"}`
            + (proxyHasSocksAuth(exitProxy) && !mailProxy ? "（警告：无可用无账密收码代理）" : ""),
        );
        let child;
        try {
            child = spawn(CHAT_TSX_BIN, [script], {
                shell: IS_WIN, cwd: CHAT_ROOT,
                env: {
                    ...process.env,
                    REG_EMAIL: acc.email,
                    MAIL_PROVIDER: acc.provider || "mailcom",
                    MAILCOM_TOKENS_FILE: tmpFile, ICLOUD_TOKENS_FILE: tmpFile,
                    MAILCOM_HEADLESS: mailcomHeadless,
                    PROXY_URL: exitProxy || "",
                    MAIL_PROXY_JUMP: jumpUrl,
                    MAILCOM_PROXY: mailProxy,
                    REG_SIMULATE_CHAT: "",
                    REG_TRY_RT: "0",
                    GPT_PASSWORD: (acc.gpt_password || appConfig.defaultPassword || "").trim(),
                    TOTP_SECRET: acc.totp_secret || "",
                    REG_TRY_MFA: skipMfa ? "0" : (acc.totp_secret ? "0" : "1"),
                },
            });
        } catch (e) {
            try { rmSync(tmpDir, {recursive: true, force: true}); } catch { /* */ }
            finish({ok: false, reason: `启动 worker 失败: ${e?.message || e}`});
            return;
        }
        let buf = "", result = null;
        let idleTimer = null, killTimer = null, stopping = false;
        const idleMs = timeoutMs > 0 ? timeoutMs : 90_000;
        const startedAt = Date.now();
        let lastChildAt = Date.now();
        const persistRelogin = async (late = false) => {
            if (!result || result.status !== "success" || !result.authFile) return null;
            const authData = readJsonFileSafe(result.authFile);
            const extra: any = {auth_file: result.authFile, auth_data: authData};
            if (result.totpSecret) { extra.totp_secret = result.totpSecret; extra.mfa_status = result.mfaStatus || "✅已绑"; }
            else if (result.mfaStatus) extra.mfa_status = result.mfaStatus;
            await db.updateAccount(acc.id, extra);
            const n = await db.updateQueueAuthByAccount(acc.id, extra.auth_file, extra.auth_data);
            if (n) await queueSync();
            broadcast("snapshot", await db.listAccounts());
            note(late
                ? (n ? "停掉后仍登成功，已补写 session（GPT + 充值队列）" : "停掉后仍登成功，已补写 session（GPT）")
                : (n ? "已写回最新 session（GPT + 充值队列）" : "已写回最新 session（GPT）"));
            return {ok: true, authFile: result.authFile, authData};
        };
        const armIdle = () => {
            if (idleTimer) clearTimeout(idleTimer);
            idleTimer = setTimeout(() => {
                if (settled) return;
                stopping = true;
                note(`连续 ${Math.round(idleMs / 1000)}s 没有新日志，判定卡住，先停 worker`);
                try { child.kill("SIGTERM"); } catch { /* */ }
                killTimer = setTimeout(() => {
                    try { child.kill("SIGKILL"); } catch { /* */ }
                    note("无响应，已杀 worker");
                    finish({ok: false, reason: `重登无响应(${Math.round(idleMs / 1000)}s 无日志)`});
                }, 15_000);
            }, idleMs);
        };
        const touch = () => {
            if (settled) return;
            lastChildAt = Date.now();
            if (stopping) {
                if (killTimer) { clearTimeout(killTimer); killTimer = null; }
                stopping = false;
                note("仍有进度，取消停止");
            }
            armIdle();
        };
        armIdle();
        beatTimer = setInterval(() => {
            if (settled) return;
            const elapsed = Math.round((Date.now() - startedAt) / 1000);
            const silent = Math.round((Date.now() - lastChildAt) / 1000);
            note(`仍在跑，已 ${elapsed}s（子进程 ${silent}s 无新步骤；mail.com 登录常见 30–90s）`);
        }, 12_000);
        child.on("error", (e) => note(`worker 启动失败: ${e?.message || e}`));
        child.stdout.on("data", (d) => {
            touch();
            buf += d.toString(); let idx;
            while ((idx = buf.indexOf("\n")) >= 0) {
                const line = buf.slice(0, idx); buf = buf.slice(idx + 1);
                if (line.startsWith("@@EVENT@@")) {
                    try { const ev = JSON.parse(line.slice(9)); if (ev.type === "progress") note(ev.message); else if (ev.type === "result") result = ev; } catch { /* ignore */ }
                } else if (line.trim()) note(line.trim().slice(0, 160));
            }
        });
        child.stderr.on("data", (d) => { touch(); note(`[err] ${String(d).slice(0, 160)}`); });
        child.on("close", async () => {
            if (idleTimer) clearTimeout(idleTimer);
            if (killTimer) clearTimeout(killTimer);
            if (beatTimer) clearInterval(beatTimer);
            try { chainClose(); } catch { /* */ }
            try { rmSync(tmpDir, {recursive: true, force: true}); } catch { /* ignore */ }
            const saved = await persistRelogin(settled);
            if (saved) {
                if (!settled) finish(saved);
                return;
            }
            if (settled) return;
            const err = result?.error || "登录获取 at 失败";
            if (/account_deactivated/i.test(err)) { await db.updateAccount(acc.id, {error: err}); broadcast("snapshot", await db.listAccounts()); }
            finish({ok: false, reason: err});
        });
        child.on("error", (e) => {
            if (idleTimer) clearTimeout(idleTimer);
            if (killTimer) clearTimeout(killTimer);
            if (beatTimer) clearInterval(beatTimer);
            try { chainClose(); } catch { /* */ }
            try { rmSync(tmpDir, {recursive: true, force: true}); } catch { /* */ }
            finish({ok: false, reason: String(e?.message ?? e)});
        });
    });
}
async function runReloginAtWorker(acc, {proxy, jump = "", timeoutMs = 0, allowBrowser = true, skipMfa = false, onProgress} = {}) {
    const note = (m) => { logAcct(acc.id, `[at] ${m}`); try { onProgress?.(m); } catch { /* */ } };
    note("走协议登录重新获取 at(密码/邮箱码/TOTP)…");
    const http = await spawnReloginWorker(acc, {proxy, jump, script: "src/worker-login-http.ts", timeoutMs, skipMfa, onProgress});
    if (http.ok || /account_deactivated/i.test(http.reason || "") || !allowBrowser) return http;
    note(`协议登录失败(${String(http.reason || "").slice(0, 80)}),回退浏览器…`);
    return spawnReloginWorker(acc, {proxy, jump, script: "src/worker-register-browser.ts", timeoutMs, skipMfa, onProgress});
}

/** 可换出口再试：网络抖动 / CF 403 / 429 / TLS 掐断 / fetch failed 等 */
function isReloginRetryable(reason) {
    return /429|403|authorize|chatgpt\.com|打开 OpenAI|Proxy connection|timed out|timeout|ECONN|ENOTFOUND|EPIPE|EHOST|network|socket|TLS|fetch failed|disconnected|secure TLS|超时|限流|Cloudflare|Just a moment/i
        .test(String(reason || ""));
}

/** authorize 出口被限流时才值得换 kookeey 池（换 IP）；纯网络/TLS/403 优先本地 10808 */
function isAuthorizeRateLimited(reason) {
    return /429|authorize 页|打开 OpenAI authorize|Retry-After|限流/i.test(String(reason || ""));
}

/**
 * 协议重登路径（undici 实测）：
 * - kookeey 经跳板：curl 能通，但 Node TLS 常 ECONNRESET / CF 403 → 不适合做默认
 * - 充值代理 10808：本地无账密 socks，协议登录最稳（此前能打到 authorize）
 * 顺序：先 10808 → 若 429 限流再换 GPT 池 sticky 出口 1～2 次
 */
async function runReloginAtWorkerPooled(acc, {
    proxy,
    jump,
    timeoutMs = 0,
    allowBrowser = true,
    skipMfa = false,
    onProgress,
    usePool = true,
} = {}) {
    const note = (m) => { try { onProgress?.(m); } catch { /* */ } };
    const defaultJump = jump || scheduler.gptProxyJump || scheduler.mailProxyJump || "";
    if (!usePool) {
        return runReloginAtWorker(acc, {
            proxy: proxy !== undefined ? proxy : rechargeProxy(),
            jump: "",
            timeoutMs, allowBrowser, skipMfa, onProgress,
        });
    }
    if (proxy !== undefined) {
        return runReloginAtWorker(acc, {
            proxy,
            jump: defaultJump,
            timeoutMs, allowBrowser, skipMfa, onProgress,
        });
    }

    // ① 默认：充值代理（10808），不经 kookeey 链式
    const localProxy = rechargeProxy();
    let last = {ok: false, reason: "未尝试"};
    if (localProxy) {
        note(`协议重登优先充值代理 ${maskProxyUrl(localProxy)}（本地无账密，避开 kookeey→Node TLS 被掐）`);
        last = await runReloginAtWorker(acc, {
            proxy: localProxy,
            jump: "",
            timeoutMs, allowBrowser, skipMfa, onProgress,
        });
        if (last?.ok) return last;
        note(`充值代理重登失败: ${String(last?.reason || "").slice(0, 100)}`);
    }

    // ② 仅当本地限流/网络仍可重试时，才上 GPT 池换出口（最多 2 次）
    if (!isReloginRetryable(last?.reason) && last?.reason !== "未尝试") return last;
    const maxPoolTries = isAuthorizeRateLimited(last?.reason) ? 2 : 1;
    for (let i = 0; i < maxPoolTries; i++) {
        note(`改走 GPT 代理池换出口（${i + 1}/${maxPoolTries}）…`);
        last = await withLeasedGptProxy(acc.email, async (proxyUrl, jumpUrl) => {
            note(`池出口 ${maskProxyUrl(proxyUrl)}${jumpUrl ? " + 跳板 " + maskProxyUrl(jumpUrl) : ""}`);
            return runReloginAtWorker(acc, {
                proxy: proxyUrl,
                jump: jumpUrl || defaultJump,
                timeoutMs, allowBrowser, skipMfa, onProgress,
            });
        }, {log: note, timeoutMs: 45_000});
        if (last?.ok) return last;
        if (i + 1 < maxPoolTries && isReloginRetryable(last?.reason)) {
            await new Promise((r) => setTimeout(r, 2_000 + Math.random() * 2_000));
            continue;
        }
        break;
    }
    return last;
}

// rt 三态：有效→刷新写回；已过期→复用绑定号重新获取；无rt→获取。acquire=false 时不自动获取(批量用，避免误耗接码)。
// 用刚拿到的 AT 查套餐,写回 gpt_accounts.plan + 充值队列 plan_type(有入队才改)。
async function syncAccountPlan(acc, accessToken, accountId = "") {
    if (!acc?.id || !accessToken) return "";
    try {
        const dispatcher = buildProxyDispatcher(rechargeProxy());
        const r = await probePlan(accessToken, accountId, dispatcher);
        if (!r.ok || !r.plan_type) return "";
        const plan = r.plan_type;
        if (plan !== acc.plan) await db.updateAccount(acc.id, {plan});
        const n = await db.updateRechargeQueuePlanByAccount(acc.id, plan);
        if (n) await queueSync();
        return plan;
    } catch { return ""; }
}

async function testOneRt(acc, {updateRt = true, acquire = false, onProgress} = {}) {
    await pushTestStatus(acc.id, "rt", "测试中…");
    const rtData = getRtData(acc);
    const tok = extractTokens(rtData || getAuthData(acc));
    const rtDispatcher = buildProxyDispatcher(scheduler.rtProxy || scheduler.regProxy);
    if (tok && tok.refreshToken) {
        let r = await refreshRt(tok.refreshToken, rtDispatcher);
        if (!r.ok) { // 失败重试一次:过滤网络/代理抖动,两次都失败才算过期(避免抖动误判 dead)
            await pushTestStatus(acc.id, "rt", "失败,重试中…");
            await new Promise((s) => setTimeout(s, 2500));
            r = await refreshRt(tok.refreshToken, rtDispatcher);
        }
        if (r.ok) {
            // 续期只写回【rt 文件本身】(更新 refresh_token/id_token),★绝不碰 at(auth_file 的网页 access_token)。
            // 且只在 rt 有独立 rt_file 时写(rt 若在 auth_file 里则不写,避免充值网页 at)。
            if (updateRt && r.tokens && tok?.raw && rtData) {
                try {
                    const rec = {...tok.raw};
                    if (r.tokens.access_token) rec.access_token = r.tokens.access_token;
                    if (r.tokens.refresh_token) rec.refresh_token = r.tokens.refresh_token;
                    if (r.tokens.id_token) rec.id_token = r.tokens.id_token;
                    rec.last_refresh = new Date().toISOString();
                    await db.updateRtData(acc.id, rec);
                    if (acc.rt_file) writeFileSync(acc.rt_file, JSON.stringify(rec) + "\n");
                } catch { /* 写回失败不影响测试结论 */ }
            }
            await pushTestStatus(acc.id, "rt", updateRt ? "✅有效(已续期)" : "✅有效");
            const plan = await syncAccountPlan(acc, r.tokens?.access_token, r.tokens?.account_id);
            if (plan) { logAcct(acc.id, `[rt] 套餐 → ${plan}`); return {...r, plan_type: plan}; }
            return r;
        }
        // rt 存在但刷新失败 = 过期/失效 → 复用绑定号重新获取
        if (!acquire) { await pushTestStatus(acc.id, "rt", "❌" + r.reason); return r; }
        await pushTestStatus(acc.id, "rt", "过期,重新获取中…");
        return runRtWorker(acc, acc.phone || "", {onProgress});
    }
    // 无 rt
    if (!acquire) { await pushTestStatus(acc.id, "rt", "无rt"); return {ok: false, reason: "无rt"}; }
    await pushTestStatus(acc.id, "rt", "无rt,获取中…");
    return runRtWorker(acc, acc.phone || "", {onProgress});
}
app.post("/api/accounts/:id/test-at", async (req, res) => {
    const acc = await db.getAccount(Number(req.params.id));
    if (!acc) return res.status(404).json({error: "账号不存在"});
    res.json(await testOneAt(acc, {relogin: true})); // 单点测 at:失效则走浏览器登录重新获取(批量/定时不走)
});
app.post("/api/control/enroll-mfa", async (req, res) => {
    const ids = (req.body?.ids || []).map(Number).filter(Number.isInteger);
    const accs = (await Promise.all(ids.map((id: number) => db.getAccount(id)))).filter(Boolean);
    if (!accs.length) return res.status(400).json({error: "未选择账号"});
    res.json({ok: true, count: accs.length});
    (async () => {
        for (const acc of accs) {
            let live = acc;
            let authRec = getAuthData(live);
            let tok = extractTokens(authRec);
            if (!tok?.accessToken) { logAcct(acc.id, "[2fa] 无 AT,跳过(请先重登或测 at)"); await db.updateAccount(acc.id, {mfa_status: "❌无AT"}); continue; }
            logAcct(acc.id, "[2fa] 绑定 TOTP…");
            const mfaProxy = scheduler.regProxy || scheduler.rtProxy || appConfig.defaultProxyUrl || process.env.PROXY_URL || process.env.ALL_PROXY || "";
            const r = await enrollTotp(tok.accessToken, {
                accountId: tok.accountId || decodeJwt(tok.accessToken)?.["https://api.openai.com/auth"]?.chatgpt_account_id || "",
                proxyUrl: mfaProxy,
                cookie: String(authRec?.cookie || "").trim(),
                retryAltProxy: true,
                browserFallback: process.env.MFA_NO_BROWSER !== "1",
                headless: true,
                log: (m) => logAcct(acc.id, "[2fa] " + m),
                // 官网 enroll 要求 pwd_auth_time 约 4 分钟内；过期则协议重登拿新 AT 再绑
                reauth: async () => {
                    logAcct(acc.id, "[2fa] 需重新密码登录以刷新 pwd_auth…");
                    const re = await runReloginAtWorkerPooled(live, {
                        allowBrowser: true,
                        skipMfa: true,
                        onProgress: (m) => logAcct(acc.id, `[2fa] 重登 ${String(m || "").slice(0, 120)}`),
                    });
                    if (!re?.ok) throw new Error(re?.reason || "重登失败");
                    live = await db.getAccount(acc.id) || live;
                    authRec = getAuthData(live);
                    tok = extractTokens(authRec);
                    if (!tok?.accessToken) throw new Error("重登后仍无 AT");
                    return {
                        accessToken: tok.accessToken,
                        accountId: tok.accountId || "",
                        cookie: String(authRec?.cookie || "").trim(),
                    };
                },
            });
            if (r.ok && r.secret) {
                await db.updateAccount(acc.id, {totp_secret: r.secret, mfa_status: "✅已绑"});
                logAcct(acc.id, `[2fa] ✅ 已绑定(${r.via || "http"})`);
            } else if (r.ok && r.already) {
                if (acc.totp_secret || live.totp_secret) {
                    await db.updateAccount(acc.id, {mfa_status: "✅已绑"});
                    logAcct(acc.id, "[2fa] 该号已有 2FA");
                } else {
                    await db.updateAccount(acc.id, {mfa_status: "⚠已有2FA缺密钥"});
                    logAcct(acc.id, "[2fa] 已有 2FA 但库中无 secret,需人工处理");
                }
            } else {
                await db.updateAccount(acc.id, {mfa_status: "❌" + (r.reason || "失败")});
                logAcct(acc.id, "[2fa] ❌ " + (r.reason || "失败"));
            }
            broadcast("status", {id: acc.id, ...(await db.getAccount(acc.id))});
        }
        broadcast("snapshot", await db.listAccounts());
    })();
});
app.post("/api/accounts/:id/test-rt", async (req, res) => {
    const acc = await db.getAccount(Number(req.params.id));
    if (!acc) return res.status(404).json({error: "账号不存在"});
    // 单号:默认 acquire=true(无rt/过期时自动获取，会耗接码);可传 acquire:false 只测不获取
    res.json(await testOneRt(acc, {updateRt: req.body?.updateRt !== false, acquire: req.body?.acquire !== false}));
});
let batchAtRunning = false, batchAtStop = false;
app.post("/api/control/test-at", async (req, res) => {
    const accs = await pickAccounts(req.body?.ids);
    const relogin = !!req.body?.relogin;
    if (!relogin) { res.json({ok: true, count: accs.length}); runPool(accs, (a) => testOneAt(a), 6); return; } // 并发快速探测(不登录)
    // 重登:at 失效走浏览器登录重新拿 at,与注册/其他维护互斥,后台跑、可停止
    if (batchAtRunning) return res.status(409).json({error: "已有批量重登在跑,请等待或先停止"});
    if (scheduler.maintLock) return res.status(409).json({error: `有浏览器任务在跑(${scheduler.maintLock}),请等待完成`});
    res.json({ok: true, count: accs.length, willWaitReg: scheduler.running.size > 0});
    batchAtRunning = true; batchAtStop = false;
    scheduler.acquireLock("batch-at-relogin");
    broadcast("batchAt", {running: true, done: 0, total: accs.length});
    (async () => {
        if (scheduler.running.size > 0) {
            broadcast("log", {id: 0, line: `[批量重登at] 等待 ${scheduler.running.size} 个注册任务完成…`, ts: Date.now()});
            await waitRegIdle();
        }
        let done = 0;
        await runPool(accs, async (a) => {
            if (batchAtStop) return;
            try { await testOneAt((await db.getAccount(a.id)) || a, {relogin: true}); } catch (e) { logAcct(a.id, `[at] 异常: ${e?.message || e}`); }
            done += 1; broadcast("batchAt", {running: true, done, total: accs.length});
        }, scheduler.concurrency);
        if (batchAtStop) console.log(`[批量重登at] 已停止(${done}/${accs.length})`);
        batchAtRunning = false; batchAtStop = false;
        scheduler.releaseLock("batch-at-relogin");
        broadcast("batchAt", {running: false, done, total: accs.length});
        console.log(`[批量重登at] 结束 ${done}/${accs.length}`);
        scheduler.tick();
    })();
});
app.post("/api/control/test-at/stop", (req, res) => { if (batchAtRunning) batchAtStop = true; res.json({ok: true, msg: batchAtRunning ? "已请求停止" : "当前无批量重登"}); });
app.post("/api/control/test-rt", async (req, res) => {
    const accs = await pickAccounts(req.body?.ids);
    const updateRt = req.body?.updateRt !== false;
    // 批量:默认 acquire=false，只刷新有效 rt、标记无rt/过期，避免一键误耗大量接码;显式传 acquire:true 才批量获取
    const acquire = req.body?.acquire === true;
    if (!acquire) { res.json({ok: true, count: accs.length}); runPool(accs, (a) => testOneRt(a, {updateRt, acquire: false}), 6); return; }
    // acquire=true: 与注册/其他维护互斥
    if (scheduler.maintLock) return res.status(409).json({error: `有浏览器任务在跑(${scheduler.maintLock}),请等待完成`});
    scheduler.acquireLock("batch-rt-acquire");
    res.json({ok: true, count: accs.length, willWaitReg: scheduler.running.size > 0});
    (async () => {
        if (scheduler.running.size > 0) {
            broadcast("log", {id: 0, line: `[rt获取] 等待 ${scheduler.running.size} 个注册任务完成…`, ts: Date.now()});
            await waitRegIdle();
        }
        broadcast("log", {id: 0, line: `[rt获取] 开始批量获取 ${accs.length} 个(并发${scheduler.concurrency})`, ts: Date.now()});
        await runPool(accs, (a) => testOneRt(a, {updateRt, acquire: true}), scheduler.concurrency);
        broadcast("log", {id: 0, line: `[rt获取] 完成`, ts: Date.now()});
        scheduler.releaseLock("batch-rt-acquire");
        scheduler.tick();
    })();
});

// ---------- 测聊天(session 注入 + 真浏览器发一条消息，子进程) ----------
const IS_WIN = process.platform === "win32";
const CHAT_TSX_BIN = (() => {
    const local = path.resolve(__dirname, "..", "node_modules", ".bin", "tsx" + (IS_WIN ? ".cmd" : ""));
    if (existsSync(local)) return local;
    return "tsx";
})();
const CHAT_ROOT = path.resolve(__dirname, "..");
function runChatWorker(acc, message) {
    return new Promise(async (resolve) => {
        await pushTestStatus(acc.id, "chat", "聊天中…");
        broadcast("log", {id: acc.id, line: `[chat] 启动浏览器发消息…`, ts: Date.now()});
        const authData = getAuthData(acc);
        let tmpAuthFile = "";
        const chatAuthFile = (() => {
            if (authData) { tmpAuthFile = path.join(os.tmpdir(), `chat-auth-${acc.id}-${Date.now()}.json`); writeFileSync(tmpAuthFile, JSON.stringify(authData)); return tmpAuthFile; }
            return acc.auth_file || "";
        })();
        const child = spawn(CHAT_TSX_BIN, ["src/worker-chat.ts"], {
            shell: IS_WIN, cwd: CHAT_ROOT,
            env: {...process.env, CHAT_AUTH_FILE: chatAuthFile, CHAT_MESSAGE: message || "", PROXY_URL: scheduler.regProxy || ""},
        });
        let buf = "";
        let result = null;
        child.on("error", (e) => logAcct(acc.id, `[chat] worker 启动失败: ${e?.message || e}`));
        child.stdout.on("data", (d) => {
            buf += d.toString();
            let idx;
            while ((idx = buf.indexOf("\n")) >= 0) {
                const line = buf.slice(0, idx); buf = buf.slice(idx + 1);
                if (line.startsWith("@@EVENT@@")) {
                    try {
                        const ev = JSON.parse(line.slice(9));
                        if (ev.type === "progress") broadcast("log", {id: acc.id, line: `[chat] ${ev.message}`, ts: Date.now()});
                        else if (ev.type === "result") result = ev;
                    } catch { /* ignore */ }
                } else if (line.trim()) broadcast("log", {id: acc.id, line: `[chat] ${line}`, ts: Date.now()});
            }
        });
        child.stderr.on("data", (d) => broadcast("log", {id: acc.id, line: `[chat:err] ${String(d).slice(0, 120)}`, ts: Date.now()}));
        child.on("close", async () => {
            if (tmpAuthFile) try { rmSync(tmpAuthFile, {force: true}); } catch {}
            const status = result ? (result.ok ? "✅回复成功" : ("❌" + (result.error || "无回复"))) : "❌进程异常退出";
            await pushTestStatus(acc.id, "chat", status);
            resolve(result || {ok: false});
        });
        child.on("error", async (e) => { if (tmpAuthFile) try { rmSync(tmpAuthFile, {force: true}); } catch {} await pushTestStatus(acc.id, "chat", "❌启动失败:" + (e?.message ?? e)); resolve({ok: false}); });
    });
}
app.post("/api/accounts/:id/test-chat", async (req, res) => {
    const acc = await db.getAccount(Number(req.params.id));
    if (!acc) return res.status(404).json({error: "账号不存在"});
    res.json({ok: true, started: true});
    runChatWorker(acc, req.body?.message);
});
app.post("/api/control/test-chat", async (req, res) => {
    const accs = await pickAccounts(req.body?.ids);
    const message = req.body?.message || "";
    res.json({ok: true, count: accs.length});
    runPool(accs, (a) => runChatWorker(a, message), 2); // headed 浏览器，低并发
});
app.post("/api/control/proxy", (req, res) => {
    if (typeof req.body?.regProxy === "string") scheduler.regProxy = req.body.regProxy.trim();
    if (typeof req.body?.mailProxy === "string") scheduler.mailProxy = req.body.mailProxy.trim();
    if (typeof req.body?.mailProxyEnabled === "boolean") scheduler.mailProxyEnabled = req.body.mailProxyEnabled;
    setMailProxy(scheduler.mailProxyEnabled !== false ? (scheduler.mailProxy || "") : "");
    scheduler.saveSettings();
    res.json({ok: true, regProxy: scheduler.regProxy, mailProxy: scheduler.mailProxy, mailProxyEnabled: scheduler.mailProxyEnabled !== false});
});

// ---------- 独立 vless 代理(起独立 xray，注册代理自动指向本地端口，不碰用户自己的 v2rayN) ----------
// 全局清理：重置所有实例的 running/claimed 孤儿（某台电脑断电后手动调用）
app.post("/api/control/cleanup-stale", async (req, res) => {
    const r = await db.cleanupAllStale();
    res.json({ok: true, ...r});
});
app.post("/api/control/xray-bin", (req, res) => {
    const p = String(req.body?.binPath ?? "").trim();
    scheduler.xrayBinPath = p;
    scheduler.saveSettings();
    res.json({ok: true, xrayBinPath: p});
});
app.post("/api/control/xray", (req, res) => {
    res.status(410).json({error: "GPT 独立 vless 已下线，注册走邮箱代理池：先设跳板，再导入出口代理"});
});
app.post("/api/control/xray/stop", (req, res) => {
    stopXray();
    scheduler.xrayVless = "";
    scheduler.saveSettings();
    res.json({ok: true, xray: xrayStatus()});
});
// 探测:经独立 xray 端口查出口 IP + chatgpt 连通(用系统 curl，socks5 可靠)
app.get("/api/control/xray/probe", (req, res) => {
    const st = xrayStatus();
    if (!st.running) return res.json({ok: false, reason: "独立 xray 未运行"});
    const px = `socks5h://127.0.0.1:${st.port}`;
    try {
        const ip = execSync(`curl -s --max-time 15 --proxy ${px} https://api.ipify.org`, {encoding: "utf8"}).trim();
        const cg = execSync(`curl -s -o /dev/null -w "%{http_code}" --max-time 20 --proxy ${px} https://chatgpt.com/`, {encoding: "utf8"}).trim();
        res.json({ok: true, ip, chatgpt: cg, pass: cg === "403" || cg === "200"});
    } catch (e: any) {
        res.json({ok: false, reason: "经代理连接失败(节点可能失效): " + String(e?.message ?? e).slice(0, 120)});
    }
});
app.post("/api/control/retry-failed", (req, res) => { scheduler.retryAllFailed(); res.json({ok: true}); });

app.get("/api/state", async (req, res) => {
    try {
        lastMailJobProg = await db.mailJobsProgress();
        lastMailJobProg.paused = await db.isMailClaimPaused();
        lastMailInstances = await db.listMailInstances();
    } catch { /* 表未就绪 */ }
    res.json({state: {...scheduler.state(), xray: xrayStatus(), claudeXray: xrayStatus("claude"), jumpXray: (scheduler.jumpFleet || [])[0] || xrayStatus("jump"), jumpXrays: listJumpXrays(), ...mailboxStateExtras()}, stats: await db.stats()});
});
app.get("/api/stats", async (req, res) => res.json(await db.stats()));

// ---------- 接码池(手机号=卡密 + 接码链接) ----------
function parseSms(text: string) {
    const rows: {card: string; phone: string; link: string}[] = [];
    for (const raw of String(text || "").split(/\r?\n/)) {
        const line = raw.trim();
        if (!line) continue;
        // 新格式：卡密----手机号----链接(如 SM-X12NG-AD3KE----14109084692----https://k8sms.com/sms/xxx)。
        // 按类型智能识别，不依赖顺序：link=http段；phone=纯数字段(≥6位)；card=剩余非链接非纯数字段。
        // 兼容老数据：只有手机号 / 手机号----链接(card 为空，收码链接走全局模板)。
        const parts = line.split(/----|\t|,|\s{2,}/).map((s) => s.trim()).filter(Boolean);
        const link = parts.find((p) => /^https?:\/\//i.test(p)) || "";
        const rest = parts.filter((p) => p !== link);
        const phoneRaw = rest.find((p) => /^\+?[\d\s-]{6,}$/.test(p)) || "";
        const phone = phoneRaw.replace(/[^\d+]/g, "");
        const card = rest.find((p) => p !== phoneRaw && !/^\+?[\d\s-]{6,}$/.test(p)) || "";
        if (phone) rows.push({card, phone, link});
    }
    return rows;
}
app.post("/api/sms/import", async (req, res) => {
    const rows = parseSms(req.body?.text);
    if (!rows.length) return res.status(400).json({error: "未解析到有效行(每行: 手机号----链接，或从 Excel 复制两列)"});
    const verify = req.body?.verify !== false; // 默认导入前验证收码链接有效性
    let invalid: {phone: string; reason: string}[] = [];
    let toImport = rows;
    if (verify) {
        // 并发 peek 每个号的收码链接:fatal(token错/截断/号未注册/欠费)→ 判无效跳过;waiting(暂无短信=token对)/有码 → 有效
        const checked: {row: any; ok: boolean; reason?: string}[] = [];
        await runPool(rows, async (row) => {
            const link = row.link || buildSmsLink(scheduler.smsLinkTemplate, row.phone);
            if (!link) { checked.push({row, ok: true}); return; } // 无链接(靠全局模板运行时拼)→ 无法预检，放行
            try {
                const raw = await peekSms(link);
                const c = classifySms(raw);
                if (c.kind === "fatal") checked.push({row, ok: false, reason: (c.reason || raw).slice(0, 50)});
                else checked.push({row, ok: true}); // waiting/code 都算 token 有效
            } catch (e: any) {
                checked.push({row, ok: false, reason: "验证请求失败: " + String(e?.message ?? e).slice(0, 40)});
            }
        }, 6);
        toImport = checked.filter((c) => c.ok).map((c) => c.row);
        invalid = checked.filter((c) => !c.ok).map((c) => ({phone: c.row.phone, reason: c.reason || "无效"}));
    }
    const r = toImport.length ? await db.importSms(toImport) : {inserted: 0, skipped: 0, total: rows.length};
    broadcast("sms", {stats: await db.smsStats()});
    res.json({...r, invalid, verified: verify});
});
app.get("/api/sms", async (req, res) => res.json({
    list: (await db.listSms()).map((s: any) => ({id: s.id, card: s.card || "", phone: s.phone, status: s.status, bound_email: s.bound_email, bind_count: s.bind_count || 0, bind_emails: s.bind_emails || "", link_preview: s.link.slice(0, 34) + (s.link.length > 34 ? "…" : "")})),
    stats: await db.smsStats(),
}));
app.delete("/api/sms/:id", async (req, res) => { await db.deleteSms(Number(req.params.id)); broadcast("sms", {stats: await db.smsStats()}); res.json({ok: true}); });
app.get("/api/sms/:id/peek", async (req, res) => {
    const s: any = (await db.listSms()).find((x: any) => x.id === Number(req.params.id));
    if (!s) return res.status(404).json({error: "接码号不存在"});
    const link = s.link || buildSmsLink(scheduler.smsLinkTemplate, s.phone);
    if (!link) return res.status(400).json({error: "该号无收码链接：请先配置接码链接模板"});
    try { res.json({text: await peekSms(link)}); } catch (e: any) { res.status(500).json({error: String(e?.message ?? e)}); }
});

// ---------- 定时任务：每天对已成功账号 养号 + rt续期 + at续期(含relogin) ----------
// rt 用 acquire=false(只续已有的有效 rt，不自动对过期/无rt号重取，避免定时批量烧接码)。
// at 先 6 并发快速探测,失效的收集起来走浏览器 relogin 重新获取(并发数跟随全局并发配置)。
// 综合判死活:测 at + 续 rt，rt 能续或 at 有效=活(清 dead_at);【at 和 rt 都失效】才算死→setDeadAt 定格存活天数。
async function maintainOne(acc, items, atFailedQueue?: any[]) {
    let atOk = null, rtOk = null;
    if (items.at) {
        try { atOk = (await testOneAt(acc)).ok; } catch { atOk = false; }
        // 抖动重试1次:无 rt 的号只靠一次探测,偶发网络/代理失败不该直接判死
        if (atOk === false) { try { atOk = (await testOneAt((await db.getAccount(acc.id)) || acc)).ok; } catch { atOk = false; } }
        // at 探测失败 → 收集到队列,后续串行 relogin
        if (atOk === false && atFailedQueue) atFailedQueue.push(acc);
    }
    if (items.rt) { try { rtOk = (await testOneRt(acc, {updateRt: true, acquire: false})).ok; } catch { rtOk = false; } }
    // 只有同时测了 at 和 rt 才综合判死活(只测一项无法判定"两者都失效")
    if (items.at && items.rt) {
        if (atOk || rtOk) await db.setDeadAt(acc.id, 0);                       // 有一个活 → 复活/保持活
        else await db.setDeadAt(acc.id, acc.dead_at || Date.now());           // 都失效 → 首次定格死亡时间(已死则保持)
        broadcast("status", {id: acc.id, ...(await db.getAccount(acc.id))});    // dead_at 变化 → 前端存活列刷新
    }
}
async function runDailyMaintenance(trigger = "cron") {
    if (scheduler.daily.running) return {ok: false, reason: "上次维护还在跑"};
    const items = scheduler.daily.items || {};
    const accs = (await db.listAccounts("success")).filter((a) => !a.sold_at); // 已售出的号不再保活
    scheduler.daily.running = true;
    scheduler.emit("daily", scheduler.daily);
    broadcast("log", {id: 0, line: `[定时·${trigger}] 开始维护 ${accs.length} 个号 (养号:${!!items.chat} rt:${!!items.rt} at:${!!items.at})`, ts: Date.now()});
    let chatN = 0, rtN = 0, atN = 0, reloginN = 0;
    try {
        if (accs.length) {
            // at/rt 合并成 maintainOne(综合判死活);养号单独(headed 浏览器低并发)
            const atFailedQueue: any[] = [];
            if (items.at || items.rt) { await runPool(accs, (a) => maintainOne(a, items, items.at ? atFailedQueue : undefined), 6); atN = items.at ? accs.length : 0; rtN = items.rt ? accs.length : 0; }
            // at 失效的号走浏览器登录重新获取(与注册互斥)
            if (atFailedQueue.length) {
                if (!scheduler.acquireLock("daily-at-relogin")) {
                    broadcast("log", {id: 0, line: `[定时·${trigger}] 跳过 at 重登(有其他浏览器任务在跑: ${scheduler.maintLock})`, ts: Date.now()});
                } else {
                    await waitRegIdle();
                    broadcast("log", {id: 0, line: `[定时·${trigger}] ${atFailedQueue.length} 个号 at 失效,重登获取(并发${scheduler.concurrency})…`, ts: Date.now()});
                    await runPool(atFailedQueue, async (a) => {
                        try {
                            const fresh = (await db.getAccount(a.id)) || a;
                            const r = await testOneAt(fresh, {relogin: true});
                            if (r.ok) reloginN++;
                            if (r.ok && items.rt) { await db.setDeadAt(a.id, 0); broadcast("status", {id: a.id, ...(await db.getAccount(a.id))}); }
                        } catch (e: any) { logAcct(a.id, `[定时·at重登] 异常: ${e?.message || e}`); }
                    }, scheduler.concurrency);
                    broadcast("log", {id: 0, line: `[定时·${trigger}] at重登完成: ${reloginN}/${atFailedQueue.length} 成功`, ts: Date.now()});
                    scheduler.releaseLock("daily-at-relogin");
                    scheduler.tick();
                }
            }
            // 养号(浏览器,与注册互斥)
            if (items.chat) {
                if (!scheduler.acquireLock("daily-chat")) {
                    broadcast("log", {id: 0, line: `[定时·${trigger}] 跳过养号(有其他浏览器任务在跑: ${scheduler.maintLock})`, ts: Date.now()});
                } else {
                    await waitRegIdle();
                    await runPool(accs, (a) => runChatWorker(a, ""), 2);
                    chatN = accs.length;
                    scheduler.releaseLock("daily-chat");
                    scheduler.tick();
                }
            }
        }
        scheduler.recordDailyRun({chatN, rtN, atN, accounts: accs.length, trigger});
        broadcast("log", {id: 0, line: `[定时·${trigger}] 维护完成:${scheduler.daily.lastResult}${reloginN ? ` (at重登成功${reloginN}个)` : ""}`, ts: Date.now()});
        return {ok: true, accounts: accs.length, chatN, rtN, atN, reloginN};
    } catch (e: any) {
        broadcast("log", {id: 0, line: `[定时·${trigger}] 维护异常:${String(e?.message ?? e).slice(0, 120)}`, ts: Date.now()});
        return {ok: false, reason: String(e?.message ?? e)};
    } finally {
        scheduler.daily.running = false;
        scheduler.emit("daily", scheduler.daily);
    }
}
// 每分钟检查:启用 && 到设定小时 && 今天还没跑过 → 触发。跑完当天不再重复。
setInterval(() => {
    const d = scheduler.daily;
    if (!d.enabled || d.running) return;
    const now = new Date();
    if (now.getHours() !== d.hour) return;
    const last = d.lastRunAt ? new Date(d.lastRunAt) : null;
    if (last && last.toDateString() === now.toDateString()) return; // 今天已跑
    runDailyMaintenance("cron");
}, 60_000);

app.post("/api/control/daily", (req, res) => {
    const {enabled, hour, items} = req.body || {};
    res.json({ok: true, daily: scheduler.setDaily({enabled, hour: hour == null ? undefined : Number(hour), items})});
});
app.post("/api/control/daily/run", async (req, res) => {
    if (scheduler.daily.running) return res.status(409).json({error: "维护正在进行中"});
    res.json({ok: true, started: true, accounts: (await db.listAccounts("success")).length});
    runDailyMaintenance("manual"); // 后台跑，进度走 SSE
});

// ---------- 批量下载：导出 session 文件【内容】(非路径)，不含 token 字段 ----------
// 从凭证对象提取 session 内层(即 /api/auth/session 响应体)
function extractSession(d) {
    if (!d || typeof d !== "object") return null;
    return (d as any).session !== undefined ? (d as any).session : d;
}
// 兼容：从文件路径读 session（worker 产出的新文件尚未入 DB 时用）
function readSession(authFile: string): unknown {
    return extractSession(readJsonFileSafe(authFile));
}
// 单号 session json(账号详情「复制session」用)。返回裸 session 对象,与导出 format=session 行内的 json 一致。
app.get("/api/accounts/:id/session", async (req, res) => {
    const id = Number(req.params.id);
    const a = Number.isInteger(id) ? await db.getAccount(id) : null;
    if (!a) return res.status(404).json({error: "账号不存在"});
    if (!a.auth_data && !a.auth_file) return res.status(400).json({error: "该号无 at 授权数据"});
    const sess = extractSession(getAuthData(a));
    if (!sess) return res.status(400).json({error: "session 文件读取失败"});
    res.json({session: sess});
});
// 批量获取 AT：走浏览器登录重新拿 accessToken。
// 输入 {items: [{email, password}]}；优先从数据库匹配(用已有密码),匹配不到则用传入的密码。
// 串行跑 headed 浏览器,后台执行,通过 SSE refreshAt 事件实时推进度。
app.post("/api/tools/batch-refresh-at", async (req, res) => {
    // 支持两种输入: items=[{email,password}] 或 lines="邮箱\n邮箱----密码\n..."
    let items: {email: string; password: string}[] = [];
    if (Array.isArray(req.body?.items)) {
        items = req.body.items.map((it: any) => ({email: String(it.email || "").trim().toLowerCase(), password: String(it.password || "")})).filter((it: any) => it.email);
    } else if (typeof req.body?.lines === "string") {
        items = parseEmailPasswordLines(req.body.lines);
    }
    if (!items.length) return res.status(400).json({error: "未提供邮箱列表"});

    const allAccs = await db.listAccounts("success");
    const byEmail = new Map(allAccs.map((a: any) => [a.email.toLowerCase(), a]));
    // 合并:数据库有的用数据库密码+走 testOneAt;没有的用传入密码+走独立浏览器登录
    const results: any[] = items.map((it) => {
        const acc = byEmail.get(it.email);
        return {email: it.email, password: acc?.password || it.password, ok: false, reason: "", status: "pending", accId: acc?.id || null};
    });

    batchRefreshAtStop = false;
    res.json({ok: true, count: results.length});
    (async () => {
        for (const r of results) {
            if (batchRefreshAtStop) { r.reason = "已停止"; r.status = "done"; continue; }
            if (!r.password) { r.ok = false; r.reason = "无密码"; r.status = "done"; broadcast("refreshAt", {results: results.map(({accId, ...rest}) => rest)}); continue; }
            try {
                if (r.accId) {
                    // 数据库有记录 → 走 testOneAt(relogin)
                    const acc = await db.getAccount(r.accId);
                    if (!acc) { r.ok = false; r.reason = "账号不存在"; r.status = "done"; continue; }
                    const atResult = await testOneAt(acc, {relogin: true});
                    if (atResult.ok) {
                        const freshAcc = await db.getAccount(r.accId);
                        const tok = extractTokens(getAuthData(freshAcc));
                        r.accessToken = tok?.accessToken || "";
                        r.sessionJson = extractSession(getAuthData(freshAcc));
                        r.ok = true; r.reason = "获取成功";
                    } else { r.ok = false; r.reason = atResult.reason || "获取失败"; }
                } else {
                    // 数据库没有 → 直接 spawn 浏览器登录(不入库,只拿 at);优先用数据库查询码
                    const dbMb = await db.getMailboxByEmail?.(r.email);
                    const re = await runReloginAtWorkerStandalone(r.email, dbMb?.password || r.password);
                    if (re.ok && re.accessToken) {
                        r.accessToken = re.accessToken;
                        r.sessionJson = re.authFile ? readSession(re.authFile) : null;
                        r.ok = true; r.reason = "获取成功(独立登录)";
                    } else { r.ok = false; r.reason = re.reason || "登录失败"; }
                }
            } catch (e: any) { r.ok = false; r.reason = String(e?.message || e).slice(0, 80); }
            r.status = "done";
            broadcast("refreshAt", {results: results.map(({accId, ...rest}) => rest)});
        }
        batchRefreshAtStop = false;
        broadcast("refreshAt", {results: results.map(({accId, ...rest}) => rest), done: true});
    })();
});
// 独立协议登录拿 at(不依赖数据库账号记录)
function runReloginAtWorkerStandalone(email, password): Promise<{ok: boolean; accessToken?: string; authFile?: string; reason?: string}> {
    return new Promise(async (resolve) => {
        const tmpDir = mkdtempSync(path.join(os.tmpdir(), "codex-relogin-sa-"));
        const tmpFile = path.join(tmpDir, `mc.txt`);
        broadcast("log", {id: 0, line: `[批量AT] ${email}: 走协议登录获取 at…`, ts: Date.now()});
        const mb = await db.getMailboxByEmail?.(email);
        const gptAcc = await db.getAccountByEmail(email);
        writeMailboxTokenFile(tmpFile, {
            email,
            password: password || mb?.password || "",
            mailboxTotp: mb?.totp_secret || "",
            recoveryEmail: mb?.recovery_email || "",
            imapPassword: mb?.imap_password || "",
        });
        const child = spawn(CHAT_TSX_BIN, ["src/worker-login-http.ts"], {
            shell: IS_WIN, cwd: CHAT_ROOT,
            env: {
                ...process.env,
                REG_EMAIL: email,
                MAIL_PROVIDER: (mb?.provider) || (/@(gmail|googlemail)\.com$/i.test(email) ? "google" : email.endsWith("@icloud.com") ? "icloud" : "mailcom"),
                MAILCOM_TOKENS_FILE: tmpFile, ICLOUD_TOKENS_FILE: tmpFile,
                MAILCOM_HEADLESS: "1",
                PROXY_URL: scheduler.regProxy || "",
                MAILCOM_PROXY: scheduler.mailProxyEnabled !== false ? (scheduler.mailProxy || "") : "",
                REG_SIMULATE_CHAT: "",
                REG_TRY_RT: "0",
                GPT_PASSWORD: (gptAcc?.gpt_password || appConfig.defaultPassword || "").trim(),
                TOTP_SECRET: gptAcc?.totp_secret || "",
                REG_TRY_MFA: gptAcc?.totp_secret ? "0" : "1",
            },
        });
        let buf = "", result = null;
        child.on("error", (e) => { broadcast("log", {id: 0, line: `[批量AT] ${email}: worker 启动失败: ${e?.message || e}`, ts: Date.now()}); resolve({ok: false, reason: String(e?.message || e)}); });
        child.stdout.on("data", (d) => {
            buf += d.toString(); let idx;
            while ((idx = buf.indexOf("\n")) >= 0) {
                const line = buf.slice(0, idx); buf = buf.slice(idx + 1);
                if (line.startsWith("@@EVENT@@")) {
                    try {
                        const ev = JSON.parse(line.slice(9));
                        if (ev.type === "result") result = ev;
                        else if (ev.message) broadcast("log", {id: 0, line: `[批量AT] ${email}: ${ev.message}`, ts: Date.now()});
                    } catch {}
                } else if (line.trim()) {
                    broadcast("log", {id: 0, line: `[批量AT] ${email}: ${line}`, ts: Date.now()});
                }
            }
        });
        child.stderr.on("data", (d) => {
            const msg = d.toString().trim();
            if (msg) broadcast("log", {id: 0, line: `[批量AT] ${email}: [stderr] ${msg}`, ts: Date.now()});
        });
        child.on("exit", () => {
            try { rmSync(tmpFile, {force: true}); rmSync(tmpDir, {force: true, recursive: true}); } catch {}
            if (result?.status === "success" && result.authFile) {
                const tok = readAuthTokens(result.authFile);
                resolve({ok: true, accessToken: tok?.accessToken || "", authFile: result.authFile});
            } else {
                resolve({ok: false, reason: result?.error || "浏览器登录失败"});
            }
        });
    });
}

// 批量获取 RT：走 codex OAuth 登录获取全新 refresh_token(Pro 号不触发 add-phone,无需接码)
let batchRtStop = false;
let batchRtChild = null;
app.post("/api/tools/batch-acquire-rt/stop", (req, res) => {
    batchRtStop = true;
    try { batchRtChild?.kill("SIGKILL"); } catch { /* */ }
    res.json({ok: true});
});

// 用 refresh_token 刷新出 access_token（sub2json 导出用）
app.post("/api/tools/refresh-tokens", async (req, res) => {
    const items: {email: string; password: string; rt: string}[] = req.body?.items || [];
    if (!items.length) return res.status(400).json({error: "items 为空"});
    const rtDispatcher = buildProxyDispatcher(scheduler.rtProxy || scheduler.regProxy);
    const results: any[] = [];
    for (const it of items) {
        if (!it.rt) { results.push({email: it.email, ok: false, reason: "无rt"}); continue; }
        const r = await refreshRt(it.rt, rtDispatcher);
        if (r.ok && r.tokens) {
            results.push({email: it.email, password: it.password, ok: true, tokens: r.tokens});
        } else {
            results.push({email: it.email, ok: false, reason: r.reason || "刷新失败"});
        }
    }
    res.json({results});
});
let batchRefreshAtStop = false;
app.post("/api/tools/batch-refresh-at/stop", (req, res) => { batchRefreshAtStop = true; res.json({ok: true}); });
app.post("/api/tools/batch-acquire-rt", (req, res) => {
    const items = parseEmailPasswordLines(req.body?.lines);
    if (!items.length) return res.status(400).json({error: "未提供邮箱列表"});
    batchRtStop = false;
    res.json({ok: true, count: items.length});
    const results: any[] = items.map((it: any) => ({email: it.email, password: it.password, ok: false, reason: "", status: "pending"}));
    (async () => {
        for (const r of results) {
            if (batchRtStop) { r.reason = "已停止"; r.status = "done"; continue; }
            const dbMb = await db.getMailboxByEmail?.(r.email);
            const gptAcc = await db.getAccountByEmail(r.email);
            const mailPwd = dbMb?.password || r.password;
            const gptPwd = (gptAcc?.gpt_password || r.password || appConfig.defaultPassword || "").trim();
            if (!gptPwd && !mailPwd) { r.ok = false; r.reason = "无密码"; r.status = "done"; broadcast("batchRtAcquire", {results, done: false}); continue; }
            r.status = "running";
            r.reason = "OAuth 登录中…";
            broadcast("batchRtAcquire", {results, done: false});
            try {
                broadcast("log", {id: 0, line: `[批量RT] ${r.email}: 走 OAuth 获取 rt…`, ts: Date.now()});
                const re = await runRtWorkerStandalone(r.email, mailPwd, gptPwd, (msg) => {
                    r.reason = String(msg || "").slice(0, 80);
                    r.status = "running";
                    broadcast("batchRtAcquire", {results, done: false});
                });
                if (re.ok) {
                    r.rt = re.rt; r.accessToken = re.accessToken; r.ok = true; r.reason = "获取成功";
                    // 数据库有对应 GPT 账号 → 同步更新 rt_file
                    if (re.rtFile) {
                        const gptAcc = await db.getAccountByEmail(r.email);
                        if (gptAcc) {
                            const rtData = readJsonFileSafe(re.rtFile);
                            await db.setAccountRtFile(gptAcc.id, re.rtFile, rtData);
                            broadcast("log", {id: 0, line: `[批量RT] ${r.email}: rt 已同步到 GPT 账号`, ts: Date.now()});
                            const plan = await syncAccountPlan(gptAcc, re.accessToken || extractTokens(rtData)?.accessToken, extractTokens(rtData)?.accountId);
                            if (plan) { r.plan = plan; broadcast("log", {id: 0, line: `[批量RT] ${r.email}: 套餐 → ${plan}`, ts: Date.now()}); }
                        }
                    }
                } else { r.ok = false; r.reason = re.reason || "获取失败"; }
            } catch (e: any) { r.ok = false; r.reason = String(e?.message || e).slice(0, 80); }
            r.status = "done";
            broadcast("batchRtAcquire", {results, done: false});
        }
        batchRtStop = false;
        broadcast("batchRtAcquire", {results, done: true});
        broadcast("log", {id: 0, line: `[批量RT] 完成: ${results.filter(r => r.ok).length}/${results.length} 成功`, ts: Date.now()});
    })();
});
// 独立 OAuth 获取 rt(不走接码,用邮箱密码走 codex OAuth,Pro 号不触发 add-phone)
function runRtWorkerStandalone(email, mailPassword, gptPassword, onProgress): Promise<{ok: boolean; rt?: string; accessToken?: string; rtFile?: string; reason?: string}> {
    return new Promise(async (resolve) => {
        let settled = false;
        const finish = (v) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            if (batchRtChild === child) batchRtChild = null;
            resolve(v);
        };
        const tmpDir = mkdtempSync(path.join(os.tmpdir(), "codex-rt-sa-"));
        const tmpFile = path.join(tmpDir, `mc.txt`);
        const mb = await db.getMailboxByEmail?.(email);
        const gptAcc = await db.getAccountByEmail(email);
        writeMailboxTokenFile(tmpFile, {
            email,
            password: mailPassword || mb?.password || "",
            mailboxTotp: mb?.totp_secret || "",
            recoveryEmail: mb?.recovery_email || "",
            imapPassword: mb?.imap_password || "",
        });
        const gptPwd = (gptPassword || gptAcc?.gpt_password || mailPassword || appConfig.defaultPassword || "").trim();
        // 用独立脚本(不带 smsBroker),跳过 add-phone
        const child = spawn(CHAT_TSX_BIN, ["scripts/worker-rt-nosms.ts"], {
            shell: IS_WIN, cwd: CHAT_ROOT,
            env: {
                ...process.env,
                REG_EMAIL: email,
                MAIL_PROVIDER: (mb?.provider) || (/@(gmail|googlemail)\.com$/i.test(email) ? "google" : email.endsWith("@icloud.com") ? "icloud" : "mailcom"),
                MAILCOM_TOKENS_FILE: tmpFile, ICLOUD_TOKENS_FILE: tmpFile,
                MAILCOM_HEADLESS: "1",
                PROXY_URL: rechargeProxy() || "",
                MAILCOM_PROXY: scheduler.mailProxyEnabled !== false ? (scheduler.mailProxy || "") : "",
                GPT_PASSWORD: gptPwd,
                TOTP_SECRET: gptAcc?.totp_secret || "",
                SMS_LINK_TEMPLATE: scheduler.smsLinkTemplate || "",
            },
        });
        batchRtChild = child;
        const timer = setTimeout(() => {
            try { child.kill("SIGKILL"); } catch { /* */ }
            finish({ok: false, reason: "超时(120s)，OAuth/取码卡住"});
        }, 120000);
        let buf = "", result = null;
        child.on("error", (e) => finish({ok: false, reason: String(e?.message || e)}));
        child.stdout.on("data", (d) => {
            buf += d.toString(); let idx;
            while ((idx = buf.indexOf("\n")) >= 0) {
                const line = buf.slice(0, idx); buf = buf.slice(idx + 1);
                if (line.startsWith("@@EVENT@@")) {
                    try {
                        const ev = JSON.parse(line.slice(9));
                        if (ev.type === "result") result = ev;
                        else if (ev.message) {
                            onProgress?.(ev.message);
                            broadcast("log", {id: 0, line: `[批量RT] ${email}: ${ev.message}`, ts: Date.now()});
                        }
                    } catch {}
                } else if (line.trim()) {
                    onProgress?.(line.trim());
                    broadcast("log", {id: 0, line: `[批量RT] ${email}: ${line}`, ts: Date.now()});
                }
            }
        });
        child.stderr.on("data", (d) => {
            const msg = d.toString().trim();
            if (msg) broadcast("log", {id: 0, line: `[批量RT] ${email}: [stderr] ${msg}`, ts: Date.now()});
        });
        child.on("exit", () => {
            try { rmSync(tmpFile, {force: true}); rmSync(tmpDir, {force: true, recursive: true}); } catch {}
            if (result?.status === "success" && result.rt) {
                const tok = result.rtFile ? readAuthTokens(result.rtFile) : null;
                finish({ok: true, rt: result.rt, accessToken: tok?.accessToken || "", rtFile: result.rtFile || ""});
            } else {
                finish({ok: false, reason: result?.error || "OAuth 获取 rt 失败"});
            }
        });
    });
}

// ★统一导出端点(合并原下载菜单 /api/export + 批量 /api/export/selected)。POST 一站式:范围×scope×格式×标记已售出。
//   范围:body.ids(选中/当前筛选) 或 body.batch(按批次) 或都不传(全部)。
//   可导:success 且未失效;另外「有 GPT 密码的谷歌邮箱」全部导出(不要求 success/未失效)。
//   scope=all|hasRt|atOnly 再按 rt 细分。
//   格式 format:
//     full   : Gmail=邮箱----邮箱密码----谷歌2FA----IMAP[----GPT密码----GPT2FA----rt]
//              其它=邮箱----邮箱密码----IMAP[----GPT密码----GPT2FA----rt]
//     at     : 邮箱----邮箱密码----accessToken(从 auth_file 解析)
//     session: 邮箱----邮箱密码----session json(可恢复登录态)
//     jsonl  : 每行含 password/mailbox_totp/imap_password/gpt_password/totp_secret/rt
//     csv    : 统一列(邮箱,邮箱密码,邮箱2FA,IMAP,GPT密码,GPT2FA,rt)
//   markSold:true 导出同时标记已售出。用 POST 避免选中量大时 URL 超长。
function isGoogleMailbox(r) {
    return r?.provider === "google" || /@(gmail|googlemail)\.com$/i.test(String(r?.email || ""));
}
function isMailcomMailbox(r) {
    if (isGoogleMailbox(r)) return false;
    const p = String(r?.provider || "").toLowerCase();
    return p === "mailcom" || p === "mail.com" || p === "";
}

/** 充值提交前预检：Gmail 探 IMAP，mail.com 验邮箱密码。不通的不配卡。 */
async function precheckRechargeMailbox(q) {
    const acc = await db.getAccount(q.account_id);
    if (!acc) return {ok: false, reason: "找不到 GPT 账号"};
    if (isGoogleMailbox(acc)) {
        const imap = String(acc.mailbox_imap || acc.imap_password || "").trim();
        if (!imap) return {ok: false, reason: "Gmail 没有 IMAP 应用密码"};
        rechargeLog(`预检 ${acc.email}: 探 Gmail IMAP`);
        const probe = await testGmailImap(acc.email, imap, {
            log: (m) => rechargeLog(`预检 ${acc.email}: ${m}`),
        });
        if (!probe.ok) return {ok: false, reason: `Gmail IMAP 不可用 (${probe.error || "不通"})`};
        rechargeLog(`预检 ${acc.email}: IMAP 通（收件箱 ${probe.messages ?? 0} 封）`);
        return {ok: true};
    }
    if (isMailcomMailbox(acc)) {
        const pw = String(acc.password || "").trim();
        if (!pw) return {ok: false, reason: "mail.com 没有邮箱密码"};
        rememberMailcomPassword(acc.email, pw);
        // 充值预检跟重登/RT 同一条「充值代理」(rtProxy→regProxy)，本地无账密 socks；
        // 不要用 mail 代理池(kookeey 带 user:pass，Playwright Chrome 不支持 socks5 鉴权)。
        const proxy = rechargeProxy();
        rechargeLog(`预检 ${acc.email}: 验 mail.com 密码（代理=${proxy ? maskProxyUrl(proxy) : "直连"}）`);
        const v = await verifyMailcomLogin(
            acc.email,
            pw,
            (m) => rechargeLog(`预检 ${acc.email}: ${m}`),
            {proxy, tries: 2, headless: true},
        );
        if (!v.ok) return {ok: false, reason: `mail.com 密码不可用 (${String(v.reason || "登录失败").slice(0, 100)})`};
        rechargeLog(`预检 ${acc.email}: mail.com 密码可用`);
        return {ok: true};
    }
    return {ok: true};
}
function normalizeRebindTarget(t) {
    const s = String(t || "").trim().toLowerCase();
    if (s === "mail" || s === "mail.com" || s === "mailcom") return "mailcom";
    if (s === "gmail" || s === "google") return "gmail";
    return "";
}
function rebindTargetLabel(t) {
    return t === "mailcom" ? "mail.com" : "Gmail";
}
function imapAuthDead(err) {
    return /invalid credentials|authenticationfailed|login failed|application-specific password|disabled|web login required/i.test(String(err || ""));
}
function exportableAccount(r) {
    if (isGoogleMailbox(r) && String(r?.gpt_password || "").trim()) return true;
    return r?.status === "success" && !r?.dead_at;
}
// Gmail: 邮箱----邮箱密码----谷歌2FA----IMAP[----GPT密码----GPT2FA----rt]
// 其它: 邮箱----邮箱密码----IMAP[----GPT密码----GPT2FA----rt]（无 IMAP 时该段为空）
function formatAccountExportLine(r, {rt = "", sep = "----"} = {}) {
    const email = r.email || "";
    const mailPw = r.password || r.mailPw || "";
    const mail2fa = String(r.mailbox_totp || r.mail2fa || "").trim();
    const imap = String(r.mailbox_imap || r.imap_password || r.imap || "").trim();
    const gptPw = String(r.gpt_password || "").trim();
    const gpt2fa = String(r.totp_secret || r.gpt2fa || "").trim();
    const parts = isGoogleMailbox(r) ? [email, mailPw, mail2fa, imap] : [email, mailPw, imap];
    // 有 GPT 密码或 rt 时补齐尾部三段，方便「导出含 RT」固定位解析
    if (gptPw || rt) parts.push(gptPw, gpt2fa, rt || "");
    return parts.join(sep);
}

app.post("/api/export/full", async (req, res) => {
    const format = String(req.body?.format || "full");
    const scope = String(req.body?.scope || "all");
    const batch = req.body?.batch != null ? String(req.body.batch) : null;
    const idSet = Array.isArray(req.body?.ids) && req.body.ids.length ? new Set(req.body.ids.map(Number)) : null;

    // 先拉全量再按范围/可导规则筛:谷歌+GPT密码不受 success/dead 限制。
    let rows = await db.listAccounts(undefined, true);
    if (batch != null) rows = rows.filter((r) => (r.batch || "") === batch);
    if (idSet) rows = rows.filter((r) => idSet.has(r.id));
    rows = rows.filter(exportableAccount);
    if (scope === "hasRt") rows = rows.filter((r) => r.rt_file);
    else if (scope === "atOnly") rows = rows.filter((r) => !r.rt_file);
    if (req.body?.markSold === true && rows.length) { // 导出同时标记已售出
        try { await db.markSold(rows.map((r) => r.id)); broadcast("snapshot", await db.listAccounts()); broadcast("stats", await db.stats()); } catch (_) { /* ignore */ }
    }
    const gptPwOf = (r) => (r.gpt_password || appConfig.defaultPassword || "").trim();
    const mailTotpOf = (r) => String(r.mailbox_totp || "").trim();
    const gptTotpOf = (r) => String(r.totp_secret || "").trim();
    const imapOf = (r) => String(r.mailbox_imap || r.imap_password || r.imap || "").trim();

    if (format === "at") {
        const lines = rows.map((r) => {
            const tok = extractTokens(getAuthData(r));
            return `${r.email}----${r.password}----${tok?.accessToken || ""}`;
        });
        res.set("Content-Type", "text/plain; charset=utf-8");
        return res.send(lines.join("\n"));
    }
    if (format === "session") {
        const lines = rows.map((r) => { const sess = extractSession(getAuthData(r)); return `${r.email}----${r.password}----${sess ? JSON.stringify(sess) : ""}`; });
        res.set("Content-Type", "text/plain; charset=utf-8");
        return res.send(lines.join("\n"));
    }
    if (format === "jsonl") {
        const recs = rows.map((r) => {
            const rt = (extractTokens(getRtData(r)) || {}).refreshToken || (extractTokens(getAuthData(r)) || {}).refreshToken || "";
            return {
                email: r.email,
                password: r.password || "",
                mailbox_totp: mailTotpOf(r),
                imap_password: imapOf(r),
                gpt_password: gptPwOf(r),
                totp_secret: gptTotpOf(r),
                card: r.card || "",
                phone: r.phone || "",
                plan: r.plan,
                access_token: (extractTokens(getAuthData(r)) || {}).accessToken || "",
                refresh_token: rt,
                provider: r.provider || "",
            };
        });
        res.set("Content-Type", "application/x-ndjson; charset=utf-8");
        return res.send(recs.map((r) => JSON.stringify(r)).join("\n"));
    }
    const recs = rows.map((r) => {
        const rt = (extractTokens(getRtData(r)) || {}).refreshToken || (extractTokens(getAuthData(r)) || {}).refreshToken || "";
        return {
            email: r.email,
            password: r.password || "",
            mailbox_totp: mailTotpOf(r),
            mailbox_imap: imapOf(r),
            imap_password: imapOf(r),
            gpt_password: String(r.gpt_password || "").trim(),
            totp_secret: gptTotpOf(r),
            rt,
            provider: r.provider || "",
        };
    });
    if (format === "csv") {
        const head = "邮箱,邮箱密码,邮箱2FA,IMAP,GPT密码,GPT2FA,rt\n";
        const body = recs.map((r) => [r.email, r.password, r.mailbox_totp, r.imap_password, r.gpt_password, r.totp_secret, r.rt]
            .map((v) => `"${String(v ?? "").replace(/"/g, '""')}"`).join(",")).join("\n");
        res.set("Content-Type", "text/csv; charset=utf-8");
        return res.send(head + body);
    }
    // full: Gmail 邮箱----邮箱密码----谷歌2FA----IMAP[----GPT密码----GPT2FA----rt]
    const lines = recs.map((r) => formatAccountExportLine(r, {rt: r.rt}));
    res.set("Content-Type", "text/plain; charset=utf-8");
    res.send(lines.join("\n"));
});

// 批次列表(去重+计数,按最近导入排序:最近的在前。用于前端筛选/导出下拉 + 导入默认上一个批次)
app.get("/api/batches", async (req, res) => {
    const map = new Map();
    for (const r of await db.listAccounts()) {
        const b = r.batch || ""; if (!b) continue;
        const e = map.get(b) || {count: 0, lastId: 0};
        e.count += 1; e.lastId = Math.max(e.lastId, r.id);
        map.set(b, e);
    }
    const arr = [...map.entries()].map(([name, e]) => ({name, count: e.count, lastId: e.lastId}));
    arr.sort((a, b) => b.lastId - a.lastId); // 最近导入(最大 id)的批次排最前
    res.json(arr.map(({name, count}) => ({name, count})));
});

// ---------- 充值提交(/api/recharge/*) ----------

// 平台 API 代理(S2S,注入 api_key + X-Forwarded-For)
async function callRechargeApi(method: string, apiPath: string, body?: any): Promise<any> {
    const base = scheduler.rechargeBaseUrl;
    const key = scheduler.rechargeApiKey;
    if (!base || !key) throw new Error("充值平台 API 未配置(缺少 Base URL 或 API Key)");
    const url = `${base.replace(/\/+$/, "")}${apiPath}`;
    const headers: Record<string, string> = {
        "Authorization": `Bearer ${key}`,
        "Content-Type": "application/json",
    };
    if (scheduler.rechargeForwardIp) headers["X-Forwarded-For"] = scheduler.rechargeForwardIp;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 30000);
    try {
        const res = await fetch(url, {method, headers, body: body ? JSON.stringify(body) : undefined, signal: ctrl.signal});
        const text = await res.text();
        let data: any = {};
        try { data = JSON.parse(text); } catch { /* 非 JSON 响应 */ }
        if (!res.ok) {
            const detail = data.detail || (text.length < 200 ? text : "") || "";
            throw new Error(`${method} ${apiPath} → ${res.status}${detail ? ": " + detail : ""}`);
        }
        return data;
    } finally { clearTimeout(timer); }
}

const RECHARGE_LOG_FILE = path.resolve(__dirname, "..", "data", "recharge-logs.jsonl");
const RECHARGE_LOG_MAX = 2000;
let rechargeLogBuf: {ts: number; line: string}[] = [];
function loadRechargeLogsFromDisk() {
    try {
        if (!existsSync(RECHARGE_LOG_FILE)) return;
        const rows = readFileSync(RECHARGE_LOG_FILE, "utf8").split(/\r?\n/).filter(Boolean);
        const keep = rows.slice(-RECHARGE_LOG_MAX);
        rechargeLogBuf = keep.map((s) => { try { return JSON.parse(s); } catch { return {ts: 0, line: s}; } }).filter((x) => x && x.line);
    } catch { /* 损坏则空 */ }
}
function persistRechargeLogs() {
    try {
        writeFileSync(RECHARGE_LOG_FILE, rechargeLogBuf.map((x) => JSON.stringify(x)).join("\n") + (rechargeLogBuf.length ? "\n" : ""), "utf8");
    } catch { /* 忽略写失败 */ }
}
loadRechargeLogsFromDisk();
function rechargeLog(line: string) {
    const rec = {ts: Date.now(), line: String(line || "")};
    rechargeLogBuf.push(rec);
    if (rechargeLogBuf.length > RECHARGE_LOG_MAX) rechargeLogBuf = rechargeLogBuf.slice(-RECHARGE_LOG_MAX);
    persistRechargeLogs();
    broadcast("rechargeLog", rec);
}
let exportRtBusy = false;
async function rechargeSync() { broadcast("recharge", await db.listRechargeCards()); }
async function queueSync() { broadcast("rechargeQueue", await db.listRechargeQueue()); }

const gmailRebindIds: number[] = [];
const gmailRebindQueued = new Set();
const gmailRebindCancelled = new Set();
const gmailRebindTargets = new Map();
const gmailRebindPool = new Map();
let gmailRebindRunning = false;
let gmailRebindCurrentId = 0;

function isGmailRebindCancelled(id) {
    return gmailRebindCancelled.has(Number(id));
}

function resolveRebindTarget(q, {force = false, target} = {}) {
    const explicit = normalizeRebindTarget(target);
    if (explicit) return explicit;
    const stored = normalizeRebindTarget(q?.rebind_target);
    if (force && stored) return stored;
    const auto = normalizeRebindTarget(scheduler.rebindAfterPaid);
    if (auto) return auto;
    return force ? "gmail" : "";
}

function normalizeRebindPool(raw = {}) {
    const emails = [...new Set(
        (Array.isArray(raw.emails) ? raw.emails : [])
            .map((s) => String(s || "").trim().toLowerCase())
            .filter((s) => s.includes("@")),
    )];
    const fromText = extractEmailsFromText(String(raw.text || ""));
    for (const e of fromText) if (!emails.includes(e)) emails.push(e);
    const rawGrp = raw.grp;
    const hasGrp = rawGrp !== undefined && rawGrp !== null
        && rawGrp !== "__ALL__" && rawGrp !== "__PICK__" && String(rawGrp) !== "undefined";
    const out = {};
    if (emails.length) out.emails = emails;
    if (hasGrp) out.grp = String(rawGrp);
    return out;
}

function rebindPoolHint(pool = {}) {
    const parts = [];
    if (pool.grp !== undefined) parts.push(`分组「${pool.grp || "无分组"}」`);
    if (pool.emails?.length) parts.push(`${pool.emails.length} 个指定邮箱`);
    return parts.length ? `，范围=${parts.join(" ")}` : "";
}

function enqueueGmailRebind(q, {force = false, target, pool} = {}) {
    const dest = resolveRebindTarget(q, {force, target});
    if (!dest) return false;
    const id = Number(q?.id);
    if (!Number.isInteger(id)) return false;
    if (gmailRebindQueued.has(id)) {
        rechargeLog(`换绑跳过 ${q.email || id}: 已在进行，不要重复点`);
        return false;
    }
    const st = String(q.rebind_status || "");
    if (!force && (st === "ok" || st === "pending" || st === "skipped")) return false;
    gmailRebindCancelled.delete(id);
    gmailRebindQueued.add(id);
    gmailRebindTargets.set(id, dest);
    const p = dest === "gmail" ? normalizeRebindPool(pool || q?.rebind_pool || {}) : {};
    if (p.emails || p.grp !== undefined) gmailRebindPool.set(id, p);
    else gmailRebindPool.delete(id);
    gmailRebindIds.push(id);
    const ahead = gmailRebindRunning && gmailRebindCurrentId && gmailRebindCurrentId !== id;
    db.updateQueueItem(id, {
        rebind_status: "pending", rebind_error: "", rebind_target: dest,
        rebind_pool: (p.emails || p.grp !== undefined) ? p : null,
    }).then(() => queueSync()).catch(() => {});
    if (ahead) rechargeLog(`换绑 ${q.email} → ${rebindTargetLabel(dest)} 已排队，等当前号跑完`);
    pumpGmailRebind();
    return true;
}

function pumpGmailRebind() {
    if (gmailRebindRunning) return;
    gmailRebindRunning = true;
    (async () => {
        try {
            while (gmailRebindIds.length) {
                const id = gmailRebindIds.shift();
                gmailRebindCurrentId = id;
                try { await runGmailRebind(id); }
                catch (e: any) { rechargeLog(`换绑异常 ${id}: ${e?.message || e}`); }
                finally {
                    gmailRebindQueued.delete(id);
                    gmailRebindCancelled.delete(id);
                    gmailRebindTargets.delete(id);
                    gmailRebindPool.delete(id);
                    gmailRebindCurrentId = 0;
                }
            }
        } finally {
            gmailRebindRunning = false;
            gmailRebindCurrentId = 0;
            if (gmailRebindIds.length) pumpGmailRebind();
        }
    })();
}

async function runGmailRebind(queueId) {
    const q = await db.getRechargeQueueItem(queueId);
    if (!q) return;
    if (isGmailRebindCancelled(queueId)) {
        rechargeLog(`换绑 ⏭ ${q.email}: 已取消`);
        return;
    }
    const dest = gmailRebindTargets.get(queueId) || normalizeRebindTarget(q.rebind_target) || "gmail";
    const destLabel = rebindTargetLabel(dest);
    rechargeLog(`换绑开始 ${q.email} → ${destLabel}`);
    const acc = await db.getAccount(q.account_id);
    if (!acc) {
        await db.updateQueueItem(queueId, {rebind_status: "fail", rebind_error: "找不到 GPT 账号"});
        rechargeLog(`换绑 ✗ ${q.email}: 找不到 GPT 账号`);
        await queueSync();
        return;
    }
    if (dest === "gmail" && isGoogleMailbox(acc)) {
        await db.updateQueueItem(queueId, {rebind_status: "skipped", rebind_error: "已是 Gmail", rebind_target: dest});
        rechargeLog(`换绑 ⏭ ${acc.email}: 已是 Gmail，跳过`);
        await queueSync();
        return;
    }

    const miss = dest === "mailcom"
        ? "没有独立且未使用的 mail.com（邮箱管理 · 独立）"
        : "没有独立且未使用、已开 IMAP 的 Gmail（邮箱管理 · 独立）";
    let claimed = null;
    const fail = async (msg, release = true) => {
        if (release && claimed?.id) await db.releaseMailboxToFree(claimed.id);
        await db.updateQueueItem(queueId, {rebind_status: "fail", rebind_error: String(msg || "换绑失败").slice(0, 200), rebind_target: dest});
        rechargeLog(`换绑 ✗ ${acc.email}${claimed?.email ? " → " + claimed.email : ""}: ${msg}`);
        await queueSync();
    };
    const rememberClaimed = (mb) => {
        if (dest === "gmail") {
            rememberGoogleCred({
                email: mb.email, password: mb.password,
                totpSecret: mb.totp_secret, recoveryEmail: mb.recovery_email,
                imapPassword: mb.imap_password,
            });
        } else {
            rememberMailcomPassword(mb.email, mb.password);
        }
    };
    const doChange = (at, tok, mb) => changeChatgptEmail({
        accessToken: at,
        accountId: tok?.accountId || "",
        proxyUrl: rechargeProxy(),
        newEmail: mb.email,
        imapPassword: mb.imap_password,
        mailPassword: mb.password,
        totpSecret: mb.totp_secret || "",
    });

    try {
        let fresh = acc;
        let tok = extractTokens(getAuthData(fresh) || q.auth_data);
        let at = tok?.accessToken || "";
        if (!at) {
            rechargeLog(`换绑 ${acc.email}: 无 at，先重登再换绑`);
            rememberMailcomPassword(acc.email, acc.password);
            const re = await runReloginAtWorkerPooled(fresh, {
                timeoutMs: reloginIdleMs(fresh), allowBrowser: false, skipMfa: true,
                onProgress: (m) => rechargeLog(`换绑 ${acc.email}: 重登 ${String(m || "").slice(0, 160)}`),
            });
            if (!re.ok) return fail(`重登失败: ${String(re.reason || "").slice(0, 120)}`, false);
            fresh = await db.getAccount(acc.id) || fresh;
            tok = extractTokens(getAuthData(fresh));
            at = tok?.accessToken || "";
            if (!at) return fail("重登后仍无 access_token", false);
        } else if (needsPwdReauth(at)) {
            rechargeLog(`换绑 ${acc.email}: session 还在，但换绑接口要 5 分钟内的密码验证，先直接试，不够新再重登`);
        }

        const pool = dest === "gmail" ? (gmailRebindPool.get(queueId) || {}) : {};
        const excludeIds = [];
        const poolHint = dest === "gmail" ? rebindPoolHint(pool) : "";
        const gmailQueue = dest === "gmail"
            ? await db.listRebindGmailCandidates({grp: pool.grp, emails: pool.emails})
            : [];
        let gmailCursor = 0;
        for (let attempt = 1; attempt <= 8; attempt++) {
            if (isGmailRebindCancelled(queueId)) {
                if (claimed?.id) await db.releaseMailboxToFree(claimed.id);
                rechargeLog(`换绑 ⏭ ${acc.email}: 已取消`);
                return;
            }
            if (dest === "mailcom") {
                claimed = await db.claimFreeMailcomMailbox();
                if (!claimed) return fail(attempt === 1 ? `${miss}${poolHint}` : `范围内已无可用 ${destLabel}${poolHint}`, false);
            } else {
                let picked = null;
                while (gmailCursor < gmailQueue.length) {
                    const cand = gmailQueue[gmailCursor++];
                    if (excludeIds.includes(cand.id)) continue;
                    rechargeLog(`换绑 ${acc.email} → ${cand.email}：换绑前探 IMAP（仍未售，第 ${attempt} 个${poolHint}）`);
                    const probe = await testGmailImap(cand.email, cand.imap_password, {
                        log: (m) => rechargeLog(`换绑 ${acc.email}: ${m}`),
                    });
                    if (!probe.ok) {
                        const dead = imapAuthDead(probe.error);
                        rechargeLog(`换绑 ${cand.email} 不可用 IMAP 不通 (${probe.error})，${dead ? "标已售废号" : "仍可用、本轮跳过"}`);
                        if (dead) {
                            await db.quarantineMailbox(cand.id, "IMAP不通");
                            try { await db.refreshMailboxGoogleState(cand.id, {imap: "fail", last_error: String(probe.error || "").slice(0, 120)}); } catch { /* */ }
                        } else {
                            excludeIds.push(cand.id);
                        }
                        continue;
                    }
                    rechargeLog(`换绑 ${cand.email} 可用 IMAP 通（收件箱 ${probe.messages ?? 0} 封），再预占`);
                    picked = await db.claimMailboxForRebind(cand.id);
                    if (!picked) {
                        rechargeLog(`换绑 ${cand.email} 探活后被别人领走，换下一个`);
                        continue;
                    }
                    break;
                }
                if (!picked) {
                    let why = attempt === 1 ? `${miss}${poolHint}` : `范围内已无可用 ${destLabel}${poolHint}`;
                    if (pool.emails?.length && attempt === 1) {
                        const detail = await db.explainRebindGmailMiss(pool.emails).catch(() => "");
                        if (detail) why = `${why}；${detail}`;
                    }
                    return fail(why, false);
                }
                claimed = picked;
            }
            rememberClaimed(claimed);
            rechargeLog(`换绑 ${acc.email} → ${claimed.email} (独立未售 ${destLabel}，第 ${attempt} 个)`);

            let r = await doChange(at, tok, claimed);
            if (!r.ok && r.rateLimited) {
                rechargeLog(`换绑 ${acc.email}: 官方限流 429，等 90 秒再试 ${claimed.email}`);
                await new Promise((res) => setTimeout(res, 90_000));
                r = await doChange(at, tok, claimed);
                if (!r.ok && r.rateLimited) {
                    await db.releaseMailboxToFree(claimed.id);
                    claimed = null;
                    return fail("官方换绑限流，过几分钟再点", false);
                }
            }
            if (!r.ok && r.needReauth) {
                // 换绑要新的 pwd_auth。旧 AT 去 enroll 只会 401，别再浪费一轮。
                if (!(fresh.totp_secret || "").trim() && at && !needsPwdReauth(at)) {
                    rechargeLog(`换绑 ${acc.email}: 无 GPT 2FA，先用现有 AT 绑验证器（避开 mail.com 收码）`);
                    const mfa = await enrollTotp(at, {
                        accountId: tok?.accountId || "",
                        proxyUrl: rechargeProxy(),
                        cookie: String(getAuthData(fresh)?.cookie || getAuthData(acc)?.cookie || "").trim(),
                        retryAltProxy: true,
                        browserFallback: process.env.MFA_NO_BROWSER !== "1",
                        log: (m) => rechargeLog(`换绑 ${acc.email}: ${m}`),
                        reauth: async () => {
                            rechargeLog(`换绑 ${acc.email}: 绑 2FA 需重登刷新 pwd_auth`);
                            const re = await runReloginAtWorkerPooled(fresh, {
                                allowBrowser: false, skipMfa: true,
                                onProgress: (m) => rechargeLog(`换绑 ${acc.email}: 重登 ${String(m || "").slice(0, 120)}`),
                            });
                            if (!re?.ok) throw new Error(re?.reason || "重登失败");
                            fresh = await db.getAccount(acc.id) || fresh;
                            const t2 = extractTokens(getAuthData(fresh));
                            if (!t2?.accessToken) throw new Error("重登后无 AT");
                            return {
                                accessToken: t2.accessToken,
                                accountId: t2.accountId || "",
                                cookie: String(getAuthData(fresh)?.cookie || "").trim(),
                            };
                        },
                    });
                    if (mfa.ok && mfa.secret) {
                        await db.updateAccount(acc.id, {totp_secret: mfa.secret, mfa_status: "✅已绑"});
                        fresh = {...fresh, totp_secret: mfa.secret};
                        rechargeLog(`换绑 ${acc.email}: GPT 2FA 已绑(${mfa.via || "http"})，重登走验证器`);
                    } else {
                        rechargeLog(`换绑 ${acc.email}: 绑 2FA 未成(${mfa.already ? "已有2FA缺密钥" : (mfa.reason || "失败")})，重登仍可能卡 mail.com`);
                    }
                }
                rechargeLog(`换绑 ${acc.email}: 换绑接口要重新验证密码（已存 session 不够新），开始协议登录`);
                rememberMailcomPassword(acc.email, acc.password);
                const re = await runReloginAtWorkerPooled(fresh, {
                    timeoutMs: reloginIdleMs(fresh), allowBrowser: false, skipMfa: true,
                    onProgress: (m) => rechargeLog(`换绑 ${acc.email}: 重登 ${String(m || "").slice(0, 160)}`),
                });
                if (!re.ok) return fail(`重登失败: ${String(re.reason || "").slice(0, 120)}`);
                fresh = await db.getAccount(acc.id) || fresh;
                tok = extractTokens(getAuthData(fresh));
                at = tok?.accessToken || "";
                if (!at) return fail("重登后仍无 access_token");
                rechargeLog(`换绑 ${acc.email}: 重登成功，继续向 ${claimed.email} 发换绑码`);
                r = await doChange(at, tok, claimed);
            }
            if (r.ok) {
                try {
                    await db.rebindGptMailbox(acc.id, claimed.id);
                } catch (e: any) {
                    await db.markMailboxSold(claimed.id, "换绑成功回写失败").catch(() => {});
                    await db.updateQueueItem(queueId, {
                        email: claimed.email,
                        rebind_status: "fail",
                        rebind_email: claimed.email,
                        rebind_error: `平台已换绑，回写失败: ${String(e?.message || e).slice(0, 120)}`,
                    });
                    rechargeLog(`换绑 ✗ ${acc.email} → ${claimed.email}: 平台已换绑，回写失败 ${e?.message || e}（新邮箱已标已售）`);
                    await queueSync();
                    return;
                }
                await db.updateQueueItem(queueId, {
                    email: claimed.email,
                    rebind_status: "ok",
                    rebind_email: claimed.email,
                    rebind_error: "",
                    rebind_target: dest,
                });
                if (dest === "gmail") {
                    try { await db.refreshMailboxGoogleState(claimed.id, {gpt: "ok"}); } catch { /* 阶段标记失败不影响换绑 */ }
                }
                rechargeLog(`换绑 ✓ ${acc.email} → ${claimed.email}（新邮箱已售，旧邮箱已售，都不回池）`);
                await queueSync();
                try {
                    broadcast("snapshot", await db.listAccounts());
                    broadcast("stats", await db.stats());
                    broadcast("mailboxes", {stats: await db.mailboxStats()});
                } catch { /* 面板刷新失败不影响换绑 */ }
                return;
            }
            if (r.alreadyLinked || r.badTarget) {
                const tag = r.alreadyLinked ? "官方已占用" : "目标邮箱废号";
                await db.quarantineMailbox(claimed.id, tag);
                rechargeLog(`换绑 ${claimed.email} ${tag}，标已售不返还，换下一个`);
                claimed = null;
                continue;
            }
            return fail(r.reason || "换绑失败");
        }
        return fail("连续多个目标邮箱都不可用（含 IMAP 不通已换号）", false);
    } catch (e: any) {
        await fail(e?.message || e);
    }
}

// 配置
app.get("/api/recharge/logs", (req, res) => {
    res.json(rechargeLogBuf);
});
app.post("/api/recharge/logs/clear", (req, res) => {
    rechargeLogBuf = [];
    persistRechargeLogs();
    res.json({ok: true});
});

app.get("/api/recharge/config", async (req, res) => {
    const key = scheduler.rechargeApiKey || "";
    res.json({
        baseUrl: scheduler.rechargeBaseUrl || "", appId: scheduler.rechargeAppId || "",
        apiKey: key ? `${key.slice(0, 6)}****${key.slice(-4)}` : "",
        forwardIp: scheduler.rechargeForwardIp || "",
        concurrency: scheduler.rechargeConcurrency || 3, interval: scheduler.rechargeInterval || 3,
        hasKey: !!key, rtProxy: scheduler.rtProxy || "", rtConcurrency: scheduler.rtConcurrency || 4,
        rebindAfterPaid: scheduler.rebindAfterPaid || "gmail",
        rebindGmailAfterPaid: scheduler.rebindAfterPaid === "gmail",
        instanceId: db.instanceId,
        gmailFreeImap: await db.countFreeGoogleImapMailboxes(),
        mailcomFree: await db.countFreeMailcomMailboxes(),
    });
});
app.post("/api/recharge/config", async (req, res) => {
    const b = req.body || {};
    if (typeof b.baseUrl === "string") scheduler.rechargeBaseUrl = b.baseUrl.trim();
    if (typeof b.appId === "string") scheduler.rechargeAppId = b.appId.trim();
    if (typeof b.apiKey === "string" && b.apiKey && !b.apiKey.includes("****")) scheduler.rechargeApiKey = b.apiKey.trim();
    if (typeof b.forwardIp === "string") scheduler.rechargeForwardIp = b.forwardIp.trim();
    if (b.concurrency !== undefined) scheduler.rechargeConcurrency = Math.max(1, Math.min(10, Number(b.concurrency) || 3));
    if (b.interval !== undefined) scheduler.rechargeInterval = Math.max(0, Math.min(60, Number(b.interval) || 3));
    if (typeof b.rtProxy === "string") scheduler.rtProxy = b.rtProxy.trim();
    if (b.rtConcurrency !== undefined) scheduler.rtConcurrency = Math.max(1, Math.min(20, Number(b.rtConcurrency) || 4));
    if (b.rebindAfterPaid === "off" || b.rebindAfterPaid === "gmail" || b.rebindAfterPaid === "mailcom") {
        scheduler.rebindAfterPaid = b.rebindAfterPaid;
    } else if (typeof b.rebindGmailAfterPaid === "boolean") {
        if (b.rebindGmailAfterPaid) scheduler.rebindAfterPaid = "gmail";
        else if (scheduler.rebindAfterPaid === "gmail") scheduler.rebindAfterPaid = "off";
    }
    scheduler.normalizeRebindAfterPaid();
    scheduler.saveSettings();
    res.json({
        ok: true,
        rebindAfterPaid: scheduler.rebindAfterPaid || "gmail",
        rebindGmailAfterPaid: scheduler.rebindAfterPaid === "gmail",
        gmailFreeImap: await db.countFreeGoogleImapMailboxes(),
        mailcomFree: await db.countFreeMailcomMailboxes(),
    });
});

// 卡密管理
app.get("/api/recharge/cards", async (req, res) => { res.json(await db.listRechargeCards()); });

app.post("/api/recharge/cards/import", async (req, res) => {
    const text = String(req.body?.text || "");
    const batch = String(req.body?.batch || "");
    const codes = text.split(/[\r\n]+/).map((l: string) => l.trim()).filter(Boolean);
    if (!codes.length) return res.status(400).json({error: "未提供卡密"});
    const result = await db.importRechargeCards(codes, batch);
    await rechargeSync();
    res.json(result);
});

app.post("/api/recharge/cards/delete", async (req, res) => {
    const ids = (req.body?.ids || []).map(Number).filter(Number.isInteger);
    const result = await db.deleteRechargeCards(ids);
    await rechargeSync();
    res.json({ok: true, ...result});
});

app.post("/api/recharge/cards/unpair", async (req, res) => {
    const ids = (req.body?.ids || []).map(Number).filter(Number.isInteger);
    const safe: number[] = [];
    for (const id of ids) {
        const card = await db.getRechargeCard(id);
        if (!card) continue;
        if (card.status === "submitted" || card.status === "submitting") {
            rechargeLog(`⚠️ 卡密 ${card.code.slice(0, 8)}... 状态为 ${card.status}，拒绝解绑(需等待平台返回结果)`);
            continue;
        }
        safe.push(id);
    }
    if (safe.length) { await db.unpairRechargeCards(safe); await rechargeSync(); }
    const skipped = ids.length - safe.length;
    res.json({ok: true, unpaired: safe.length, skipped});
});

// 批量验证卡密(后台串行,SSE 推进度)
let validateStop = false;
app.post("/api/recharge/cards/validate", async (req, res) => {
    const ids = (req.body?.ids || []).map(Number).filter(Number.isInteger);
    const cards = (await Promise.all(ids.map((id: number) => db.getRechargeCard(id)))).filter(Boolean);
    if (!cards.length) return res.status(400).json({error: "无有效卡密"});
    validateStop = false;
    res.json({ok: true, count: cards.length});
    for (const card of cards) {
        if (validateStop) { rechargeLog(`验证已停止`); break; }
        try {
            rechargeLog(`验证卡密 ${card.code.slice(0, 8)}...`);
            const data = await callRechargeApi("POST", "/redeem-codes/validate", {redeem_code: card.code});
            const r = data.result || {};
            await db.updateRechargeCard(card.id, {
                status: "unused", plan_type: r.plan_type || "", plan_name: r.plan_name || "",
                product: r.product || "", category: r.category || "", auth_mode: r.auth_mode || "", error: "",
            });
            rechargeLog(`✓ ${card.code.slice(0, 8)}... → ${r.plan_name || r.plan_type || "未知套餐"}`);
        } catch (e: any) {
            await db.updateRechargeCard(card.id, {error: String(e?.message || e).slice(0, 200)});
            rechargeLog(`✗ ${card.code.slice(0, 8)}... → ${e?.message || e}`);
        }
        await rechargeSync();
    }
    rechargeLog(`验证完成`);
});

// 可充值的 GPT 账号列表(success + 未售出 + 有 auth_file)。筛选在前端做,后端给全量基数。
app.get("/api/recharge/accounts", async (req, res) => {
    const all = await db.listAccounts("success");
    const rechargeable = all.filter((a: any) => !a.sold_at && a.auth_file);
    res.json(rechargeable);
});

// ---- 充值队列管理 ----
app.get("/api/recharge/queue", async (req, res) => { res.json(await db.listRechargeQueue()); });
app.get("/api/recharge/queue/batches", async (req, res) => { res.json(await db.rechargeQueueBatches()); });

app.post("/api/recharge/queue/add", async (req, res) => {
    const accountIds = (req.body?.accountIds || []).map(Number).filter(Number.isInteger);
    const batch = String(req.body?.batch || "");
    if (!accountIds.length) return res.status(400).json({error: "未选择账号"});
    const result = await db.addToRechargeQueue(accountIds, batch);
    await queueSync();
    broadcast("snapshot", await db.listAccounts());
    res.json({ok: true, ...result});
});

app.post("/api/recharge/queue/remove", async (req, res) => {
    const ids = (req.body?.ids || []).map(Number).filter(Number.isInteger);
    const result = await db.removeFromRechargeQueue(ids);
    await queueSync();
    broadcast("snapshot", await db.listAccounts());
    res.json({ok: true, ...result});
});

app.post("/api/recharge/queue/set-batch", async (req, res) => {
    const ids = (req.body?.ids || []).map(Number).filter(Number.isInteger);
    const batch = String(req.body?.batch ?? "");
    await db.setRechargeQueueBatch(ids, batch);
    await queueSync();
    res.json({ok: true});
});

app.post("/api/recharge/queue/reset", async (req, res) => {
    const ids = (req.body?.ids || []).map(Number).filter(Number.isInteger);
    if (!ids.length) return res.status(400).json({error: "未选择队列项"});
    const info = await db.resetRechargeQueue(ids);
    await queueSync(); await rechargeSync();
    if (info.kept) rechargeLog(`重置 ${ids.length} 项: ${info.reclaimed} 张卡密已回收, ${info.kept} 张已提交过的卡密未回收(需手动回收)`);
    res.json({ok: true, ...info});
});

app.post("/api/recharge/queue/reclaim-cards", async (req, res) => {
    const ids: number[] = (req.body?.ids || []).map(Number).filter(Number.isInteger);
    if (!ids.length) return res.status(400).json({error: "未选择队列项"});
    const items = (await Promise.all(ids.map((id: number) => db.getRechargeQueueItem(id)))).filter(Boolean);
    const withCards = items.filter((q: any) => q.card_id && q.status === "error");
    if (!withCards.length) return res.status(400).json({error: "无可回收的卡密(需 error 状态且有卡密)"});
    let reclaimed = 0, used = 0, failed = 0;
    for (const q of withCards) {
        try {
            const valRes = await callRechargeApi("POST", "/redeem-codes/validate", {redeem_code: q.card_code});
            const valResult = valRes.result || {};
            if (valResult.status === "unused") {
                await db.unpairRechargeCards([q.card_id]);
                reclaimed++;
                rechargeLog(`✓ 卡密 ${q.card_code.slice(0, 8)}... 平台确认未使用，已安全回收`);
            } else {
                await db.updateRechargeCard(q.card_id, {status: "error", error: `平台状态: ${valResult.status}(不可回收)`});
                used++;
                rechargeLog(`✗ 卡密 ${q.card_code.slice(0, 8)}... 平台状态: ${valResult.status}，不可回收`);
            }
        } catch (e: any) {
            failed++;
            rechargeLog(`✗ 卡密 ${q.card_code.slice(0, 8)}... 查询失败: ${e?.message || e}`);
        }
    }
    await rechargeSync();
    rechargeLog(`回收卡密完成: 回收 ${reclaimed} / 已消费 ${used} / 查询失败 ${failed}`);
    res.json({ok: true, reclaimed, used, failed});
});

// ---- 充值队列：重新登录刷新 session json ----
let queueReloginRunning = false;
let queueReloginStop = false;
app.post("/api/recharge/queue/relogin", async (req, res) => {
    if (queueReloginRunning) return res.status(400).json({error: "重新登录正在进行中"});
    const ids: number[] = (req.body?.ids || []).map(Number).filter(Number.isInteger);
    if (!ids.length) return res.status(400).json({error: "未选择队列项"});
    queueReloginRunning = true;
    queueReloginStop = false;
    const {claimed: items, skipped} = await db.claimRechargeQueueItems(ids, db.instanceId);
    if (!items.length) {
        queueReloginRunning = false;
        return res.status(400).json({error: skipped[0]?.reason || "未找到可认领的队列项(可能已被其他实例占用)"});
    }
    res.json({ok: true, count: items.length, claimed: items.length, skipped: skipped.length, instanceId: db.instanceId});
    (async () => {
        let ok = 0, fail = 0;
        try {
        rechargeLog(`[重登] 本实例 ${db.instanceId} 认领 ${items.length} 个${skipped.length ? `，跳过 ${skipped.length} 个(其他实例/不可处理)` : ""}`);
        for (const s of skipped) rechargeLog(`[重登] ⏭ ${s.email}: ${s.reason}`);
        for (let idx = 0; idx < items.length; idx++) {
            const q = items[idx];
            if (queueReloginStop) { rechargeLog(`[重登] 已停止`); break; }
            const acc = await db.getAccount(q.account_id);
            if (!acc) { fail++; rechargeLog(`[重登] [${idx + 1}/${items.length}] ${q.email}: ❌ 账号不存在`); continue; }
            rechargeLog(`[重登] [${idx + 1}/${items.length}] ${q.email}: 协议重登（GPT 代理池）…`);
            try {
                const re = await runReloginAtWorkerPooled(acc, {
                    onProgress: (m) => rechargeLog(`[重登] ${q.email}: ${String(m || "").slice(0, 140)}`),
                });
                if (re.ok && re.authFile) {
                    const freshAcc = await db.getAccount(q.account_id);
                    const freshAuthData = getAuthData(freshAcc);
                    const sess = extractSession(freshAuthData);
                    await db.updateQueueAuth(q.id, freshAcc?.auth_file || "", freshAuthData);
                    ok++;
                    rechargeLog(`[重登] [${idx + 1}/${items.length}] ${q.email}: ✅ 登录成功, session: ${sess ? "有效" : "⚠️ 无数据"}`);
                } else {
                    fail++;
                    rechargeLog(`[重登] [${idx + 1}/${items.length}] ${q.email}: ❌ ${(re as any).reason || "浏览器登录失败"}`);
                }
            } catch (e: any) {
                fail++;
                rechargeLog(`[重登] [${idx + 1}/${items.length}] ${q.email}: ❌ ${String(e?.message || e).slice(0, 100)}`);
            }
            broadcast("rechargeQueue", await db.listRechargeQueue());
        }
        rechargeLog(`[重登] 完成: 成功 ${ok} / 失败 ${fail} / 共 ${items.length}`);
        } finally {
        queueReloginRunning = false;
        queueReloginStop = false;
        await db.releaseRechargeQueueByInstance(db.instanceId);
        broadcast("rechargeQueue", await db.listRechargeQueue());
        }
    })();
});
app.post("/api/recharge/queue/relogin/stop", (req, res) => { queueReloginStop = true; rechargeStop = true; res.json({ok: true}); });

// ---- 充值队列：重登刷新 session → 重置任务 → 立即提交(一条龙) ----
// 针对"提交后 session 失效"的场景:先浏览器重登拿新 session,再验卡+重置,最后用同一张卡密重提。
// 原卡密提交前必查平台真实状态,非 unused(可能已充值成功)一律跳过,避免重复扣卡。
app.post("/api/recharge/queue/relogin-submit", async (req, res) => {
    if (queueReloginRunning) return res.status(400).json({error: "重新登录正在进行中"});
    if (rechargeRunning) return res.status(400).json({error: "充值提交正在进行中"});
    const ids: number[] = (req.body?.ids || []).map(Number).filter(Number.isInteger);
    if (!ids.length) return res.status(400).json({error: "未选择队列项"});
    queueReloginRunning = true;
    queueReloginStop = false;
    rechargeRunning = true;
    rechargeStop = false;
    const {claimed: items, skipped: skippedClaim} = await db.claimRechargeQueueItems(ids, db.instanceId);
    if (!items.length) {
        queueReloginRunning = false;
        rechargeRunning = false;
        return res.status(400).json({error: skippedClaim[0]?.reason || "无可认领的队列项(已提交/已完成或已被其他实例占用)"});
    }
    res.json({ok: true, count: items.length, claimed: items.length, skipped: skippedClaim.length, instanceId: db.instanceId});

    (async () => {
        const intervalMs = (scheduler.rechargeInterval || 5) * 1000;
        let ok = 0, fail = 0, skipped = 0;
        try {
        rechargeLog(`[重登提交] 本实例 ${db.instanceId} 认领 ${items.length} 个(重登 → 验卡 → 重置 → 提交)${skippedClaim.length ? `，跳过 ${skippedClaim.length} 个` : ""}`);
        for (const s of skippedClaim) rechargeLog(`[重登提交] ⏭ ${s.email}: ${s.reason}`);

        for (let idx = 0; idx < items.length; idx++) {
            if (queueReloginStop || rechargeStop) { rechargeLog(`[重登提交] 已停止`); break; }
            const tag = `[重登提交] [${idx + 1}/${items.length}] `;
            const q0 = await db.getRechargeQueueItem(items[idx].id);
            if (!q0) { skipped++; continue; }

            // ① 浏览器重登刷新 session
            const acc = await db.getAccount(q0.account_id);
            if (!acc) { fail++; rechargeLog(`${tag}${q0.email}: ❌ 账号不存在`); continue; }
            rechargeLog(`${tag}${q0.email}: 协议重登（GPT 代理池）…`);
            try {
                const re = await runReloginAtWorkerPooled(acc, {
                    onProgress: (m) => rechargeLog(`${tag}${q0.email}: ${String(m || "").slice(0, 140)}`),
                });
                if (!re.ok || !re.authFile) { fail++; rechargeLog(`${tag}${q0.email}: ❌ 登录失败: ${(re as any).reason || "未知"}`); continue; }
            } catch (e: any) { fail++; rechargeLog(`${tag}${q0.email}: ❌ 登录异常: ${String(e?.message || e).slice(0, 100)}`); continue; }
            const freshAcc = await db.getAccount(q0.account_id);
            const freshAuthData = getAuthData(freshAcc);
            if (!extractSession(freshAuthData)) { fail++; rechargeLog(`${tag}${q0.email}: ❌ 登录后仍无 session 数据`); continue; }
            await db.updateQueueAuth(q0.id, freshAcc?.auth_file || "", freshAuthData);
            rechargeLog(`${tag}${q0.email}: ✅ session 已刷新`);

            // ② 定卡密:原卡密先查平台真实状态,已消费则跳过;从未配对过则从池中取一张
            let card: any = null;
            if (q0.card_id) {
                card = await db.getRechargeCard(q0.card_id);
                if (card) {
                    try {
                        const valRes = await callRechargeApi("POST", "/redeem-codes/validate", {redeem_code: card.code});
                        const st = (valRes.result || {}).status;
                        if (st !== "unused") {
                            await db.updateRechargeCard(card.id, {status: "error", error: `平台状态: ${st}(不可复用)`});
                            skipped++;
                            rechargeLog(`${tag}${q0.email}: ⏭ 原卡密平台状态 ${st},可能已充值成功,跳过(请人工确认)`);
                            await queueSync(); await rechargeSync();
                            continue;
                        }
                    } catch (e: any) {
                        fail++;
                        rechargeLog(`${tag}${q0.email}: ❌ 卡密状态查询失败: ${String(e?.message || e).slice(0, 100)}`);
                        continue;
                    }
                }
            }
            if (!card) {
                const picked = await db.claimUnusedCards(1);
                if (!picked.length) { fail++; rechargeLog(`${tag}${q0.email}: ❌ 无可用卡密`); continue; }
                card = picked[0];
                rechargeLog(`${tag}${q0.email}: 分配新卡密 ${card.code.slice(0, 8)}...`);
            }

            // ③ 重置任务状态(清错误/任务号),卡密回到 paired
            await db.updateQueueItem(q0.id, {status: "pending", card_id: card.id, card_code: card.code, task_no: "", task_status: "", task_message: "", error: "", submitted_at: 0, finished_at: 0});
            await db.updateRechargeCard(card.id, {status: "paired", account_id: q0.account_id, account_email: q0.email, task_no: "", task_status: "", task_message: "", error: ""});
            rechargeLog(`${tag}${q0.email}: 已重置为待提交 ← ${card.code.slice(0, 8)}...`);

            // ④ 立即提交
            const q = await db.getRechargeQueueItem(q0.id);
            const r = await submitOneQueueItem(q, card, tag);
            if (r.ok) ok++; else fail++;
            await queueSync(); await rechargeSync();
            if (idx + 1 < items.length && !queueReloginStop && !rechargeStop) await new Promise((r2) => setTimeout(r2, intervalMs));
        }

        rechargeLog(`[重登提交] 完成: 成功 ${ok} / 失败 ${fail} / 跳过 ${skipped} / 共 ${items.length}`);
        } finally {
        queueReloginRunning = false;
        queueReloginStop = false;
        rechargeRunning = false;
        await db.releaseRechargeQueueByInstance(db.instanceId);
        await queueSync(); await rechargeSync();
        }
        if (ok > 0 && !rechargeStop) { rechargeLog("开始轮询任务状态…（已解锁，可继续提交其他号）"); await pollRechargeTasksLoop(); }
    })();
});

// ---- 充值提交(基于队列) ----
let rechargeStop = false;
let rechargeRunning = false;

// 单项提交核心(session → validate → challenge → tasks),队列/卡密状态在内部写入。
// submit 与 relogin-submit 共用;label 为日志前缀。返回 {ok:true,taskNo} | {ok:false,stage,msg}
async function submitOneQueueItem(q, card, label = "") {
    await db.updateQueueItem(q.id, {status: "submitting"});
    await db.updateRechargeCard(card.id, {status: "submitting"});
    let stage = "session";
    try {
        const freshAcc = await db.getAccount(q.account_id);
        const authObj = getAuthData(freshAcc) || q.auth_data || readJsonFileSafe(q.auth_file);
        const session = extractSession(authObj);
        if (!session) throw new Error("session 数据读取失败(account_id: " + q.account_id + ")");
        const tokenInput = JSON.stringify(session);

        stage = "validate";
        const valRes = await callRechargeApi("POST", "/redeem-codes/validate", {redeem_code: card.code});
        const valResult = valRes.result || {};
        await db.updateRechargeCard(card.id, {
            plan_type: valResult.plan_type || "", plan_name: valResult.plan_name || "",
            product: valResult.product || "", category: valResult.category || "", auth_mode: valResult.auth_mode || "",
        });
        if (valResult.status !== "unused") throw new Error(`卡密状态异常: ${valResult.status}`);

        stage = "challenge";
        const chRes = await callRechargeApi("POST", "/submission-challenges", {
            redeem_code: card.code, token_input: tokenInput, plan_type: valResult.plan_type || "",
        });
        const challengeToken = chRes.challenge?.challenge_token || "";

        stage = "tasks";
        const taskRes = await callRechargeApi("POST", "/tasks", {
            redeem_code: card.code, token_input: tokenInput, challenge_token: challengeToken,
            agreement_accepted: true, email_verified: true, plan_type: valResult.plan_type || "",
        });
        const task = taskRes.task || {};
        const taskNo = task.task_no || task.receipt_no || "";

        await db.updateQueueItem(q.id, {status: "submitted", task_no: taskNo, task_status: task.status || "queued", task_message: task.message || "", submitted_at: Date.now()});
        await db.updateRechargeCard(card.id, {status: "submitted", task_no: taskNo, task_status: task.status || "queued", task_message: task.message || ""});
        rechargeLog(`${label}✓ ${q.email} 已提交 → ${taskNo || "等待中"}`);
        return {ok: true, taskNo};
    } catch (e: any) {
        const msg = String(e?.message || e).slice(0, 200);
        const consumed = stage === "challenge" || stage === "tasks";
        const cardErr = consumed ? `[可能已消费·${stage}] ${msg}` : `[未提交·${stage}] ${msg}`;
        await db.updateQueueItem(q.id, {status: "error", error: msg, finished_at: Date.now()});
        await db.updateRechargeCard(card.id, {status: "error", error: cardErr});
        rechargeLog(`${label}✗ ${q.email} 提交失败(${stage}阶段): ${msg}`);
        return {ok: false, stage, msg};
    }
}

app.post("/api/recharge/submit", async (req, res) => {
    if (rechargeRunning) return res.status(400).json({error: "充值提交正在进行中"});
    const queueIds: number[] = (req.body?.queueIds || []).map(Number).filter(Number.isInteger);
    if (!queueIds.length) return res.status(400).json({error: "未选择队列项"});
    rechargeRunning = true;
    rechargeStop = false;

    const {claimed: claimedAll, skipped: skippedClaim} = await db.claimRechargeQueueItems(queueIds, db.instanceId);
    const items = claimedAll.filter((q: any) => q.status === "pending");
    const releaseClaimed = () => db.releaseRechargeQueueItems(claimedAll.map((q: any) => q.id), db.instanceId);
    if (!items.length) {
        await releaseClaimed();
        rechargeRunning = false;
        return res.status(400).json({error: skippedClaim[0]?.reason || "无可提交的队列项(需 status=pending,且未被其他实例占用)"});
    }
    if (items.length < claimedAll.length) {
        for (const q of claimedAll.filter((x: any) => x.status !== "pending")) {
            await db.updateQueueItem(q.id, {instance_id: ""});
        }
    }

    const unusedCount = await db.rechargeUnusedCount();
    if (unusedCount < 1) {
        await releaseClaimed();
        rechargeRunning = false;
        return res.status(400).json({error: "没有未使用卡密"});
    }

    res.json({ok: true, paired: 0, claimed: items.length, skipped: skippedClaim.length, instanceId: db.instanceId});

    // 后台：先预检再配卡提交。Gmail 不通 IMAP / mail.com 密码不可用的不配卡。
    (async () => {
        const intervalMs = (scheduler.rechargeInterval || 5) * 1000;
        let submitted = 0, failed = 0;
        try {
        rechargeLog(`本实例 ${db.instanceId} 先预检再提交 ${items.length} 个 / API: ${scheduler.rechargeBaseUrl}`);
        for (const s of skippedClaim) rechargeLog(`⏭ ${s.email}: ${s.reason}`);

        const ready = [];
        for (let i = 0; i < items.length; i++) {
            if (rechargeStop) { rechargeLog("已停止充值提交"); break; }
            const q = await db.getRechargeQueueItem(items[i].id);
            if (!q) { failed++; continue; }
            rechargeLog(`[预检 ${i + 1}/${items.length}] ${q.email}`);
            const pre = await precheckRechargeMailbox(q);
            if (!pre.ok) {
                failed++;
                await db.updateQueueItem(q.id, {status: "error", error: pre.reason, instance_id: "", finished_at: Date.now()});
                rechargeLog(`预检 ✗ ${q.email}: ${pre.reason}，不配卡、不提交`);
                await queueSync();
                continue;
            }
            ready.push(q);
        }
        if (!ready.length) {
            rechargeLog(`预检后没有可提交的号（失败 ${failed}）`);
        } else {
        const cards = await db.claimUnusedCards(ready.length);
        if (cards.length < ready.length) {
            rechargeLog(`卡密不够：预检通过 ${ready.length}，只领到 ${cards.length} 张`);
        }
        const n = Math.min(ready.length, cards.length);
        for (let i = 0; i < n; i++) {
            await db.updateQueueItem(ready[i].id, {status: "paired", card_id: cards[i].id, card_code: cards[i].code});
            await db.updateRechargeCard(cards[i].id, {status: "paired", account_id: ready[i].account_id, account_email: ready[i].email});
        }
        for (let i = n; i < ready.length; i++) {
            failed++;
            await db.updateQueueItem(ready[i].id, {status: "error", error: "卡密分配不足", instance_id: "", finished_at: Date.now()});
        }
        await queueSync(); await rechargeSync();
        rechargeLog(`预检通过 ${ready.length} / 已配对 ${n} 组账号-卡密`);

        for (let idx = 0; idx < n; idx++) {
            if (rechargeStop) { rechargeLog("已停止充值提交"); break; }

            const q = await db.getRechargeQueueItem(ready[idx].id);
            const card = await db.getRechargeCard(cards[idx].id);
            if (!q || !card) { failed++; continue; }

            rechargeLog(`[${idx + 1}/${n}] 提交 ${q.email} ← ${card.code.slice(0, 8)}...`);
            const r = await submitOneQueueItem(q, card);
            if (r.ok) submitted++; else failed++;
            await queueSync(); await rechargeSync();
            if (idx + 1 < n && !rechargeStop) await new Promise((r) => setTimeout(r, intervalMs));
        }
        }
        rechargeLog(`提交完成: 成功 ${submitted} / 失败 ${failed} / 总计 ${items.length}`);
        } finally {
        rechargeRunning = false;
        await db.releaseRechargeQueueByInstance(db.instanceId);
        await queueSync();
        }
        if (submitted > 0 && !rechargeStop) {
            rechargeLog("开始轮询任务状态…（已解锁，可继续提交其他号）");
            await pollRechargeTasksLoop();
        }
    })();
});

app.post("/api/recharge/stop", (req, res) => {
    rechargeStop = true;
    validateStop = true;
    rechargeRunning = false;
    res.json({ok: true});
});

// 轮询:30s 一次,最多 20 分钟(40 轮),超时后人工点「刷新状态」
async function pollRechargeTasksLoop() {
    const INTERVAL = 30_000, TIMEOUT = 20 * 60_000;
    const deadline = Date.now() + TIMEOUT;
    for (let round = 0; Date.now() < deadline; round++) {
        if (rechargeStop) { rechargeLog("轮询已停止"); break; }
        const pendingQ = await db.listQueueSubmittedPending();
        if (!pendingQ.length) { rechargeLog("所有任务已到达终态"); break; }

        try {
            const codes = pendingQ.filter((q: any) => q.card_code).map((q: any) => q.card_code);
            for (let i = 0; i < codes.length; i += 50) {
                const chunk = codes.slice(i, i + 50);
                const data = await callRechargeApi("POST", "/tasks/lookup-batch", {redeem_codes: chunk});
                for (const r of (data.results || [])) {
                    if (!r.ok) continue;
                    const task = r.task || {};
                    const q = pendingQ.find((x: any) => x.card_code.replace(/-/g, "") === (r.redeem_code || "").replace(/-/g, ""));
                    if (!q) continue;
                    const updates: any = {task_status: task.status || "", task_message: task.message || ""};
                    if (task.task_no && !q.task_no) updates.task_no = task.task_no;
                    if (task.status === "paid") updates.status = "done";
                    else if (["failed", "canceled", "returned"].includes(task.status)) updates.status = "error";
                    if (updates.status === "done" || updates.status === "error") updates.finished_at = Date.now();
                    await db.updateQueueItem(q.id, updates);
                    if (q.card_id) {
                        if (task.status === "returned") {
                            await db.unpairRechargeCards([q.card_id]);
                            rechargeLog(`  卡密 ${q.card_code.slice(0, 8)}... 已退回，自动回收到卡池`);
                        } else {
                            await db.updateRechargeCard(q.card_id, updates);
                        }
                    }
                    if (updates.status) rechargeLog(`${updates.status === "done" ? "✓" : "✗"} ${q.email} → ${task.status}: ${task.message || ""}`);
                    if (task.status === "paid") enqueueGmailRebind(q);
                }
            }
        } catch (e: any) {
            rechargeLog(`轮询出错: ${e?.message || e}`);
        }
        await queueSync(); await rechargeSync();

        if (!(await db.listQueueSubmittedPending()).length) { rechargeLog("所有任务已到达终态"); break; }
        await new Promise((r) => setTimeout(r, INTERVAL));
    }
    if ((await db.listQueueSubmittedPending()).length) {
        rechargeLog("轮询超时(20分钟),请手动点击「刷新状态」查询最新进度");
    }
}

app.post("/api/recharge/poll", async (req, res) => {
    const ids = (req.body?.ids || []).map(Number).filter(Number.isInteger);
    let targets: any[];
    const skipped: {email: string; reason: string}[] = [];
    if (ids.length) {
        const rows = (await Promise.all(ids.map((id: number) => db.getRechargeQueueItem(id)))).filter(Boolean);
        targets = [];
        for (const q of rows) {
            if (!q.card_code) { skipped.push({email: q.email, reason: `仍是${q.status || "pending"}、无卡密，平台查不到任务`}); continue; }
            if (q.status === "done") { skipped.push({email: q.email, reason: "已完成"}); continue; }
            targets.push(q);
        }
        if (!targets.length) {
            const msg = skipped.map((s) => `${s.email}: ${s.reason}`).join("；") || "无需刷新的队列项";
            rechargeLog(`刷新跳过: ${msg}`);
            return res.status(400).json({error: msg, skipped});
        }
    } else {
        targets = await db.listQueueSubmittedPending();
    }
    if (!targets.length) { rechargeLog("无需刷新的队列项"); return res.json({ok: true, updated: 0}); }
    rechargeLog(`刷新状态: ${targets.length} 个 (${targets.map((q: any) => q.card_code.slice(0, 8) + "...").join(", ")})`);
    let updated = 0;
    try {
        const codes = targets.map((q: any) => q.card_code);
        for (let i = 0; i < codes.length; i += 50) {
            const chunk = codes.slice(i, i + 50);
            const data = await callRechargeApi("POST", "/tasks/lookup-batch", {redeem_codes: chunk});
            const results = data.results || [];
            rechargeLog(`  平台返回 ${results.length} 条结果`);
            for (const r of results) {
                if (!r.ok) { rechargeLog(`  ${r.redeem_code?.slice(0, 8) || "?"}... 查询失败: ${r.error || "未知"}`); continue; }
                const task = r.task || {};
                const q = targets.find((x: any) => x.card_code.replace(/-/g, "") === (r.redeem_code || "").replace(/-/g, ""));
                if (!q) {
                    rechargeLog(`  平台返回卡密 [${r.redeem_code}] 未匹配到队列(状态: ${task.status}, 本地存储: ${targets.map((x: any) => x.card_code).join(",")})`);
                    continue;
                }
                const oldStatus = q.task_status;
                const updates: any = {task_status: task.status || "", task_message: task.message || ""};
                if (task.task_no && !q.task_no) updates.task_no = task.task_no;
                if (task.status === "paid") updates.status = "done";
                else if (["failed", "canceled", "returned"].includes(task.status)) updates.status = "error";
                if (updates.status === "done" || updates.status === "error") updates.finished_at = Date.now();
                await db.updateQueueItem(q.id, updates);
                if (q.card_id) {
                    if (task.status === "returned") {
                        await db.unpairRechargeCards([q.card_id]);
                        rechargeLog(`  卡密 ${q.card_code.slice(0, 8)}... 已退回，自动回收到卡池`);
                    } else {
                        await db.updateRechargeCard(q.card_id, updates);
                    }
                }
                updated++;
                if (task.status !== oldStatus) {
                    rechargeLog(`  ${q.email}: ${oldStatus || "—"} → ${task.status}${task.message ? " (" + task.message + ")" : ""}`);
                }
                if (task.status === "paid") enqueueGmailRebind(q);
            }
        }
    } catch (e: any) {
        rechargeLog(`刷新出错: ${e?.message || e}`);
        return res.status(500).json({error: `刷新失败: ${e?.message || e}`});
    }
    rechargeLog(`刷新完成: ${updated} 个已更新`);
    await queueSync(); await rechargeSync();
    res.json({ok: true, updated});
});

app.get("/api/recharge/rebind-gmail/pool", async (req, res) => {
    try {
        const pool = await db.listRebindGmailPool();
        res.json({ok: true, ...pool});
    } catch (e: any) {
        res.status(500).json({error: String(e?.message || e)});
    }
});

app.post("/api/recharge/rebind-gmail", async (req, res) => {
    const ids = (req.body?.ids || []).map(Number).filter(Number.isInteger);
    if (!ids.length) return res.status(400).json({error: "未选择队列项"});
    const target = normalizeRebindTarget(req.body?.target);
    const pool = normalizeRebindPool(req.body || {});
    const skipped: {email: string; reason: string}[] = [];
    let queued = 0;
    for (const id of ids) {
        const q = await db.getRechargeQueueItem(id);
        if (!q) { skipped.push({email: String(id), reason: "不存在"}); continue; }
        if (q.rebind_status === "pending" && gmailRebindQueued.has(id)) { skipped.push({email: q.email, reason: "换绑中"}); continue; }
        if (q.task_status !== "paid" && q.status !== "done") {
            skipped.push({email: q.email, reason: `未付费(${q.task_status || q.status || "—"})`});
            continue;
        }
        const dest = resolveRebindTarget(q, {force: true, target});
        if (enqueueGmailRebind(q, {force: true, target: dest, pool})) {
            queued++;
            const hint = dest === "gmail" ? rebindPoolHint(pool) : "";
            rechargeLog(`换绑排队 ${q.email} → ${rebindTargetLabel(dest)}${hint ? hint.replace(/^，范围=/, "（") + "）" : ""}`);
        } else {
            skipped.push({email: q.email, reason: "已在换绑"});
        }
    }
    await queueSync();
    res.json({
        ok: true, queued, skipped,
        gmailFreeImap: await db.countFreeGoogleImapMailboxes(),
        mailcomFree: await db.countFreeMailcomMailboxes(),
    });
});

app.post("/api/recharge/rebind-gmail/cancel", async (req, res) => {
    const ids = (req.body?.ids || []).map(Number).filter(Number.isInteger);
    if (!ids.length) return res.status(400).json({error: "未选择队列项"});
    let count = 0;
    for (const id of ids) {
        const q = await db.getRechargeQueueItem(id);
        if (!q || q.rebind_status !== "pending") continue;
        gmailRebindCancelled.add(id);
        const i = gmailRebindIds.indexOf(id);
        if (i >= 0) gmailRebindIds.splice(i, 1);
        gmailRebindQueued.delete(id);
        gmailRebindTargets.delete(id);
        gmailRebindPool.delete(id);
        await db.updateQueueItem(id, {rebind_status: "fail", rebind_error: "已取消换绑", rebind_pool: null});
        rechargeLog(`换绑已取消 ${q.email}${gmailRebindCurrentId === id ? "（当前任务将在下一步停下）" : ""}`);
        count++;
    }
    await queueSync();
    res.json({ok: true, count});
});

// 导出队列账号
app.post("/api/recharge/queue/export", async (req, res) => {
    const ids = (req.body?.ids || []).map(Number).filter(Number.isInteger);
    const batch = req.body?.batch || "";
    const format = req.body?.format || "account"; // account | full
    const rows = await db.listRechargeQueueFull(ids.length ? ids : undefined, batch || undefined);
    if (!rows.length) return res.status(400).json({error: "无数据可导出"});
    const sep = "----";

    if (format === "account") {
        const text = rows.map((r: any) => `${r.email}${sep}${r.password}${r.card_code ? sep + r.card_code : ""}`).join("\n");
        return res.set("Content-Type", "text/plain; charset=utf-8").send(text);
    }
    if (format === "card") {
        const text = rows.filter((r: any) => r.card_code).map((r: any) => r.card_code).join("\n");
        if (!text) return res.status(400).json({error: "选中项无卡密"});
        return res.set("Content-Type", "text/plain; charset=utf-8").send(text);
    }
    if (format === "session") {
        const lines = rows.map((r: any) => {
            const authObj = r.gpt_auth_data || r.auth_data || readJsonFileSafe(r.gpt_auth_file) || readJsonFileSafe(r.auth_file);
            const sess = extractSession(authObj);
            return sess ? JSON.stringify(sess) : "";
        }).filter(Boolean);
        if (!lines.length) return res.status(400).json({error: "选中项无 session 数据"});
        return res.set("Content-Type", "text/plain; charset=utf-8").send(lines.join("\n"));
    }

    // sub2json 预备行：email----密码----refresh_token（Gmail / mail.com 通用）
    // 密码优先 gpt_password（Gmail 登录 GPT 用），否则邮箱密码；无 rt 也输出（末段空，前端可提示补 RT）
    if (format === "sub2json") {
        let withRt = 0;
        const lines = rows.map((r: any) => {
            const sources = [
                r.gpt_rt_data,
                readJsonFileSafe(r.rt_file),
                r.gpt_auth_data,
                readJsonFileSafe(r.gpt_auth_file),
                r.auth_data,
                readJsonFileSafe(r.auth_file),
            ];
            let rt = "";
            for (const src of sources) {
                const t = extractTokens(src);
                if (t?.refreshToken) { rt = t.refreshToken; break; }
            }
            if (rt) withRt++;
            // Gmail 必须用 GPT 密码；mail.com 通常 gpt_password 空则回落邮箱密码
            const pw = String(r.gpt_password || r.password || "").trim();
            return `${r.email}${sep}${pw}${sep}${rt}`;
        });
        return res.json({
            ok: true,
            text: lines.join("\n"),
            total: rows.length,
            withRt,
            missingRt: rows.length - withRt,
        });
    }

    // full 格式: 先检查是否需要获取 RT，需要则异步执行后通过 SSE 推送结果
    const needRt = rows.filter((r: any) => {
        const tok = extractTokens(r.gpt_rt_data || r.gpt_auth_data || readJsonFileSafe(r.rt_file) || readJsonFileSafe(r.gpt_auth_file));
        return !tok?.refreshToken;
    });

    if (!needRt.length) {
        const text = rows.map((r: any) => {
            const tok = extractTokens(r.gpt_rt_data || r.gpt_auth_data || readJsonFileSafe(r.rt_file) || readJsonFileSafe(r.gpt_auth_file));
            return formatAccountExportLine(r, {rt: tok?.refreshToken || "", sep});
        }).join("\n");
        return res.set("Content-Type", "text/plain; charset=utf-8").send(text);
    }

    // 有账号缺少 RT → 异步并发获取，完成后 SSE 推送
    if (exportRtBusy) {
        rechargeLog("已有导出含RT在跑，请等当前这批打出「RT 获取完成」");
        return res.status(409).json({error: "已有导出含RT在跑"});
    }
    const rtConc = Math.min(2, scheduler.rtConcurrency || 4);
    res.json({ok: true, async: true, total: rows.length, needRt: needRt.length});
    rechargeLog(`导出含RT: ${needRt.length}/${rows.length} 个账号缺少 RT，并发${rtConc}获取中...`);
    exportRtBusy = true;
    (async () => {
        let ok = 0, fail = 0, done = 0;
        try {
        await runPool(needRt, async (r) => {
            const idx = ++done;
            const acc = await db.getAccount(r.account_id);
            if (!acc) { fail++; rechargeLog(`[${idx}/${needRt.length}] ✗ ${r.email} 账号不存在`); return; }
            const already = extractTokens(getRtData(acc) || getAuthData(acc));
            if (already?.refreshToken) {
                ok++;
                rechargeLog(`[${idx}/${needRt.length}] ✓ ${r.email} 已有 RT，跳过获取`);
                return;
            }
            rechargeLog(`[${idx}/${needRt.length}] 获取 RT: ${r.email}...`);
            try {
                const result = await testOneRt(acc, {
                    acquire: true,
                    onProgress: (m) => rechargeLog(`  ${r.email}: ${String(m || "").slice(0, 120)}`),
                });
                if (result.ok) { ok++; rechargeLog(`[${idx}/${needRt.length}] ✓ ${r.email}${result.plan_type ? " · " + result.plan_type : ""}`); }
                else { fail++; rechargeLog(`[${idx}/${needRt.length}] ✗ ${r.email} ${result.reason || "失败"}`); }
            } catch (e: any) { fail++; rechargeLog(`[${idx}/${needRt.length}] ✗ ${r.email} ${e?.message || e}`); }
        }, rtConc);
        } finally {
            exportRtBusy = false;
        }
        rechargeLog(`RT 获取完成: 成功 ${ok} / 失败 ${fail}`);
        // 重新查询最新数据并通过 SSE 推送
        const freshRows = await db.listRechargeQueueFull(ids.length ? ids : undefined, batch || undefined);
        const text = freshRows.map((r: any) => {
            const tok = extractTokens(r.gpt_rt_data || r.gpt_auth_data || readJsonFileSafe(r.rt_file) || readJsonFileSafe(r.gpt_auth_file));
            return formatAccountExportLine(r, {rt: tok?.refreshToken || "", sep});
        }).join("\n");
        broadcast("rechargeExportReady", {text});
        rechargeLog(`导出含RT 已就绪，共 ${freshRows.length} 条`);
    })();
});


// 查询套餐
app.post("/api/recharge/queue/probe-plan", async (req, res) => {
    const ids = (req.body?.ids || []).map(Number).filter(Number.isInteger);
    const batch = req.body?.batch || "";
    let targets: any[];
    if (ids.length) {
        targets = (await Promise.all(ids.map((id: number) => db.getRechargeQueueItem(id)))).filter(Boolean);
    } else if (batch) {
        targets = (await db.listRechargeQueue()).filter((q: any) => q.batch === batch);
    } else {
        targets = await db.listRechargeQueue();
    }
    if (!targets.length) return res.json({ok: true, updated: 0});
    const dispatcher = buildProxyDispatcher(scheduler.regProxy);
    res.json({ok: true, count: targets.length});
    rechargeLog(`查询套餐: ${targets.length} 个账号`);
    let ok = 0, fail = 0;
    for (let i = 0; i < targets.length; i++) {
        const q = targets[i];
        const acc = await db.getAccount(q.account_id);
        const tok = extractTokens(getAuthData(acc) || q.auth_data || readJsonFileSafe(q.auth_file));
        if (!tok?.accessToken) {
            fail++;
            rechargeLog(`[${i + 1}/${targets.length}] ✗ ${q.email} 无 AT`);
            continue;
        }
        const rtTok = extractTokens(getRtData(acc) || getAuthData(acc) || q.auth_data || readJsonFileSafe(q.auth_file));
        const r = await probePlan(tok.accessToken, tok.accountId, dispatcher, 12000, rtTok?.refreshToken);
        if (i === 0 && r._debug) {
            rechargeLog(`[调试] endpoint=${r._debug.endpoint}, raw="${r._debug.raw}"`);
        }
        if (r.ok) {
            await db.updateQueueItem(q.id, {plan_type: r.plan_type});
            ok++;
            rechargeLog(`[${i + 1}/${targets.length}] ${q.email} → ${r.plan_type}${r.has_active_subscription ? "(订阅中)" : ""}`);
        } else {
            fail++;
            rechargeLog(`[${i + 1}/${targets.length}] ✗ ${q.email} ${r.error}`);
        }
    }
    await queueSync();
    rechargeLog(`套餐查询完成: 成功 ${ok} / 失败 ${fail}`);
});

// ---------- 静态前端(生产) ----------
if (existsSync(WEB_DIST)) {
    app.use(express.static(WEB_DIST, {setHeaders: (res, p) => { if (p.endsWith(".html")) res.setHeader("Cache-Control", "no-cache"); }}));
    app.get(/^(?!\/api).*/, (req, res) => { res.set("Cache-Control", "no-cache"); res.sendFile(path.join(WEB_DIST, "index.html")); });
}

setMailProxy(scheduler.mailProxyEnabled !== false ? (scheduler.mailProxy || "") : ""); // 收件箱初始用邮箱代理(受开关控制)
// GPT 注册不再走独立 vless/xray，统一用邮箱代理池（跳板 + 导入出口）。清掉旧自启。
try { stopXray(); } catch { /* */ }
if (scheduler.xrayVless) {
    console.log("[server] 已停用 GPT 独立 vless，改走代理池");
    scheduler.xrayVless = "";
}
{
    const localXray = new RegExp(`^socks5h?://127\\.0\\.0\\.1:${Number(scheduler.regProxyPort) || 10809}$`, "i");
    if (localXray.test(String(scheduler.regProxy || "").trim())) {
        scheduler.regProxy = "";
        console.log("[server] 已清空指向独立 xray 的 regProxy，注册改租代理池");
    }
}
scheduler.saveSettings();
if (scheduler.claudeXrayVless) {
    try {
        const r = startXray(scheduler.claudeXrayVless, {name: "claude", localPort: scheduler.claudeProxyPort, binPath: scheduler.xrayBinPath || undefined});
        scheduler.claudeProxy = `socks5://127.0.0.1:${r.port}`;
        console.log(`[server] Claude 独立 xray 已自启: ${r.node} @ 127.0.0.1:${r.port}`);
    } catch (e: any) { console.warn(`[server] Claude xray 自启失败(不影响服务): ${e?.message ?? e}`); }
}
try {
    const fleet = await scheduler.ensureJumpFleet();
    if (fleet.length) {
        console.log(`[server] 跳板 xray 已自启 ${fleet.length} 条（不占用 10808）: ${fleet.map((f) => `${f.node || "?"}@${f.port}${f.running ? "" : " 失败"}`).join(", ")}`);
    }
} catch (e: any) { console.warn(`[server] 跳板 xray 自启失败: ${e?.message ?? e}`); }
await ensureSchema();
await initDb();
await db.init();

const HTTP_PID_PATH = path.resolve(__dirname, "..", "data", "http-3100.pid");
function collectPidsOnPort(port) {
    const me = process.pid;
    const pids = new Set();
    try {
        if (process.platform === "win32") {
            const out = execSync("netstat -ano", {encoding: "utf8"});
            for (const line of out.split(/\r?\n/)) {
                if (!/LISTENING/i.test(line)) continue;
                if (!line.includes(`:${port} `) && !new RegExp(`:${port}\\s`).test(line)) continue;
                const pid = Number(line.trim().split(/\s+/).pop());
                if (pid && pid !== me) pids.add(pid);
            }
        } else {
            const out = execSync(`lsof -ti tcp:${port} -sTCP:LISTEN || true`, {encoding: "utf8"});
            for (const pid of out.split(/\s+/).map(Number).filter(Boolean)) {
                if (pid !== me) pids.add(pid);
            }
        }
    } catch { /* */ }
    try {
        const prev = existsSync(HTTP_PID_PATH) ? Number(String(readFileSync(HTTP_PID_PATH, "utf8") || "").trim()) : 0;
        if (prev && prev !== me) pids.add(prev);
    } catch { /* */ }
    return [...pids];
}
function killExistingHttp(port) {
    const me = process.pid;
    if (process.platform === "win32") {
        try {
            const out = execSync(
                `powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \\"Name='node.exe'\\" | Where-Object { $_.CommandLine -and $_.CommandLine -match 'server[/\\\\]index\\\\.ts|tsx server' } | ForEach-Object { $_.ProcessId }"`,
                {encoding: "utf8"},
            );
            for (const pid of out.split(/\s+/).map(Number).filter((p) => p && p !== me)) {
                try { execSync(`taskkill /F /PID ${pid}`, {stdio: "ignore"}); } catch { /* */ }
                console.log(`[server] 先结束残留 server/index.ts pid=${pid}`);
            }
        } catch { /* */ }
    }
    const pids = collectPidsOnPort(port);
    for (const pid of pids) {
        try {
            if (process.platform === "win32") execSync(`taskkill /F /PID ${pid}`, {stdio: "ignore"});
            else process.kill(pid, "SIGKILL");
            console.log(`[server] 先结束旧 :${port} pid=${pid}，再启动（强制结束，不走关窗收尾）`);
        } catch { /* 已经没了 */ }
    }
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline && collectPidsOnPort(port).length) {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 80);
    }
}
killExistingHttp(PORT);
killSiblingIndexProcesses();
try { writeFileSync(HTTP_PID_PATH, String(process.pid), "utf8"); } catch { /* */ }
const dropHttpPid = () => { try { unlinkSync(HTTP_PID_PATH); } catch { /* */ } };
process.on("exit", dropHttpPid);

const httpServer = app.listen(PORT, "0.0.0.0", () => {
    httpReady = true;
    console.log(`[server] http://localhost:${PORT}  instance=${db.instanceId}  (前端 ${existsSync(WEB_DIST) ? "已托管" : "未构建, 用 vite dev"})`);
    db.setMailClaimPaused(false).catch(() => {});
    db.drainPendingPwQueueToMailJobs().then((n) => {
        if (n) console.log(`[mail-jobs] 已把 ${n} 条旧 pw_queue 迁入 mail_jobs`);
    }).catch((e) => console.warn("[mail-jobs] 迁移 pw_queue 失败:", e?.message || e));
    refreshMailboxJobWindows({listBit: false}).catch(() => {});
    (async () => {
        try {
            const {sweepStaleBitWindows} = await import("../src/bitbrowser.js");
            const n = await sweepStaleBitWindows({
                includeClosed: true, onlyClosed: true, minAgeMs: 10 * 60 * 1000,
                log: (m) => console.log(m),
            });
            if (n) console.log(`[指纹] 启动只清已关残留 ${n} 个（不开着的窗）`);
        } catch (e: any) {
            console.warn(`[指纹] 启动清理失败: ${e?.message || e}`);
        }
        tickMailJobs().catch(() => {});
    })();
    setInterval(() => {
        const busy = lastMailJobProg?.running || lastHardenWindows.some((w) => w.status === 1) || localMailJobIds.size > 0;
        refreshMailboxJobWindows({listBit: busy}).catch(() => {});
    }, 30_000);
    setInterval(() => { tickMailJobs().catch(() => {}); }, 2000);
    setInterval(() => { db.heartbeatMailJobs(db.instanceId).catch(() => {}); }, 15000);
    db.listPendingGmailRebinds().then((rows) => {
        if (!rows.length) return;
        rechargeLog(`启动恢复：${rows.length} 个换绑停在进行中，重新排队`);
        for (const q of rows) enqueueGmailRebind(q, {force: true, pool: q.rebind_pool || {}});
    }).catch((e) => console.warn("[server] 恢复换绑失败:", e?.message || e));
});
httpServer.on("error", (e) => {
    console.error(`[server] 无法占用 :${PORT}（${e?.message || e}），本进程退出，避免无端口还领任务开窗`);
    process.exit(1);
});

// 单实例关闭:停本机认领,杀本机 worker,把未完成任务退回共池(其他实例可接着跑)。不碰其他实例的 running。
async function shutdownThisInstance(signal: string) {
    if (instanceShuttingDown) return;
    instanceShuttingDown = true;
    console.log(`[server] ${signal} 关闭本实例 ${db.instanceId},释放未完成任务…`);
    queueReloginStop = true;
    rechargeStop = true;
    batchHardenStop = true;
    try { await closeTrackedBitWindows(); } catch { /* */ }
    scheduler.pause();
    scheduler.pauseClaude();
    scheduler.releasingGpt = true;
    scheduler.releasingClaude = true;
    scheduler.killDomain("gpt");
    scheduler.killDomain("claude");
    const deadline = Date.now() + 5000;
    while (scheduler.running.size && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 100));
    }
    try {
        const r = await db.releaseInstanceWork(db.instanceId);
        console.log(`[server] 已释放 gpt=${r.gpt} claude=${r.claude} sms=${r.sms} pw=${r.pw} mail=${r.mail || 0} recharge=${r.recharge}`);
    } catch (e: any) {
        console.warn(`[server] 释放任务失败: ${e?.message ?? e}`);
    }
    process.exit(0);
}
process.on("SIGINT", () => { shutdownThisInstance("SIGINT"); });
process.on("SIGTERM", () => { shutdownThisInstance("SIGTERM"); });
