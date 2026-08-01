// @ts-nocheck
// 后端服务：REST(导入/控制/下载) + SSE(实时日志/状态/统计) + 静态托管前端
import express from "express";
import cors from "cors";
import {existsSync, readFileSync, writeFileSync, mkdtempSync, rmSync} from "node:fs";
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
import {randomPassword} from "../src/utils.js";
import {openBrowserWithAuth} from "../src/simulate-chat.js";
import {bitHealth} from "../src/bitbrowser.js";
import {peekSms, buildSmsLink, classifySms} from "../src/sms-broker.js";
import {probeAt, probePlan, refreshRt, buildProxyDispatcher, decodeJwt} from "../src/token-check.js";
import {startXray, stopXray, xrayStatus} from "./xray-proxy.js";
import {queryClaudeInfo, claudeChat} from "../src/claude-api.js";
import {execSync} from "node:child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// 凭证读取辅助：DB JSONB 列优先，回退文件读取
function readJsonFileSafe(p) { try { return p ? JSON.parse(readFileSync(p, "utf8")) : null; } catch { return null; } }
function getAuthData(acc) { return acc?.auth_data || readJsonFileSafe(acc?.auth_file); }
function getRtData(acc) { return acc?.rt_data || readJsonFileSafe(acc?.rt_file); }
const PORT = Number(process.env.PORT || 3100);
const WEB_DIST = path.resolve(__dirname, "..", "web", "dist");

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
        if (!rest.startsWith("mailboxes") && !rest.startsWith("claude")) req.url = "/api/" + rest;
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
    res.write(`event: hello\ndata: ${JSON.stringify({state: {...scheduler.state(), batchPw: {...batchPwProg}}, stats: await db.stats()})}\n\n`);
    const ping = setInterval(() => { try { res.write(`event: ping\ndata: {}\n\n`); } catch { /* */ } }, 25000);
    req.on("close", () => { clearInterval(ping); sseClients.delete(res); });
});

// ---------- 解析邮箱文本: 优先用配置分隔符,回退支持 空白/:/, 等常见分隔 ----------
function parseAccounts(text, fallbackPassword) {
    const sep = scheduler.mailSeparator || "----";
    const sepRe = new RegExp(sep.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")); // 转义特殊字符
    const rows = [];
    for (const raw of String(text || "").split(/\r?\n/)) {
        const line = raw.trim();
        if (!line) continue;
        // 优先按配置分隔符切,切不出再回退通用分隔
        let parts = line.split(sepRe).map((s) => s.trim()).filter(Boolean);
        if (parts.length < 2) parts = line.split(/[\s,;:|\t]+/).filter(Boolean);
        const email = (parts[0] || "").toLowerCase();
        const password = parts[1] || fallbackPassword || "";
        if (/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) && password) {
            rows.push({email, password});
        }
    }
    return rows;
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
    const result = await db.importFreeMailboxes(rows, String(req.body.grp || "").trim(), usage, String(req.body.provider || "mailcom"));
    broadcast("mailboxes", {stats: await db.mailboxStats()});
    // 导入后自动改密(可选):对刚导入的邮箱(free 或 hold)批量改随机20位(headed 串行,后台跑)
    if (req.body.autoChangePw && !batchPwRunning && !scheduler.maintLock) {
        const emails = new Set(rows.map((r) => r.email.toLowerCase()));
        const items = (await db.listMailboxes()).filter((m) => emails.has(m.email) && (m.usage === "free" || m.usage === "hold")).map((m) => ({id: m.id, email: m.email, oldPw: m.password}));
        if (items.length) { scheduler.acquireLock("import-auto-pw"); startBatchPasswd(items, mailboxPwApply, "导入后改密"); return res.json({...result, autoChangePw: items.length}); }
    }
    res.json(result);
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
            if (batchPwRunning) return res.status(409).json({error: "已有批量改密在跑,请等待完成或先停止后再用「先改密」分配"});
            if (scheduler.maintLock) return res.status(409).json({error: `有浏览器任务在跑(${scheduler.maintLock}),请等待完成`});
            const mbs = (await Promise.all(ids.map((id) => db.getMailbox(id)))).filter((m) => m && m.usage === "free");
            if (!mbs.length) return res.status(400).json({error: "选中的邮箱都不是待分配(free)状态,无法先改密"});
            const items = mbs.map((m) => ({id: m.id, email: m.email, oldPw: m.password}));
            scheduler.acquireLock("changePwFirst");
            res.json({ok: true, changePwFirst: true, willChange: items.length});
            // 全部改完再一次性分配注册(全程持锁,改密和注册严格串行)
            startBatchPasswd(items, mailboxPwApply, "分配前改密", async () => {
                const r = await db.allocateMailboxIdsTo(usage, ids, batch);
                scheduler.releaseLock("changePwFirst");
                await afterAlloc();
                console.log(`[分配前改密] 改密完成 → 已分配 ${r.allocated} 个给 ${usage}(跳过 ${r.skipped})`);
            });
            return;
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
app.post("/api/mailboxes/:id/change-passwd", async (req, res) => {
    const id = Number(req.params.id);
    const mb = await db.getMailbox(id);
    if (!mb) return res.status(404).json({error: "邮箱不存在"});
    const np = String(req.body.newPassword || "").trim() || randomPassword(20);
    logMailbox(id, `[改密] 单个改密,新密码=${np}`); // 记明文:失败也能挽救
    try {
        const r = await changeMailcomPassword(mb.email, mb.password, np, (m) => logMailbox(id, `[改密] ${m}`));
        if (r?.ok) { await db.setMailboxPassword(id, np, `✅已改 ${pwStamp()}${r.verified ? "(验证)" : "?未验证"}`); logMailbox(id, `[改密] 成功,已同步库`); broadcast("mailboxes", {stats: await db.mailboxStats()}); res.json({ok: true, newPassword: np}); }
        else { await db.setMailboxPassword(id, mb.password, `❌试过 ${np}·${String(r?.detail || "失败").slice(0, 30)}`); logMailbox(id, `[改密] 失败(新密码 ${np} 已记录): ${r?.detail || "未见成功确认"}`); res.json({ok: false, newPassword: np, detail: r?.detail}); }
    } catch (e: any) { logMailbox(id, `[改密] 异常: ${e?.message ?? e}`); res.status(500).json({error: String(e?.message ?? e)}); }
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

// ---- 邮箱域:收件箱/正文/操作日志(架构 v2:收件箱等邮箱能力集中到邮箱管理,覆盖 free/gpt/claude 所有邮箱)----
// 收件箱:用邮箱账密登录 mail.com 拉列表(起浏览器,约 20~30s)。
app.get("/api/mailboxes/:id/inbox", async (req, res) => {
    const id = Number(req.params.id);
    const mb = await db.getMailbox(id);
    if (!mb) return res.status(404).json({error: "邮箱不存在"});
    logMailbox(id, "[收信] 登录 mail.com 拉取收件箱…");
    try {
        const mails = await fetchInboxList(mb.email, mb.password);
        logMailbox(id, `[收信] 登录成功,收件箱 ${mails.length} 封`);
        res.json({email: mb.email, mails});
    } catch (e: any) { logMailbox(id, `[收信] 失败: ${e?.message ?? e}`); res.status(500).json({error: String(e?.message ?? e)}); }
});
// 按需拉单封正文(复用收件箱缓存会话,秒级)
app.get("/api/mailboxes/:id/mail/:mailId/body", async (req, res) => {
    const mb = await db.getMailbox(Number(req.params.id));
    if (!mb) return res.status(404).json({error: "邮箱不存在"});
    try { res.json({body: await fetchMailBodyFor(mb.email, req.params.mailId)}); }
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
    // 端口变了→对应 xray 若在跑则用新端口重启(regProxy/claudeProxy 自动跟随 r.port);startXray 只清理"自己这个端口",不碰其他进程
    try { if (scheduler.xrayVless) { const r = startXray(scheduler.xrayVless, {localPort: scheduler.regProxyPort, binPath: scheduler.xrayBinPath || undefined}); scheduler.regProxy = `socks5://127.0.0.1:${r.port}`; } } catch { /* 起失败保留旧代理 */ }
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

app.get("/api/accounts", async (req, res) => res.json(await db.listAccounts(req.query.status)));
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
    for (const k of ["email", "password", "status", "plan", "phone", "card", "at_status", "rt_status", "chat_status", "error"]) {
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
// 批量串行改密(通用引擎):headed 一次一个,后台跑、SSE 进度推送。改密是邮箱能力,GPT/邮箱域共用此引擎。
let batchPwRunning = false, batchPwStop = false;
const batchPwProg = {running: false, done: 0, total: 0, ok: 0, stopped: false}; // 进度快照(供 /api/state 刷新后恢复)
// items=[{id,email,oldPw}](oldPw 可为 string|string[] 做自愈候选);apply(item,{ok,np,verified,detail})=写库+广播。
// onDone(可选):全部跑完(或停止)后回调 {done, ok, stopped},用于"先改密再分配"等链式流程。
function startBatchPasswd(items, apply, tag = "批量改密", onDone) {
    const lockOwner = scheduler.maintLock; // 调用点已 acquireLock,记住 owner 用于结束时释放
    batchPwRunning = true; batchPwStop = false;
    Object.assign(batchPwProg, {running: true, done: 0, total: items.length, ok: 0, stopped: false});
    broadcast("batchPw", {...batchPwProg});
    (async () => {
        // 等已跑的注册完成(锁已设,tick 不会认领新的)
        if (scheduler.running.size > 0) {
            broadcast("log", {id: 0, line: `[${tag}] 等待 ${scheduler.running.size} 个注册任务完成…`, ts: Date.now()});
            await waitRegIdle();
        }
        let done = 0, okc = 0;
        const conc = scheduler.pwConcurrency || 1;
        await runPool(items, async (it) => {
            if (batchPwStop) return;
            const np = randomPassword(20);
            logMailbox(it.id, `[改密] ${tag}(${done + 1}/${items.length}),新密码=${np}`);
            try {
                const r = await changeMailcomPassword(it.email, it.oldPw, np, (m) => logMailbox(it.id, `[改密] ${m}`));
                if (r?.ok) { await apply(it, {ok: true, np, verified: r.verified}); okc += 1; logMailbox(it.id, `[改密] 成功`); }
                else { await apply(it, {ok: false, np, detail: r?.detail || "失败"}); logMailbox(it.id, `[改密] 失败(新密码 ${np} 已记录)`); }
            } catch (e) {
                await apply(it, {ok: false, np, detail: String(e?.message || e)}); logMailbox(it.id, `[改密] 异常(新密码 ${np} 已记录): ${e?.message || e}`);
            }
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
        // onDone 里可能已经释放了锁(如 changePwFirst),这里兜底确保释放
        if (lockOwner && scheduler.maintLock === lockOwner) { scheduler.releaseLock(lockOwner); scheduler.tick(); }
    })();
}

// GPT 域批量改密已移除:所有邮箱改密统一在邮箱管理(POST /api/mailboxes/batch-change-passwd,覆盖 gpt 邮箱)。
// 邮箱域批量改密(★职责集中:所有邮箱改密统一入口,操作 mailboxes 表,覆盖 free/gpt/claude)。
// ids=选中的 mailbox id(必填);跳过库里没有的。改后广播 mailboxes 刷新。
app.post("/api/mailboxes/batch-change-passwd", async (req, res) => {
    if (batchPwRunning) return res.status(409).json({error: "已有批量改密在跑,请等待完成或先停止"});
    if (scheduler.maintLock) return res.status(409).json({error: `有浏览器任务在跑(${scheduler.maintLock}),请等待完成`});
    const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(Number) : [];
    const mbs = (await Promise.all(ids.map((id) => db.getMailbox(id)))).filter(Boolean);
    if (!mbs.length) return res.json({ok: true, count: 0, msg: "未选择有效邮箱"});
    scheduler.acquireLock("batch-pw");
    res.json({ok: true, count: mbs.length});
    const items = mbs.map((m) => ({id: m.id, email: m.email, oldPw: m.password}));
    startBatchPasswd(items, mailboxPwApply, "邮箱批量改密");
});

// 邮箱改密结果写库(mailboxes 表)+ 广播。批量改密/导入后改密共用(DRY)。失败保留原密码,只记状态。
const mailboxPwApply = async (it, {ok, np, verified, detail}) => {
    const mb = await db.getMailbox(it.id);
    if (ok) await db.setMailboxPassword(it.id, np, `✅已改 ${pwStamp()}${verified ? "(验证)" : "?未验证"}`);
    else await db.setMailboxPassword(it.id, mb?.password ?? "", `❌试过 ${np}·${String(detail).slice(0, 30)}`);
    broadcast("mailboxes", {stats: await db.mailboxStats()});
};
// 停止批量改密(当前正在改的那个号会跑完,之后不再开始;正在跑的浏览器不强杀)
app.post("/api/control/batch-passwd/stop", (req, res) => {
    if (!batchPwRunning) return res.json({ok: true, msg: "当前无批量改密任务"});
    batchPwStop = true;
    res.json({ok: true});
});
app.post("/api/control/pw-concurrency", (req, res) => res.json({ok: true, pwConcurrency: scheduler.setPwConcurrency(req.body?.pwConcurrency)}));
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
function runRtWorker(acc, preferPhone) {
    return new Promise((resolve) => {
        const tmpDir = mkdtempSync(path.join(os.tmpdir(), "codex-rt-"));
        const tmpFile = path.join(tmpDir, `mc-${acc.id}.txt`);
        writeFileSync(tmpFile, `${acc.email}----${acc.password}\n`, "utf8");
        logAcct(acc.id, `[rt] 启动 worker 获取 refresh_token${preferPhone ? `(复用绑定号 +${preferPhone})` : ""}…`);
        const child = spawn(CHAT_TSX_BIN, ["src/worker-rt.ts"], { shell: IS_WIN,
            cwd: CHAT_ROOT,
            env: {
                ...process.env,
                REG_EMAIL: acc.email,
                MAIL_PROVIDER: acc.provider || "mailcom",
                MAILCOM_TOKENS_FILE: tmpFile, ICLOUD_TOKENS_FILE: tmpFile,
                MAILCOM_HEADLESS: "1",
                SMS_LINK_TEMPLATE: scheduler.smsLinkTemplate || "",
                SMS_MAX_BIND: String(scheduler.smsMaxBind ?? 0),
                RT_PREFER_PHONE: preferPhone || "",
                PROXY_URL: scheduler.regProxy || "",
                MAILCOM_PROXY: scheduler.mailProxy || "",
                // PG 迁移后 worker 通过 process.env.DATABASE_URL 继承连接
            },
        });
        let buf = "";
        let result = null;
        child.on("error", (e) => { logAcct(acc.id, `[rt] worker 启动失败: ${e?.message || e}`); resolve({ok: false, error: String(e?.message || e)}); });
        child.stdout.on("data", (d) => {
            buf += d.toString();
            let idx;
            while ((idx = buf.indexOf("\n")) >= 0) {
                const line = buf.slice(0, idx); buf = buf.slice(idx + 1);
                if (line.startsWith("@@EVENT@@")) {
                    try {
                        const ev = JSON.parse(line.slice(9));
                        if (ev.type === "progress") logAcct(acc.id, `[rt] ${ev.message}`);
                        else if (ev.type === "result") result = ev;
                    } catch { /* ignore */ }
                } else if (line.trim()) logAcct(acc.id, `[rt] ${line}`);
            }
        });
        child.stderr.on("data", (d) => logAcct(acc.id, `[rt:err] ${String(d).slice(0, 160)}`));
        child.on("close", async () => {
            try { rmSync(tmpDir, {recursive: true, force: true}); } catch { /* ignore */ }
            if (result && result.status === "success") {
                const rtData = readJsonFileSafe(result.rtFile);
                await db.setAccountRtFile(acc.id, result.rtFile || "", rtData);
                if (result.phone) await db.setAccountPhone(acc.id, result.phone);
                if (result.card) await db.setAccountCard(acc.id, result.card);
                await pushTestStatus(acc.id, "rt", "✅已获取rt");
                scheduler.emit("sms", {stats: await db.smsStats()}); // 接码池状态变化 → 前端刷新
                resolve({ok: true, refresh_token: result.rt});
            } else {
                await pushTestStatus(acc.id, "rt", "❌获取失败:" + String(result?.error || "进程异常").slice(0, 60));
                resolve({ok: false, reason: result?.error || "获取失败"});
            }
        });
        child.on("error", async (e) => {
            try { rmSync(tmpDir, {recursive: true, force: true}); } catch { /* ignore */ }
            await pushTestStatus(acc.id, "rt", "❌启动失败:" + (e?.message ?? e));
            resolve({ok: false});
        });
    });
}

// at 失效走【完整浏览器登录流程】重新拿 at:spawn worker-register-browser(已注册号走登录路径,邮箱+OTP),成功后更新 auth_file。
function runReloginAtWorker(acc) {
    return new Promise((resolve) => {
        const tmpDir = mkdtempSync(path.join(os.tmpdir(), "codex-relogin-"));
        const tmpFile = path.join(tmpDir, `mc-${acc.id}.txt`);
        writeFileSync(tmpFile, `${acc.email}----${acc.password}\n`, "utf8");
        logAcct(acc.id, "[at] 走浏览器登录流程重新获取 at(headed,约1-2分钟)…");
        const child = spawn(CHAT_TSX_BIN, ["src/worker-register-browser.ts"], {
            shell: IS_WIN, cwd: CHAT_ROOT,
            env: {
                ...process.env,
                REG_EMAIL: acc.email,
                MAIL_PROVIDER: acc.provider || "mailcom",
                MAILCOM_TOKENS_FILE: tmpFile, ICLOUD_TOKENS_FILE: tmpFile,
                MAILCOM_HEADLESS: "1",
                PROXY_URL: scheduler.regProxy || "",
                MAILCOM_PROXY: scheduler.mailProxy || "",
                REG_SIMULATE_CHAT: "", // 不养号
                REG_TRY_RT: "0",       // 不取 rt,只拿 at
                // PG 迁移后 worker 通过 process.env.DATABASE_URL 继承连接
            },
        });
        let buf = "", result = null;
        child.on("error", (e) => logAcct(acc.id, `[relogin-at] worker 启动失败: ${e?.message || e}`));
        child.stdout.on("data", (d) => {
            buf += d.toString(); let idx;
            while ((idx = buf.indexOf("\n")) >= 0) {
                const line = buf.slice(0, idx); buf = buf.slice(idx + 1);
                if (line.startsWith("@@EVENT@@")) {
                    try { const ev = JSON.parse(line.slice(9)); if (ev.type === "progress") logAcct(acc.id, `[at] ${ev.message}`); else if (ev.type === "result") result = ev; } catch { /* ignore */ }
                } else if (line.trim()) logAcct(acc.id, `[at] ${line}`);
            }
        });
        child.stderr.on("data", (d) => logAcct(acc.id, `[at:err] ${String(d).slice(0, 160)}`));
        child.on("close", async () => {
            try { rmSync(tmpDir, {recursive: true, force: true}); } catch { /* ignore */ }
            if (result && result.status === "success" && result.authFile) {
                const authData = readJsonFileSafe(result.authFile);
                await db.updateAccount(acc.id, {auth_file: result.authFile, auth_data: authData});
                broadcast("snapshot", await db.listAccounts());
                resolve({ok: true, authFile: result.authFile});
            } else {
                const err = result?.error || "登录获取 at 失败";
                // 登录时若发现账号被停用 → 写入 error(进"已停用"筛选,一键筛出批量删)
                if (/account_deactivated/i.test(err)) { await db.updateAccount(acc.id, {error: err}); broadcast("snapshot", await db.listAccounts()); }
                resolve({ok: false, reason: err});
            }
        });
        child.on("error", (e) => { try { rmSync(tmpDir, {recursive: true, force: true}); } catch { /* */ } resolve({ok: false, reason: String(e?.message ?? e)}); });
    });
}

// rt 三态：有效→刷新写回；已过期→复用绑定号重新获取；无rt→获取。acquire=false 时不自动获取(批量用，避免误耗接码)。
async function testOneRt(acc, {updateRt = true, acquire = false} = {}) {
    await pushTestStatus(acc.id, "rt", "测试中…");
    const rtData = getRtData(acc);
    const tok = extractTokens(rtData || getAuthData(acc));
    if (tok && tok.refreshToken) {
        let r = await refreshRt(tok.refreshToken, buildProxyDispatcher(scheduler.regProxy));
        if (!r.ok) { // 失败重试一次:过滤网络/代理抖动,两次都失败才算过期(避免抖动误判 dead)
            await pushTestStatus(acc.id, "rt", "失败,重试中…");
            await new Promise((s) => setTimeout(s, 2500));
            r = await refreshRt(tok.refreshToken, buildProxyDispatcher(scheduler.regProxy));
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
            return r;
        }
        // rt 存在但刷新失败 = 过期/失效 → 复用绑定号重新获取
        if (!acquire) { await pushTestStatus(acc.id, "rt", "❌" + r.reason); return r; }
        await pushTestStatus(acc.id, "rt", "过期,重新获取中…");
        return runRtWorker(acc, acc.phone || "");
    }
    // 无 rt
    if (!acquire) { await pushTestStatus(acc.id, "rt", "无rt"); return {ok: false, reason: "无rt"}; }
    await pushTestStatus(acc.id, "rt", "无rt,获取中…");
    return runRtWorker(acc, acc.phone || "");
}
app.post("/api/accounts/:id/test-at", async (req, res) => {
    const acc = await db.getAccount(Number(req.params.id));
    if (!acc) return res.status(404).json({error: "账号不存在"});
    res.json(await testOneAt(acc, {relogin: true})); // 单点测 at:失效则走浏览器登录重新获取(批量/定时不走)
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
    if (typeof req.body?.mailProxy === "string") { scheduler.mailProxy = req.body.mailProxy.trim(); setMailProxy(scheduler.mailProxy); }
    scheduler.saveSettings();
    res.json({ok: true, regProxy: scheduler.regProxy, mailProxy: scheduler.mailProxy});
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
    const vlessUrl = String(req.body?.vlessUrl || "").trim();
    if (!vlessUrl) return res.status(400).json({error: "缺少 vless 链接"});
    try {
        const r = startXray(vlessUrl, {localPort: scheduler.regProxyPort, binPath: scheduler.xrayBinPath || undefined});
        scheduler.regProxy = `socks5://127.0.0.1:${r.port}`;
        scheduler.xrayVless = vlessUrl;
        scheduler.saveSettings();
        res.json({ok: true, xray: xrayStatus(), regProxy: scheduler.regProxy});
    } catch (e: any) {
        res.status(400).json({error: String(e?.message ?? e)});
    }
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

app.get("/api/state", async (req, res) => res.json({state: {...scheduler.state(), xray: xrayStatus(), claudeXray: xrayStatus("claude"), batchPw: {...batchPwProg}}, stats: await db.stats()}));
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
    const sep = scheduler.mailSeparator || "----";
    // 支持两种输入: items=[{email,password}] 或 lines="邮箱\n邮箱----密码\n..."
    let items: {email: string; password: string}[] = [];
    if (Array.isArray(req.body?.items)) {
        items = req.body.items.map((it: any) => ({email: String(it.email || "").trim().toLowerCase(), password: String(it.password || "")})).filter((it: any) => it.email);
    } else if (typeof req.body?.lines === "string") {
        items = req.body.lines.split(/\r?\n/).map((l: string) => l.trim()).filter(Boolean).map((l: string) => {
            const parts = l.split(sep);
            return {email: parts[0].trim().toLowerCase(), password: (parts[1] || "").trim()};
        }).filter((it: any) => it.email);
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
// 独立浏览器登录拿 at(不依赖数据库账号记录)
function runReloginAtWorkerStandalone(email, password): Promise<{ok: boolean; accessToken?: string; authFile?: string; reason?: string}> {
    return new Promise(async (resolve) => {
        const tmpDir = mkdtempSync(path.join(os.tmpdir(), "codex-relogin-sa-"));
        const tmpFile = path.join(tmpDir, `mc.txt`);
        writeFileSync(tmpFile, `${email}----${password}\n`, "utf8");
        broadcast("log", {id: 0, line: `[批量AT] ${email}: 走浏览器登录获取 at…`, ts: Date.now()});
        const mb = await db.getMailboxByEmail?.(email);
        const child = spawn(CHAT_TSX_BIN, ["src/worker-register-browser.ts"], {
            shell: IS_WIN, cwd: CHAT_ROOT,
            env: {
                ...process.env,
                REG_EMAIL: email,
                MAIL_PROVIDER: (mb?.provider) || (email.endsWith("@icloud.com") ? "icloud" : "mailcom"),
                MAILCOM_TOKENS_FILE: tmpFile, ICLOUD_TOKENS_FILE: tmpFile,
                MAILCOM_HEADLESS: "1",
                PROXY_URL: scheduler.regProxy || "",
                MAILCOM_PROXY: scheduler.mailProxy || "",
                REG_SIMULATE_CHAT: "",
                REG_TRY_RT: "0",
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
app.post("/api/tools/batch-acquire-rt/stop", (req, res) => { batchRtStop = true; res.json({ok: true}); });
let batchRefreshAtStop = false;
app.post("/api/tools/batch-refresh-at/stop", (req, res) => { batchRefreshAtStop = true; res.json({ok: true}); });
app.post("/api/tools/batch-acquire-rt", (req, res) => {
    const sep = scheduler.mailSeparator || "----";
    const lines = typeof req.body?.lines === "string" ? req.body.lines.split(/\r?\n/).map((l: string) => l.trim()).filter(Boolean) : [];
    const items = lines.map((l: string) => { const parts = l.split(sep); return {email: parts[0].trim().toLowerCase(), password: (parts[1] || "").trim()}; }).filter((it: any) => it.email);
    if (!items.length) return res.status(400).json({error: "未提供邮箱列表"});
    batchRtStop = false;
    res.json({ok: true, count: items.length});
    const results: any[] = items.map((it: any) => ({email: it.email, password: it.password, ok: false, reason: "", status: "pending"}));
    (async () => {
        for (const r of results) {
            if (batchRtStop) { r.reason = "已停止"; r.status = "done"; continue; }
            const dbMb = await db.getMailboxByEmail?.(r.email);
            const mailPwd = dbMb?.password || r.password;
            if (!mailPwd) { r.ok = false; r.reason = "无密码"; r.status = "done"; broadcast("batchRtAcquire", {results, done: false}); continue; }
            try {
                broadcast("log", {id: 0, line: `[批量RT] ${r.email}: 走 OAuth 获取 rt…`, ts: Date.now()});
                const re = await runRtWorkerStandalone(r.email, mailPwd);
                if (re.ok) {
                    r.rt = re.rt; r.accessToken = re.accessToken; r.ok = true; r.reason = "获取成功";
                    // 数据库有对应 GPT 账号 → 同步更新 rt_file
                    if (re.rtFile) {
                        const allAccs = await db.listAccounts("success");
                        const gptAcc = allAccs.find((a: any) => a.email.toLowerCase() === r.email);
                        if (gptAcc) { const rtData = readJsonFileSafe(re.rtFile); await db.setAccountRtFile(gptAcc.id, re.rtFile, rtData); broadcast("log", {id: 0, line: `[批量RT] ${r.email}: rt 已同步到 GPT 账号`, ts: Date.now()}); }
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
function runRtWorkerStandalone(email, password): Promise<{ok: boolean; rt?: string; accessToken?: string; rtFile?: string; reason?: string}> {
    return new Promise(async (resolve) => {
        const tmpDir = mkdtempSync(path.join(os.tmpdir(), "codex-rt-sa-"));
        const tmpFile = path.join(tmpDir, `mc.txt`);
        writeFileSync(tmpFile, `${email}----${password}\n`, "utf8");
        const mb = await db.getMailboxByEmail?.(email);
        // 用独立脚本(不带 smsBroker),跳过 add-phone
        const child = spawn(CHAT_TSX_BIN, ["scripts/worker-rt-nosms.ts"], {
            shell: IS_WIN, cwd: CHAT_ROOT,
            env: {
                ...process.env,
                REG_EMAIL: email,
                MAIL_PROVIDER: (mb?.provider) || (email.endsWith("@icloud.com") ? "icloud" : "mailcom"),
                MAILCOM_TOKENS_FILE: tmpFile, ICLOUD_TOKENS_FILE: tmpFile,
                MAILCOM_HEADLESS: "1",
                PROXY_URL: scheduler.regProxy || "",
                MAILCOM_PROXY: scheduler.mailProxy || "",
                // PG 迁移后 worker 通过 process.env.DATABASE_URL 继承连接
                SMS_LINK_TEMPLATE: scheduler.smsLinkTemplate || "",
            },
        });
        let buf = "", result = null;
        child.on("error", (e) => resolve({ok: false, reason: String(e?.message || e)}));
        child.stdout.on("data", (d) => {
            buf += d.toString(); let idx;
            while ((idx = buf.indexOf("\n")) >= 0) {
                const line = buf.slice(0, idx); buf = buf.slice(idx + 1);
                if (line.startsWith("@@EVENT@@")) {
                    try {
                        const ev = JSON.parse(line.slice(9));
                        if (ev.type === "result") result = ev;
                        else if (ev.message) broadcast("log", {id: 0, line: `[批量RT] ${email}: ${ev.message}`, ts: Date.now()});
                    } catch {}
                } else if (line.trim()) {
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
                resolve({ok: true, rt: result.rt, accessToken: tok?.accessToken || "", rtFile: result.rtFile || ""});
            } else {
                resolve({ok: false, reason: result?.error || "OAuth 获取 rt 失败"});
            }
        });
    });
}

// ★统一导出端点(合并原下载菜单 /api/export + 批量 /api/export/selected)。POST 一站式:范围×scope×格式×标记已售出。
//   范围:body.ids(选中/当前筛选) 或 body.batch(按批次) 或都不传(全部)。任何范围都只导可用号(success 且未失效);scope=all|hasRt|atOnly 再按 rt 细分。
//   格式 format:
//     full   : 带rt→邮箱----邮箱密码----GPT密码----rt----接码卡密;只有at→邮箱----邮箱密码(价值低,只给账号)
//     at     : 邮箱----邮箱密码----accessToken(从 auth_file 解析)
//     session: 邮箱----邮箱密码----session json(可恢复登录态)
//     jsonl  : 每行 {email,password,card,phone,plan,access_token}
//     csv    : 统一列(邮箱,邮箱密码,GPT密码,rt,接码卡密),只有at行后三列留空
//   markSold:true 导出同时标记已售出。用 POST 避免选中量大时 URL 超长。
app.post("/api/export/full", async (req, res) => {
    const format = String(req.body?.format || "full");
    const scope = String(req.body?.scope || "all");
    const batch = req.body?.batch != null ? String(req.body.batch) : null;
    const idSet = Array.isArray(req.body?.ids) && req.body.ids.length ? new Set(req.body.ids.map(Number)) : null;

    // 所有范围统一只导「可用」的号:status=success 且未失效(dead_at=0)。
    // 选中/批次里混着的未注册成功/已失效号直接排除(前端弹窗会实时显示导出数与排除数,不会悄悄丢行)。
    let rows = (await db.listAccounts("success")).filter((r) => !r.dead_at);
    if (batch != null) rows = rows.filter((r) => (r.batch || "") === batch);
    if (idSet) rows = rows.filter((r) => idSet.has(r.id));
    if (scope === "hasRt") rows = rows.filter((r) => r.rt_file);
    else if (scope === "atOnly") rows = rows.filter((r) => !r.rt_file);
    if (req.body?.markSold === true && rows.length) { // 导出同时标记已售出
        try { await db.markSold(rows.map((r) => r.id)); broadcast("snapshot", await db.listAccounts()); broadcast("stats", await db.stats()); } catch (_) { /* ignore */ }
    }
    const gptPw = appConfig.defaultPassword || "";

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
        const recs = rows.map((r) => ({email: r.email, password: r.password, card: r.card || "", phone: r.phone || "", plan: r.plan, access_token: (extractTokens(getAuthData(r)) || {}).accessToken || ""}));
        res.set("Content-Type", "application/x-ndjson; charset=utf-8");
        return res.send(recs.map((r) => JSON.stringify(r)).join("\n"));
    }
    const recs = rows.map((r) => {
        const rt = (extractTokens(getRtData(r)) || {}).refreshToken || (extractTokens(getAuthData(r)) || {}).refreshToken || "";
        return {email: r.email, mailPw: r.password, gpt: r.auth_file ? gptPw : "", rt, card: r.card || "", hasRt: !!rt};
    });
    if (format === "csv") {
        const head = "邮箱,邮箱密码,GPT密码,rt,接码卡密\n";
        const body = recs.map((r) => (r.hasRt ? [r.email, r.mailPw, r.gpt, r.rt, r.card] : [r.email, r.mailPw, "", "", ""])
            .map((v) => `"${String(v ?? "").replace(/"/g, '""')}"`).join(",")).join("\n");
        res.set("Content-Type", "text/csv; charset=utf-8");
        return res.send(head + body);
    }
    // full(默认):带rt 5列 / 只有at 2列
    const lines = recs.map((r) => r.hasRt
        ? [r.email, r.mailPw, r.gpt, r.rt, r.card].join("----")
        : [r.email, r.mailPw].join("----"));
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

function rechargeLog(line: string) { broadcast("rechargeLog", {ts: Date.now(), line}); }
async function rechargeSync() { broadcast("recharge", await db.listRechargeCards()); }

// 配置
app.get("/api/recharge/config", (req, res) => {
    const key = scheduler.rechargeApiKey || "";
    res.json({baseUrl: scheduler.rechargeBaseUrl || "", appId: scheduler.rechargeAppId || "", apiKey: key ? `${key.slice(0, 6)}****${key.slice(-4)}` : "", forwardIp: scheduler.rechargeForwardIp || "", concurrency: scheduler.rechargeConcurrency || 3, interval: scheduler.rechargeInterval || 3, hasKey: !!key});
});
app.post("/api/recharge/config", (req, res) => {
    const b = req.body || {};
    if (typeof b.baseUrl === "string") scheduler.rechargeBaseUrl = b.baseUrl.trim();
    if (typeof b.appId === "string") scheduler.rechargeAppId = b.appId.trim();
    if (typeof b.apiKey === "string" && b.apiKey && !b.apiKey.includes("****")) scheduler.rechargeApiKey = b.apiKey.trim();
    if (typeof b.forwardIp === "string") scheduler.rechargeForwardIp = b.forwardIp.trim();
    if (b.concurrency !== undefined) scheduler.rechargeConcurrency = Math.max(1, Math.min(10, Number(b.concurrency) || 3));
    if (b.interval !== undefined) scheduler.rechargeInterval = Math.max(0, Math.min(60, Number(b.interval) || 3));
    scheduler.saveSettings();
    res.json({ok: true});
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
    await db.unpairRechargeCards(ids);
    await rechargeSync();
    res.json({ok: true});
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
async function queueSync() { broadcast("rechargeQueue", await db.listRechargeQueue()); }

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
    await db.resetRechargeQueue(ids);
    await queueSync(); await rechargeSync();
    res.json({ok: true});
});

// ---- 充值提交(基于队列) ----
let rechargeStop = false;
let rechargeRunning = false;

app.post("/api/recharge/submit", async (req, res) => {
    if (rechargeRunning) return res.status(400).json({error: "充值提交正在进行中"});
    const queueIds: number[] = (req.body?.queueIds || []).map(Number).filter(Number.isInteger);
    if (!queueIds.length) return res.status(400).json({error: "未选择队列项"});

    const items = (await Promise.all(queueIds.map((id: number) => db.getRechargeQueueItem(id)))).filter((q: any) => q && q.status === "pending");
    if (!items.length) return res.status(400).json({error: "无可提交的队列项(需 status=pending)"});

    const unusedCount = await db.rechargeUnusedCount();
    if (unusedCount < items.length) return res.status(400).json({error: `可用卡密不足(需要 ${items.length} 个,仅有 ${unusedCount} 个未使用)`});

    const cards = await db.pickUnusedCards(items.length);
    if (cards.length < items.length) return res.status(400).json({error: "卡密分配不足"});

    // 配对
    for (let i = 0; i < items.length; i++) {
        await db.updateQueueItem(items[i].id, {status: "paired", card_id: cards[i].id, card_code: cards[i].code});
        await db.updateRechargeCard(cards[i].id, {status: "paired", account_id: items[i].account_id, account_email: items[i].email});
    }
    await queueSync(); await rechargeSync();
    rechargeLog(`已配对 ${items.length} 组账号-卡密`);

    rechargeStop = false;
    rechargeRunning = true;
    res.json({ok: true, paired: items.length});

    // 后台逐个提交，每个之间等待间隔
    (async () => {
        const intervalMs = (scheduler.rechargeInterval || 5) * 1000;
        let submitted = 0, failed = 0;
        rechargeLog(`逐个提交 / 间隔 ${scheduler.rechargeInterval || 5}s / API: ${scheduler.rechargeBaseUrl}`);

        for (let idx = 0; idx < items.length; idx++) {
            if (rechargeStop) { rechargeLog("已停止充值提交"); break; }

            const q = await db.getRechargeQueueItem(items[idx].id);
            const card = await db.getRechargeCard(cards[idx].id);
            if (!q || !card) { failed++; continue; }

            rechargeLog(`[${idx + 1}/${items.length}] 提交 ${q.email} ← ${card.code.slice(0, 8)}...`);
            await db.updateQueueItem(q.id, {status: "submitting"});
            await db.updateRechargeCard(card.id, {status: "submitting"});

            try {
                const freshAcc = await db.getAccount(q.account_id);
                const authObj = getAuthData(freshAcc) || q.auth_data || readJsonFileSafe(q.auth_file);
                const session = extractSession(authObj);
                if (!session) throw new Error("session 数据读取失败(account_id: " + q.account_id + ")");
                const tokenInput = JSON.stringify(session);

                const valRes = await callRechargeApi("POST", "/redeem-codes/validate", {redeem_code: card.code});
                const valResult = valRes.result || {};
                await db.updateRechargeCard(card.id, {
                    plan_type: valResult.plan_type || "", plan_name: valResult.plan_name || "",
                    product: valResult.product || "", category: valResult.category || "", auth_mode: valResult.auth_mode || "",
                });
                if (valResult.status !== "unused") throw new Error(`卡密状态异常: ${valResult.status}`);

                const chRes = await callRechargeApi("POST", "/submission-challenges", {
                    redeem_code: card.code, token_input: tokenInput, plan_type: valResult.plan_type || "",
                });
                const challengeToken = chRes.challenge?.challenge_token || "";

                const taskRes = await callRechargeApi("POST", "/tasks", {
                    redeem_code: card.code, token_input: tokenInput, challenge_token: challengeToken,
                    agreement_accepted: true, email_verified: true, plan_type: valResult.plan_type || "",
                });
                const task = taskRes.task || {};
                const taskNo = task.task_no || task.receipt_no || "";

                await db.updateQueueItem(q.id, {status: "submitted", task_no: taskNo, task_status: task.status || "queued", task_message: task.message || ""});
                await db.updateRechargeCard(card.id, {status: "submitted", task_no: taskNo, task_status: task.status || "queued", task_message: task.message || ""});

                submitted++;
                rechargeLog(`✓ ${q.email} 已提交 → ${taskNo || "等待中"}`);
            } catch (e: any) {
                const msg = String(e?.message || e).slice(0, 200);
                await db.updateQueueItem(q.id, {status: "error", error: msg});
                await db.updateRechargeCard(card.id, {status: "error", error: msg});
                failed++;
                rechargeLog(`✗ ${q.email} 提交失败: ${msg}`);
            }
            await queueSync(); await rechargeSync();
            if (idx + 1 < items.length && !rechargeStop) await new Promise((r) => setTimeout(r, intervalMs));
        }
        rechargeRunning = false;
        rechargeLog(`提交完成: 成功 ${submitted} / 失败 ${failed} / 总计 ${items.length}`);

        if (submitted > 0 && !rechargeStop) {
            rechargeLog("开始轮询任务状态...");
            await pollRechargeTasksLoop();
        }
    })();
});

app.post("/api/recharge/stop", (req, res) => {
    rechargeStop = true;
    validateStop = true;
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
    if (ids.length) {
        targets = (await Promise.all(ids.map((id: number) => db.getRechargeQueueItem(id)))).filter((q: any) => q && q.card_code && q.status !== "done" && q.status !== "pending");
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

// 导出队列账号
app.post("/api/recharge/queue/export", async (req, res) => {
    const ids = (req.body?.ids || []).map(Number).filter(Number.isInteger);
    const batch = req.body?.batch || "";
    const format = req.body?.format || "account"; // account | full
    const rows = await db.listRechargeQueueFull(ids.length ? ids : undefined, batch || undefined);
    if (!rows.length) return res.status(400).json({error: "无数据可导出"});
    const sep = scheduler.mailSeparator || "----";

    if (format === "account") {
        const text = rows.map((r: any) => `${r.email}${sep}${r.password}${r.card_code ? sep + r.card_code : ""}`).join("\n");
        return res.set("Content-Type", "text/plain; charset=utf-8").send(text);
    }

    // full 格式: 先检查是否需要获取 RT，需要则异步执行后通过 SSE 推送结果
    const needRt = rows.filter((r: any) => {
        const tok = extractTokens(r.gpt_rt_data || r.gpt_auth_data || readJsonFileSafe(r.rt_file) || readJsonFileSafe(r.gpt_auth_file));
        return !tok?.refreshToken;
    });

    if (!needRt.length) {
        const text = rows.map((r: any) => {
            const tok = extractTokens(r.gpt_rt_data || r.gpt_auth_data || readJsonFileSafe(r.rt_file) || readJsonFileSafe(r.gpt_auth_file));
            return `${r.email}${sep}${r.password}${sep}${tok?.refreshToken || ""}`;
        }).join("\n");
        return res.set("Content-Type", "text/plain; charset=utf-8").send(text);
    }

    // 有账号缺少 RT → 异步获取，完成后 SSE 推送
    res.json({ok: true, async: true, total: rows.length, needRt: needRt.length});
    rechargeLog(`导出含RT: ${needRt.length}/${rows.length} 个账号缺少 RT，自动获取中...`);
    (async () => {
        let ok = 0, fail = 0;
        for (let i = 0; i < needRt.length; i++) {
            const r = needRt[i];
            const acc = await db.getAccount(r.account_id);
            if (!acc) { fail++; rechargeLog(`[${i + 1}/${needRt.length}] ✗ ${r.email} 账号不存在`); continue; }
            rechargeLog(`[${i + 1}/${needRt.length}] 获取 RT: ${r.email}...`);
            try {
                const result = await testOneRt(acc, {acquire: true});
                if (result.ok) { ok++; rechargeLog(`  ✓ ${r.email}`); }
                else { fail++; rechargeLog(`  ✗ ${r.email} ${result.reason || "失败"}`); }
            } catch (e: any) { fail++; rechargeLog(`  ✗ ${r.email} ${e?.message || e}`); }
        }
        rechargeLog(`RT 获取完成: 成功 ${ok} / 失败 ${fail}`);
        // 重新查询最新数据并通过 SSE 推送
        const freshRows = await db.listRechargeQueueFull(ids.length ? ids : undefined, batch || undefined);
        const text = freshRows.map((r: any) => {
            const tok = extractTokens(r.gpt_rt_data || r.gpt_auth_data || readJsonFileSafe(r.rt_file) || readJsonFileSafe(r.gpt_auth_file));
            return `${r.email}${sep}${r.password}${sep}${tok?.refreshToken || ""}`;
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

setMailProxy(scheduler.mailProxy); // 收件箱初始用邮箱代理(config.mailProxyUrl)
// 重启自启:若持久化了 vless，自动重新起独立 xray 并把 regProxy 指向它(失败不阻塞服务启动)
if (scheduler.xrayVless) {
    try {
        const r = startXray(scheduler.xrayVless, {localPort: scheduler.regProxyPort, binPath: scheduler.xrayBinPath || undefined});
        scheduler.regProxy = `socks5://127.0.0.1:${r.port}`;
        console.log(`[server] 独立 xray 已自启: ${r.node} @ 127.0.0.1:${r.port}`);
    } catch (e: any) {
        console.warn(`[server] 独立 xray 自启失败(不影响服务): ${e?.message ?? e}`);
    }
}
if (scheduler.claudeXrayVless) {
    try {
        const r = startXray(scheduler.claudeXrayVless, {name: "claude", localPort: scheduler.claudeProxyPort, binPath: scheduler.xrayBinPath || undefined});
        scheduler.claudeProxy = `socks5://127.0.0.1:${r.port}`;
        console.log(`[server] Claude 独立 xray 已自启: ${r.node} @ 127.0.0.1:${r.port}`);
    } catch (e: any) { console.warn(`[server] Claude xray 自启失败(不影响服务): ${e?.message ?? e}`); }
}
await ensureSchema();
await initDb();
await db.init();

app.listen(PORT, () => {
    console.log(`[server] http://localhost:${PORT}  instance=${db.instanceId}  (前端 ${existsSync(WEB_DIST) ? "已托管" : "未构建, 用 vite dev"})`);
});
