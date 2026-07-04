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
import {scheduler} from "./scheduler.js";
import {appConfig} from "../src/config.js";
// 邮箱能力统一走邮箱域服务(不再直接依赖具体 provider 文件),满足 DIP
import {fetchInboxList, fetchMailBodyFor, setMailProxy, changeMailcomPassword, verifyMailcomLogin} from "./domain/mailbox-service.js";
import {randomPassword} from "../src/utils.js";
import {openBrowserWithAuth} from "../src/simulate-chat.js";
import {bitHealth} from "../src/bitbrowser.js";
import {peekSms, buildSmsLink, classifySms} from "../src/sms-broker.js";
import {probeAt, refreshRt, buildProxyDispatcher, decodeJwt} from "../src/token-check.js";
import {startXray, stopXray, xrayStatus} from "./xray-proxy.js";
import {execSync} from "node:child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
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
scheduler.on("daily", (d) => broadcast("daily", d));

app.get("/api/stream", (req, res) => {
    res.set({
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
    });
    res.flushHeaders?.();
    sseClients.add(res);
    res.write(`event: hello\ndata: ${JSON.stringify({state: {...scheduler.state(), batchPw: {...batchPwProg}}, stats: db.stats()})}\n\n`);
    const ping = setInterval(() => { try { res.write(`event: ping\ndata: {}\n\n`); } catch { /* */ } }, 25000);
    req.on("close", () => { clearInterval(ping); sseClients.delete(res); });
});

// ---------- 解析邮箱文本: 支持 email----pwd / email:pwd / email pwd / email,pwd ----------
function parseAccounts(text, fallbackPassword) {
    const rows = [];
    for (const raw of String(text || "").split(/\r?\n/)) {
        const line = raw.trim();
        if (!line) continue;
        const parts = line.split(/----|[\s,;:|\t]+/).filter(Boolean);
        const email = (parts[0] || "").toLowerCase();
        const password = parts[1] || fallbackPassword || "";
        if (/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) && password) {
            rows.push({email, password});
        }
    }
    return rows;
}

// ---------- REST ----------
app.post("/api/accounts/import", (req, res) => {
    const rows = parseAccounts(req.body.text, req.body.defaultPassword);
    if (!rows.length) return res.status(400).json({error: "未解析到有效的 邮箱+密码 行(支持 email----pwd / email:pwd / email pwd)"});
    const result = db.importAccounts(rows, String(req.body.batch || "").trim());
    broadcast("snapshot", db.listAccounts());
    broadcast("stats", db.stats());
    scheduler.tick(); // 未暂停时自动调度新导入的任务
    res.json(result);
});

// ---- 邮箱域:资源池写操作(导入 free / 分配到业务 / 删除 / 改密) ----
// 导入 free 邮箱(纯管理,不进任何注册队列)
app.post("/api/mailboxes/import", (req, res) => {
    const rows = parseAccounts(req.body.text, req.body.defaultPassword);
    if (!rows.length) return res.status(400).json({error: "未解析到有效的 邮箱+密码 行(支持 email----pwd / email:pwd / email pwd)"});
    const result = db.importFreeMailboxes(rows, String(req.body.grp || "").trim());
    broadcast("mailboxes", {stats: db.mailboxStats()});
    // 导入后自动改密(可选):对刚导入的 free 邮箱批量改随机20位(headed 串行,后台跑)
    if (req.body.autoChangePw && !batchPwRunning) {
        const emails = new Set(rows.map((r) => r.email.toLowerCase()));
        const items = db.listMailboxes("free").filter((m) => emails.has(m.email)).map((m) => ({id: m.id, email: m.email, oldPw: m.password}));
        if (items.length) { startBatchPasswd(items, mailboxPwApply, "导入后改密"); return res.json({...result, autoChangePw: items.length}); }
    }
    res.json(result);
});
// 从 free 池分配 N 个邮箱给业务域(gpt/claude):CAS 锁定 + 建 pending 业务号。gpt 立即进注册队列。★隔离
app.post("/api/mailboxes/allocate", (req, res) => {
    const usage = String(req.body.usage || "");
    const count = Number(req.body.count || 0);
    if (usage !== "gpt" && usage !== "claude") return res.status(400).json({error: "usage 必须是 gpt 或 claude"});
    if (!(count > 0)) return res.status(400).json({error: "count 必须 > 0"});
    // 来源分组:只从该分组的独立(free)邮箱里取(避免误分想保留的);不传=全池,""=无分组桶。与 batch(业务号标签)解耦。
    const fromGrp = typeof req.body.fromGrp === "string" ? req.body.fromGrp : undefined;
    const r = db.allocateMailboxesTo(usage, count, String(req.body.batch || "").trim(), fromGrp);
    if (usage === "gpt") { broadcast("snapshot", db.listAccounts()); broadcast("stats", db.stats()); scheduler.tick(); }
    broadcast("mailboxes", {stats: db.mailboxStats()});
    res.json(r);
});
// 删除邮箱(仅未被业务占用的 free 邮箱;被占用则 409,应从对应业务域删)
app.delete("/api/mailboxes/:id", (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({error: "bad id"});
    const r = db.deleteMailbox(id);
    if (!r.ok) return res.status(409).json(r);
    broadcast("mailboxes", {stats: db.mailboxStats()});
    res.json(r);
});
// 真·改邮箱密码(操作 mail.com 改密页,free 邮箱也适用),改后同步库
app.post("/api/mailboxes/:id/change-passwd", async (req, res) => {
    const id = Number(req.params.id);
    const mb = db.getMailbox(id);
    if (!mb) return res.status(404).json({error: "邮箱不存在"});
    const np = String(req.body.newPassword || "").trim() || randomPassword(20);
    try {
        const r = await changeMailcomPassword(mb.email, mb.password, np);
        if (r?.ok) { db.setMailboxPassword(id, np, `✅已改${r.verified ? "(验证)" : "?未验证"}`); res.json({ok: true, newPassword: np}); }
        else { db.setMailboxPassword(id, mb.password, `❌试过 ${np}·${String(r?.detail || "失败").slice(0, 30)}`); res.json({ok: false, newPassword: np, detail: r?.detail}); }
    } catch (e: any) { res.status(500).json({error: String(e?.message ?? e)}); }
});

// ---- 邮箱域:资源池只读(P5 邮箱管理 tab 用)。usage 过滤:free 待分配 / gpt / claude ----
app.get("/api/mailboxes", (req, res) => {
    const usage = req.query.usage ? String(req.query.usage) : undefined;
    // groups=独立(free)邮箱的分组分布(恒返回,不受 usage 过滤影响),供前端"按分组分配"下拉
    res.json({list: db.listMailboxes(usage), stats: db.mailboxStats(), groups: db.freeMailboxGroups()});
});

// ---- Claude 域(架构 v2:与 GPT 对称命名空间 /api/claude/*)。----
// 邮箱经 POST /api/mailboxes/allocate {usage:'claude'} 从池分配 → 建 pending claude_accounts(占位)。
// 注册类接口待 Claude 机制逆向(见 docs/ARCHITECTURE-v2.md §8 D1),暂返回 501,但列表/分配已可用。
app.get("/api/claude/accounts", (req, res) => res.json({list: db.listClaudeAccounts(), stats: db.claudeStats()}));
app.post("/api/claude/register", (req, res) => res.status(501).json({error: "Claude 注册机制待逆向(见 docs/ARCHITECTURE-v2.md §8 D1);当前可经 /api/mailboxes/allocate {usage:'claude'} 从池分配占位账号"}));

app.get("/api/accounts", (req, res) => res.json(db.listAccounts(req.query.status)));
app.get("/api/accounts/:id", (req, res) => { const id = Number(req.params.id); const a = Number.isInteger(id) ? db.getAccount(id) : null; return a ? res.json(a) : res.status(404).json({error: "账号不存在"}); });
app.get("/api/accounts/:id/logs", (req, res) => res.json(db.listLogs(Number(req.params.id))));
// 收件箱：用该号账密登录 mail.com 拉收件箱(验证登录是否有效)。会起浏览器、约 20~30s。
app.get("/api/accounts/:id/inbox", async (req, res) => {
    const acc = db.getAccount(Number(req.params.id));
    if (!acc) return res.status(404).json({error: "账号不存在"});
    try {
        const mails = await fetchInboxList(acc.email, acc.password);
        res.json({email: acc.email, mails});
    } catch (e: any) {
        res.status(500).json({error: String(e?.message ?? e)});
    }
});
// 按需拉单封正文(复用收件箱缓存会话，秒级)
app.get("/api/accounts/:id/mail/:mailId/body", async (req, res) => {
    const acc = db.getAccount(Number(req.params.id));
    if (!acc) return res.status(404).json({error: "账号不存在"});
    try {
        const body = await fetchMailBodyFor(acc.email, req.params.mailId);
        res.json({body});
    } catch (e: any) {
        res.status(500).json({error: String(e?.message ?? e)});
    }
});
app.post("/api/accounts/:id/retry", (req, res) => res.json({ok: scheduler.retry(Number(req.params.id))}));
// 编辑账号记录(修正/整理本地库字段,不触发真邮箱改密)。支持编辑全部可改字段 + 失效/已售开关。
app.patch("/api/accounts/:id", (req, res) => {
    const id = Number(req.params.id);
    const acc = db.getAccount(id);
    if (!acc) return res.status(404).json({error: "账号不存在"});
    if (scheduler.running.has(id)) return res.status(409).json({error: "运行中，无法编辑"});
    const b = req.body || {};
    const fields = {};
    for (const k of ["email", "password", "status", "plan", "phone", "card", "at_status", "rt_status", "chat_status", "error"]) {
        if (typeof b[k] === "string") fields[k] = b[k].trim();
    }
    if (typeof b.dead === "boolean") fields.dead_at = b.dead ? (acc.dead_at || Date.now()) : 0; // 失效开关
    if (typeof b.sold === "boolean") fields.sold_at = b.sold ? (acc.sold_at || Date.now()) : 0; // 已售开关
    try {
        if (Object.keys(fields).length) db.updateAccount(id, fields);
    } catch (e) {
        return res.status(400).json({error: `更新失败(邮箱可能重复): ${e?.message || e}`});
    }
    broadcast("snapshot", db.listAccounts());
    res.json({ok: true, account: db.getAccount(id)});
});
const pwStamp = () => { const d = new Date(); const p = (n) => String(n).padStart(2, "0"); return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`; };
// 真·改 mail.com 邮箱密码(Playwright 操作 Wicket 改密表单),成功后同步 DB。
// body.newPassword 留空则随机生成 20 位(大小写+数字)。
app.post("/api/accounts/:id/change-passwd", async (req, res) => {
    const id = Number(req.params.id);
    const acc = db.getAccount(id);
    if (!acc) return res.status(404).json({error: "账号不存在"});
    if (scheduler.running.has(id)) return res.status(409).json({error: "运行中，无法改密"});
    const newPassword = String(req.body?.newPassword || "").trim() || randomPassword(20);
    logAcct(id, `[改密] 开始改密,新密码=${newPassword}`); // 记明文:即使判失败也能用它登录挽救
    const triedPw = (String(acc.pw_status || "").match(/试过 ([^\s·]+)/) || [])[1];
    const curPw = triedPw && triedPw !== acc.password ? [acc.password, triedPw] : acc.password; // 候选:库密码+曾试过的(自愈)
    try {
        const r = await changeMailcomPassword(acc.email, curPw, newPassword, (m) => logAcct(id, `[改密] ${m}`));
        if (r?.ok) {
            db.updatePassword(id, newPassword);
            db.setPwStatus(id, `✅已改 ${pwStamp()}${r.verified ? "(验证)" : "?未验证"}`);
            logAcct(id, `[改密] 成功,已同步库内密码`);
            broadcast("snapshot", db.listAccounts());
            return res.json({ok: true, newPassword});
        }
        db.setPwStatus(id, `❌试过 ${newPassword}·${String(r?.detail || "失败").slice(0, 30)}`); // 存明文:失败可能实为成功→可用它登录挽救
        broadcast("snapshot", db.listAccounts());
        logAcct(id, `[改密] 失败(新密码 ${newPassword} 已记录,可手动验证): ${r?.detail || "未见成功确认"}`);
        return res.status(502).json({error: "改密未成功", detail: r?.detail || "", triedPassword: newPassword});
    } catch (e) {
        db.setPwStatus(id, `❌试过 ${newPassword}·${String(e?.message || e).slice(0, 30)}`);
        broadcast("snapshot", db.listAccounts());
        logAcct(id, `[改密] 异常(新密码 ${newPassword} 已记录): ${e?.message || e}`);
        return res.status(500).json({error: String(e?.message || e), triedPassword: newPassword});
    }
});
// 人工确认改密成功:改密判失败但已手动验证新密码有效时,采用"试过的新密码"(或指定 password)、状态转已改,不再真改。
app.post("/api/accounts/:id/confirm-changed", (req, res) => {
    const id = Number(req.params.id);
    const acc = db.getAccount(id);
    if (!acc) return res.status(404).json({error: "账号不存在"});
    const tried = (String(acc.pw_status || "").match(/试过 ([^\s·]+)/) || [])[1]; // 从 pw_status 提取记录过的新密码
    const np = String(req.body?.password || tried || "").trim();
    if (!np) return res.status(400).json({error: "无可采用的新密码(该号 pw_status 无'试过 X'记录，请用编辑手动填密码)"});
    db.updatePassword(id, np);
    db.setPwStatus(id, "✅已改(手动确认)");
    broadcast("snapshot", db.listAccounts());
    logAcct(id, `[改密] 人工确认新密码有效，已采用并转为已改`);
    res.json({ok: true, password: np});
});
// 批量删除:删除选中的号(运行中的跳过,连日志一起删)。
app.post("/api/accounts/batch-delete", (req, res) => {
    const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(Number) : [];
    if (!ids.length) return res.status(400).json({error: "未选择账号"});
    let n = 0, skipped = 0;
    for (const id of ids) {
        if (scheduler.running.has(id)) { skipped += 1; continue; } // 运行中不删
        try { db.deleteAccount(id); n += 1; } catch (_) { /* ignore */ }
    }
    broadcast("snapshot", db.listAccounts());
    broadcast("stats", db.stats());
    res.json({ok: true, count: n, skipped});
});
// 批量设置批次:给选中号打/改/清批次名(便于分组筛选、导出)。
app.post("/api/accounts/set-batch", (req, res) => {
    const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(Number) : [];
    const batch = String(req.body?.batch || "").trim();
    if (!ids.length) return res.status(400).json({error: "未选择账号"});
    let n = 0;
    for (const id of ids) { try { db.updateAccount(id, {batch}); n += 1; } catch (_) { /* ignore */ } }
    broadcast("snapshot", db.listAccounts());
    res.json({ok: true, count: n});
});
// 批量串行改密(通用引擎):headed 一次一个,后台跑、SSE 进度推送。改密是邮箱能力,GPT/邮箱域共用此引擎。
let batchPwRunning = false, batchPwStop = false;
const batchPwProg = {running: false, done: 0, total: 0, ok: 0, stopped: false}; // 进度快照(供 /api/state 刷新后恢复)
// items=[{id,email,oldPw}](oldPw 可为 string|string[] 做自愈候选);apply(item,{ok,np,verified,detail})=写库+广播。
function startBatchPasswd(items, apply, tag = "批量改密") {
    batchPwRunning = true; batchPwStop = false;
    Object.assign(batchPwProg, {running: true, done: 0, total: items.length, ok: 0, stopped: false});
    broadcast("batchPw", {...batchPwProg});
    (async () => {
        let done = 0, okc = 0;
        for (const it of items) {
            if (batchPwStop) { console.log(`[${tag}] 已停止(完成 ${done}/${items.length})`); break; }
            const np = randomPassword(20);
            logAcct(it.id, `[改密] ${tag}(${done + 1}/${items.length}),新密码=${np}`); // 记明文:失败也能挽救
            try {
                const r = await changeMailcomPassword(it.email, it.oldPw, np, (m) => logAcct(it.id, `[改密] ${m}`));
                if (r?.ok) { apply(it, {ok: true, np, verified: r.verified}); okc += 1; logAcct(it.id, `[改密] 成功`); }
                else { apply(it, {ok: false, np, detail: r?.detail || "失败"}); logAcct(it.id, `[改密] 失败(新密码 ${np} 已记录)`); }
            } catch (e) {
                apply(it, {ok: false, np, detail: String(e?.message || e)}); logAcct(it.id, `[改密] 异常(新密码 ${np} 已记录): ${e?.message || e}`);
            }
            done += 1;
            Object.assign(batchPwProg, {done, ok: okc});
            broadcast("batchPw", {...batchPwProg});
        }
        const stopped = batchPwStop;
        batchPwRunning = false; batchPwStop = false;
        Object.assign(batchPwProg, {running: false, done, ok: okc, stopped});
        broadcast("batchPw", {...batchPwProg});
        console.log(`[${tag}] ${stopped ? "已停止" : "完成"} ${okc}/${items.length} 成功`);
    })();
}

// GPT 域批量改密(遗留,前端入口已迁至邮箱管理;保留兼容,操作 gpt_accounts)。
app.post("/api/accounts/batch-change-passwd", (req, res) => {
    if (batchPwRunning) return res.status(409).json({error: "已有批量改密在跑,请等待完成或先停止"});
    const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(Number) : null;
    let accs = ids
        ? ids.map((id) => db.getAccount(id)).filter(Boolean)
        : db.listAccounts("success").filter((a) => !String(a.pw_status || "").includes("✅"));
    accs = accs.filter((a) => !scheduler.running.has(a.id));
    if (!accs.length) return res.json({ok: true, count: 0, msg: "无待改密账号(可能都已改过或在运行中)"});
    res.json({ok: true, count: accs.length});
    const items = accs.map((a) => {
        const triedPw = (String(a.pw_status || "").match(/试过 ([^\s·]+)/) || [])[1]; // 曾疑似失败记录过的新密码
        return {id: a.id, email: a.email, oldPw: triedPw && triedPw !== a.password ? [a.password, triedPw] : a.password};
    });
    startBatchPasswd(items, (it, {ok, np, verified, detail}) => {
        if (ok) { db.updatePassword(it.id, np); db.setPwStatus(it.id, `✅已改 ${pwStamp()}${verified ? "(验证)" : "?未验证"}`); }
        else db.setPwStatus(it.id, `❌试过 ${np}·${String(detail).slice(0, 30)}`);
        broadcast("snapshot", db.listAccounts());
    });
});

// 邮箱域批量改密(★职责集中:所有邮箱改密统一入口,操作 mailboxes 表,覆盖 free/gpt/claude)。
// ids=选中的 mailbox id(必填);跳过库里没有的。改后广播 mailboxes 刷新。
app.post("/api/mailboxes/batch-change-passwd", (req, res) => {
    if (batchPwRunning) return res.status(409).json({error: "已有批量改密在跑,请等待完成或先停止"});
    const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(Number) : [];
    const mbs = ids.map((id) => db.getMailbox(id)).filter(Boolean);
    if (!mbs.length) return res.json({ok: true, count: 0, msg: "未选择有效邮箱"});
    res.json({ok: true, count: mbs.length});
    const items = mbs.map((m) => ({id: m.id, email: m.email, oldPw: m.password}));
    startBatchPasswd(items, mailboxPwApply, "邮箱批量改密");
});

// 邮箱改密结果写库(mailboxes 表)+ 广播。批量改密/导入后改密共用(DRY)。失败保留原密码,只记状态。
const mailboxPwApply = (it, {ok, np, verified, detail}) => {
    const mb = db.getMailbox(it.id);
    if (ok) db.setMailboxPassword(it.id, np, `✅已改 ${pwStamp()}${verified ? "(验证)" : "?未验证"}`);
    else db.setMailboxPassword(it.id, mb?.password ?? "", `❌试过 ${np}·${String(detail).slice(0, 30)}`);
    broadcast("mailboxes", {stats: db.mailboxStats()});
};
// 停止批量改密(当前正在改的那个号会跑完,之后不再开始;正在跑的浏览器不强杀)
app.post("/api/control/batch-passwd/stop", (req, res) => {
    if (!batchPwRunning) return res.json({ok: true, msg: "当前无批量改密任务"});
    batchPwStop = true;
    res.json({ok: true});
});
// 打开一个已登录 chatgpt 的真浏览器(注入该号 at 会话 sessionToken + CF cookie),供人工操作;不关闭,用户关窗口即断开。
const openedBrowsers = new Map(); // id -> browser(防 GC + 支持重开时关旧的)
app.post("/api/accounts/:id/open-browser", async (req, res) => {
    const id = Number(req.params.id);
    const acc = db.getAccount(id);
    if (!acc) return res.status(404).json({error: "账号不存在"});
    if (!acc.auth_file || !existsSync(acc.auth_file)) return res.status(400).json({error: "无 at 授权文件(该号可能未注册成功/未拿到 at)"});
    let rec;
    try { rec = JSON.parse(readFileSync(acc.auth_file, "utf8")); }
    catch (e) { return res.status(500).json({error: `读取授权文件失败: ${e?.message || e}`}); }
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
app.delete("/api/accounts/:id", (req, res) => {
    const id = Number(req.params.id);
    if (scheduler.running.has(id)) return res.status(409).json({error: "运行中，无法删除"});
    db.deleteAccount(id);
    broadcast("snapshot", db.listAccounts());
    broadcast("stats", db.stats());
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
// 注册成功后是否额外走 codex OAuth 拿可续期 rt(强制 add-phone 接码，有成本)
app.post("/api/control/rt", (req, res) => {
    if (typeof req.body?.enabled === "boolean") scheduler.rtEnabled = req.body.enabled;
    scheduler.saveSettings();
    res.json({ok: true, rtEnabled: scheduler.rtEnabled});
});

// 注册成功后是否自动改 mail.com 密码为随机20位并同步库
app.post("/api/control/auto-passwd", (req, res) => {
    if (typeof req.body?.enabled === "boolean") scheduler.autoChangePasswd = req.body.enabled;
    scheduler.saveSettings();
    res.json({ok: true, autoChangePasswd: scheduler.autoChangePasswd});
});
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
// 从账号 auth 文件解析各类 token
function readAuthTokens(authFile) {
    try {
        const d = JSON.parse(readFileSync(authFile, "utf8"));
        const s = (d && d.session) || {};
        const accessToken = s.accessToken || d.access_token || "";
        const refreshToken = d.refresh_token || "";
        let accountId = d.account_id || "";
        if (!accountId && accessToken) {
            const c = decodeJwt(accessToken) || {};
            accountId = (c["https://api.openai.com/auth"] || {}).chatgpt_account_id || "";
        }
        if (!accountId && s.account) accountId = s.account.account_id || s.account.id || "";
        return {accessToken, refreshToken, accountId, raw: d, path: authFile};
    } catch { return null; }
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
function pickAccounts(ids) {
    if (Array.isArray(ids) && ids.length) return ids.map((id) => db.getAccount(Number(id))).filter(Boolean);
    return db.listAccounts("success");
}
// 写状态 + SSE 推整行(前端 status 事件已合并进表格)
function pushTestStatus(id, kind, status) {
    db.setTestStatus(id, kind, status);
    broadcast("status", {id, ...db.getAccount(id)});
}
// relogin=true:at 失效且 rt 也换不出时,走【完整浏览器登录流程】重新拿 at(headed,慢)。单点测 at 用;批量/定时默认 false(避免开一堆浏览器)。
async function testOneAt(acc, {relogin = false} = {}) {
    pushTestStatus(acc.id, "at", "测试中…");
    const tok = readAuthTokens(acc.auth_file);
    if (!tok || !tok.accessToken) {
        if (!relogin) { pushTestStatus(acc.id, "at", "无at"); return {ok: false, reason: "无at"}; }
    } else {
        let r = await probeAt(tok.accessToken, tok.accountId, buildProxyDispatcher(scheduler.regProxy));
        if (r.ok) { pushTestStatus(acc.id, "at", "✅有效"); return r; }
        // ① at 失效 → 先用 rt 换新 at(快,有 rt 才行),写回
        const rtTok = readAuthTokens(acc.rt_file || acc.auth_file);
        if (rtTok && rtTok.refreshToken) {
            pushTestStatus(acc.id, "at", "at失效,用rt换新at…");
            const rr = await refreshRt(rtTok.refreshToken, buildProxyDispatcher(scheduler.regProxy));
            if (rr.ok && rr.tokens && rr.tokens.access_token) {
                try { const rec = tok.raw || {}; if (rec.session) rec.session.accessToken = rr.tokens.access_token; else rec.access_token = rr.tokens.access_token; writeFileSync(tok.path, JSON.stringify(rec) + "\n"); } catch { /* */ }
                r = await probeAt(rr.tokens.access_token, tok.accountId, buildProxyDispatcher(scheduler.regProxy));
            }
        }
        if (r.ok) { pushTestStatus(acc.id, "at", "✅有效"); return r; }
        if (!relogin) { pushTestStatus(acc.id, "at", "❌" + r.reason); return r; }
    }
    // ② 仍失效(无 rt/rt 换不出/无 at) 且 relogin → 走完整浏览器登录流程重新拿 at
    pushTestStatus(acc.id, "at", "at失效,走浏览器登录重新获取…");
    const re = await runReloginAtWorker(acc);
    if (!re.ok) { pushTestStatus(acc.id, "at", "❌登录获取失败:" + String(re.reason || "").slice(0, 40)); return {ok: false, reason: re.reason}; }
    const fresh = readAuthTokens(re.authFile);
    const r2 = fresh && fresh.accessToken ? await probeAt(fresh.accessToken, fresh.accountId, buildProxyDispatcher(scheduler.regProxy)) : {ok: false, reason: "新 auth 无 at"};
    pushTestStatus(acc.id, "at", r2.ok ? "✅有效(已重登)" : ("❌" + r2.reason));
    return r2;
}
// 按需获取 rt：spawn worker-rt 走 codex OAuth(邮箱OTP + add-phone 接码)。preferPhone=复用已绑定号(过期重取)。
// mailcom provider 收邮箱 OTP 需临时单行池文件(email----邮箱密码)，与注册 worker 同套。
// test worker(rt/chat)日志:同时落库(db.appendLog)+SSE,以便事后在库里查失败过程(如 rt 的 add-phone/接码/400)
function logAcct(id, line) { try { db.appendLog(id, line); } catch { /* ignore */ } broadcast("log", {id, line, ts: Date.now()}); }
function runRtWorker(acc, preferPhone) {
    return new Promise((resolve) => {
        const tmpDir = mkdtempSync(path.join(os.tmpdir(), "codex-rt-"));
        const tmpFile = path.join(tmpDir, `mc-${acc.id}.txt`);
        writeFileSync(tmpFile, `${acc.email}----${acc.password}\n`, "utf8");
        logAcct(acc.id, `[rt] 启动 worker 获取 refresh_token${preferPhone ? `(复用绑定号 +${preferPhone})` : ""}…`);
        const child = spawn(CHAT_TSX_BIN, ["src/worker-rt.ts"], {
            cwd: CHAT_ROOT,
            env: {
                ...process.env,
                REG_EMAIL: acc.email,
                MAILCOM_TOKENS_FILE: tmpFile,
                MAILCOM_HEADLESS: "1",
                SMS_LINK_TEMPLATE: scheduler.smsLinkTemplate || "",
                SMS_MAX_BIND: String(scheduler.smsMaxBind ?? 0),
                RT_PREFER_PHONE: preferPhone || "",
                PROXY_URL: scheduler.regProxy || "",
                MAILCOM_PROXY: scheduler.mailProxy || "",
                REG_DB_PATH: db.dbPath,
            },
        });
        let buf = "";
        let result = null;
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
        child.on("close", () => {
            try { rmSync(tmpDir, {recursive: true, force: true}); } catch { /* ignore */ }
            if (result && result.status === "success") {
                db.setAccountRtFile(acc.id, result.rtFile || "");
                if (result.phone) db.setAccountPhone(acc.id, result.phone);
                if (result.card) db.setAccountCard(acc.id, result.card);
                pushTestStatus(acc.id, "rt", "✅已获取rt");
                scheduler.emit("sms", {stats: db.smsStats()}); // 接码池状态变化 → 前端刷新
                resolve({ok: true, refresh_token: result.rt});
            } else {
                pushTestStatus(acc.id, "rt", "❌获取失败:" + String(result?.error || "进程异常").slice(0, 60));
                resolve({ok: false, reason: result?.error || "获取失败"});
            }
        });
        child.on("error", (e) => {
            try { rmSync(tmpDir, {recursive: true, force: true}); } catch { /* ignore */ }
            pushTestStatus(acc.id, "rt", "❌启动失败:" + (e?.message ?? e));
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
            cwd: CHAT_ROOT,
            env: {
                ...process.env,
                REG_EMAIL: acc.email,
                MAILCOM_TOKENS_FILE: tmpFile,
                MAILCOM_HEADLESS: "1",
                PROXY_URL: scheduler.regProxy || "",
                MAILCOM_PROXY: scheduler.mailProxy || "",
                REG_SIMULATE_CHAT: "", // 不养号
                REG_TRY_RT: "0",       // 不取 rt,只拿 at
                REG_DB_PATH: db.dbPath,
            },
        });
        let buf = "", result = null;
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
        child.on("close", () => {
            try { rmSync(tmpDir, {recursive: true, force: true}); } catch { /* ignore */ }
            if (result && result.status === "success" && result.authFile) {
                db.updateAccount(acc.id, {auth_file: result.authFile}); // 更新为新 auth 文件(含新 at)
                broadcast("snapshot", db.listAccounts());
                resolve({ok: true, authFile: result.authFile});
            } else {
                const err = result?.error || "登录获取 at 失败";
                // 登录时若发现账号被停用 → 写入 error(进"已停用"筛选,一键筛出批量删)
                if (/account_deactivated/i.test(err)) { db.updateAccount(acc.id, {error: err}); broadcast("snapshot", db.listAccounts()); }
                resolve({ok: false, reason: err});
            }
        });
        child.on("error", (e) => { try { rmSync(tmpDir, {recursive: true, force: true}); } catch { /* */ } resolve({ok: false, reason: String(e?.message ?? e)}); });
    });
}

// rt 三态：有效→刷新写回；已过期→复用绑定号重新获取；无rt→获取。acquire=false 时不自动获取(批量用，避免误耗接码)。
async function testOneRt(acc, {updateRt = true, acquire = false} = {}) {
    pushTestStatus(acc.id, "rt", "测试中…");
    const tok = readAuthTokens(acc.rt_file || acc.auth_file); // rt 优先在 codex 文件里
    if (tok && tok.refreshToken) {
        let r = await refreshRt(tok.refreshToken, buildProxyDispatcher(scheduler.regProxy));
        if (!r.ok) { // 失败重试一次:过滤网络/代理抖动,两次都失败才算过期(避免抖动误判 dead)
            pushTestStatus(acc.id, "rt", "失败,重试中…");
            await new Promise((s) => setTimeout(s, 2500));
            r = await refreshRt(tok.refreshToken, buildProxyDispatcher(scheduler.regProxy));
        }
        if (r.ok) {
            if (updateRt && r.tokens && tok.raw) {
                try { // 续期写回 rt 文件(更新 access_token/refresh_token)
                    const rec = tok.raw;
                    rec.access_token = r.tokens.access_token;
                    if (r.tokens.refresh_token) rec.refresh_token = r.tokens.refresh_token;
                    if (r.tokens.id_token) rec.id_token = r.tokens.id_token;
                    rec.last_refresh = new Date().toISOString();
                    writeFileSync(tok.path, JSON.stringify(rec) + "\n");
                } catch { /* 写回失败不影响测试结论 */ }
            }
            pushTestStatus(acc.id, "rt", updateRt ? "✅有效(已续期)" : "✅有效");
            return r;
        }
        // rt 存在但刷新失败 = 过期/失效 → 复用绑定号重新获取
        if (!acquire) { pushTestStatus(acc.id, "rt", "❌" + r.reason); return r; }
        pushTestStatus(acc.id, "rt", "过期,重新获取中…");
        return runRtWorker(acc, acc.phone || "");
    }
    // 无 rt
    if (!acquire) { pushTestStatus(acc.id, "rt", "无rt"); return {ok: false, reason: "无rt"}; }
    pushTestStatus(acc.id, "rt", "无rt,获取中…");
    return runRtWorker(acc, acc.phone || "");
}
app.post("/api/accounts/:id/test-at", async (req, res) => {
    const acc = db.getAccount(Number(req.params.id));
    if (!acc) return res.status(404).json({error: "账号不存在"});
    res.json(await testOneAt(acc, {relogin: true})); // 单点测 at:失效则走浏览器登录重新获取(批量/定时不走)
});
app.post("/api/accounts/:id/test-rt", async (req, res) => {
    const acc = db.getAccount(Number(req.params.id));
    if (!acc) return res.status(404).json({error: "账号不存在"});
    // 单号:默认 acquire=true(无rt/过期时自动获取，会耗接码);可传 acquire:false 只测不获取
    res.json(await testOneRt(acc, {updateRt: req.body?.updateRt !== false, acquire: req.body?.acquire !== false}));
});
let batchAtRunning = false, batchAtStop = false;
app.post("/api/control/test-at", (req, res) => {
    const accs = pickAccounts(req.body?.ids);
    const relogin = !!req.body?.relogin;
    if (!relogin) { res.json({ok: true, count: accs.length}); runPool(accs, (a) => testOneAt(a), 6); return; } // 并发快速探测(不登录)
    // 串行重登:at 失效走浏览器登录重新拿 at(一次一个,避免开一堆 headed 浏览器),后台跑、可停止
    if (batchAtRunning) return res.status(409).json({error: "已有批量重登在跑,请等待或先停止"});
    res.json({ok: true, count: accs.length});
    batchAtRunning = true; batchAtStop = false;
    broadcast("batchAt", {running: true, done: 0, total: accs.length});
    (async () => {
        let done = 0;
        for (const a of accs) {
            if (batchAtStop) { console.log(`[批量重登at] 已停止(${done}/${accs.length})`); break; }
            try { await testOneAt(db.getAccount(a.id) || a, {relogin: true}); } catch (e) { logAcct(a.id, `[at] 异常: ${e?.message || e}`); }
            done += 1; broadcast("batchAt", {running: true, done, total: accs.length});
        }
        batchAtRunning = false; batchAtStop = false;
        broadcast("batchAt", {running: false, done, total: accs.length});
        console.log(`[批量重登at] 结束 ${done}/${accs.length}`);
    })();
});
app.post("/api/control/test-at/stop", (req, res) => { if (batchAtRunning) batchAtStop = true; res.json({ok: true, msg: batchAtRunning ? "已请求停止" : "当前无批量重登"}); });
app.post("/api/control/test-rt", (req, res) => {
    const accs = pickAccounts(req.body?.ids);
    const updateRt = req.body?.updateRt !== false;
    // 批量:默认 acquire=false，只刷新有效 rt、标记无rt/过期，避免一键误耗大量接码;显式传 acquire:true 才批量获取
    const acquire = req.body?.acquire === true;
    res.json({ok: true, count: accs.length});
    // acquire 会起 headless 浏览器(收码)+接码，低并发；纯刷新则 6 并发
    runPool(accs, (a) => testOneRt(a, {updateRt, acquire}), acquire ? 2 : 6);
});

// ---------- 测聊天(session 注入 + 真浏览器发一条消息，子进程) ----------
const CHAT_TSX_BIN = path.resolve(__dirname, "..", "node_modules", ".bin", "tsx");
const CHAT_ROOT = path.resolve(__dirname, "..");
function runChatWorker(acc, message) {
    return new Promise((resolve) => {
        pushTestStatus(acc.id, "chat", "聊天中…");
        broadcast("log", {id: acc.id, line: `[chat] 启动浏览器发消息…`, ts: Date.now()});
        const child = spawn(CHAT_TSX_BIN, ["src/worker-chat.ts"], {
            cwd: CHAT_ROOT,
            env: {...process.env, CHAT_AUTH_FILE: acc.auth_file || "", CHAT_MESSAGE: message || "", PROXY_URL: scheduler.regProxy || ""},
        });
        let buf = "";
        let result = null;
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
        child.on("close", () => {
            const status = result ? (result.ok ? "✅回复成功" : ("❌" + (result.error || "无回复"))) : "❌进程异常退出";
            pushTestStatus(acc.id, "chat", status);
            resolve(result || {ok: false});
        });
        child.on("error", (e) => { pushTestStatus(acc.id, "chat", "❌启动失败:" + (e?.message ?? e)); resolve({ok: false}); });
    });
}
app.post("/api/accounts/:id/test-chat", (req, res) => {
    const acc = db.getAccount(Number(req.params.id));
    if (!acc) return res.status(404).json({error: "账号不存在"});
    res.json({ok: true, started: true});
    runChatWorker(acc, req.body?.message);
});
app.post("/api/control/test-chat", (req, res) => {
    const accs = pickAccounts(req.body?.ids);
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
app.post("/api/control/xray", (req, res) => {
    const vlessUrl = String(req.body?.vlessUrl || "").trim();
    if (!vlessUrl) return res.status(400).json({error: "缺少 vless 链接"});
    try {
        const r = startXray(vlessUrl);
        scheduler.regProxy = `socks5://127.0.0.1:${r.port}`; // 注册代理自动指向独立 xray
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

app.get("/api/state", (req, res) => res.json({state: {...scheduler.state(), xray: xrayStatus(), batchPw: {...batchPwProg}}, stats: db.stats()}));
app.get("/api/stats", (req, res) => res.json(db.stats()));

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
    const r = toImport.length ? db.importSms(toImport) : {inserted: 0, skipped: 0, total: rows.length};
    broadcast("sms", {stats: db.smsStats()});
    res.json({...r, invalid, verified: verify});
});
app.get("/api/sms", (req, res) => res.json({
    list: db.listSms().map((s: any) => ({id: s.id, card: s.card || "", phone: s.phone, status: s.status, bound_email: s.bound_email, bind_count: s.bind_count || 0, bind_emails: s.bind_emails || "", link_preview: s.link.slice(0, 34) + (s.link.length > 34 ? "…" : "")})),
    stats: db.smsStats(),
}));
app.delete("/api/sms/:id", (req, res) => { db.deleteSms(Number(req.params.id)); broadcast("sms", {stats: db.smsStats()}); res.json({ok: true}); });
app.get("/api/sms/:id/peek", async (req, res) => {
    const s: any = db.listSms().find((x: any) => x.id === Number(req.params.id));
    if (!s) return res.status(404).json({error: "接码号不存在"});
    const link = s.link || buildSmsLink(scheduler.smsLinkTemplate, s.phone);
    if (!link) return res.status(400).json({error: "该号无收码链接：请先配置接码链接模板"});
    try { res.json({text: await peekSms(link)}); } catch (e: any) { res.status(500).json({error: String(e?.message ?? e)}); }
});

// ---------- 定时任务：每天对已成功账号 养号 + rt续期 + at续期 ----------
// rt 用 acquire=false(只续已有的有效 rt，不自动对过期/无rt号重取，避免定时批量烧接码)。
// 综合判死活:测 at + 续 rt，rt 能续或 at 有效=活(清 dead_at);【at 和 rt 都失效】才算死→setDeadAt 定格存活天数。
async function maintainOne(acc, items) {
    let atOk = null, rtOk = null;
    if (items.at) { try { atOk = (await testOneAt(acc)).ok; } catch { atOk = false; } }
    if (items.rt) { try { rtOk = (await testOneRt(acc, {updateRt: true, acquire: false})).ok; } catch { rtOk = false; } }
    // 只有同时测了 at 和 rt 才综合判死活(只测一项无法判定"两者都失效")
    if (items.at && items.rt) {
        if (atOk || rtOk) db.setDeadAt(acc.id, 0);                       // 有一个活 → 复活/保持活
        else db.setDeadAt(acc.id, acc.dead_at || Date.now());           // 都失效 → 首次定格死亡时间(已死则保持)
        broadcast("status", {id: acc.id, ...db.getAccount(acc.id)});    // dead_at 变化 → 前端存活列刷新
    }
}
async function runDailyMaintenance(trigger = "cron") {
    if (scheduler.daily.running) return {ok: false, reason: "上次维护还在跑"};
    const items = scheduler.daily.items || {};
    const accs = db.listAccounts("success").filter((a) => !a.sold_at); // 已售出的号不再保活
    scheduler.daily.running = true;
    scheduler.emit("daily", scheduler.daily);
    broadcast("log", {id: 0, line: `[定时·${trigger}] 开始维护 ${accs.length} 个号 (养号:${!!items.chat} rt:${!!items.rt} at:${!!items.at})`, ts: Date.now()});
    let chatN = 0, rtN = 0, atN = 0;
    try {
        if (accs.length) {
            // at/rt 合并成 maintainOne(综合判死活);养号单独(headed 浏览器低并发)
            if (items.at || items.rt) { await runPool(accs, (a) => maintainOne(a, items), 6); atN = items.at ? accs.length : 0; rtN = items.rt ? accs.length : 0; }
            if (items.chat) { await runPool(accs, (a) => runChatWorker(a, ""), 2); chatN = accs.length; }
        }
        scheduler.recordDailyRun({chatN, rtN, atN, accounts: accs.length, trigger});
        broadcast("log", {id: 0, line: `[定时·${trigger}] 维护完成:${scheduler.daily.lastResult}`, ts: Date.now()});
        return {ok: true, accounts: accs.length, chatN, rtN, atN};
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
app.post("/api/control/daily/run", (req, res) => {
    if (scheduler.daily.running) return res.status(409).json({error: "维护正在进行中"});
    res.json({ok: true, started: true, accounts: db.listAccounts("success").length});
    runDailyMaintenance("manual"); // 后台跑，进度走 SSE
});

// ---------- 批量下载：导出 session 文件【内容】(非路径)，不含 token 字段 ----------
function readSession(authFile: string): unknown {
    try { return JSON.parse(readFileSync(authFile, "utf8")); } catch { return null; }
}
// 选中导出(邮箱----密码----rt----at) + 可选标记已售出。POST 返回纯文本，前端 blob 下载。
app.post("/api/export/selected", (req, res) => {
    const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(Number).filter(Boolean) : [];
    const markSold = req.body?.markSold === true;
    const rows = ids.length ? ids.map((id) => db.getAccount(id)).filter(Boolean) : db.listAccounts("success");
    const lines = rows.map((r) => {
        const at = (readAuthTokens(r.auth_file) || {}).accessToken || "";
        const rt = (readAuthTokens(r.rt_file) || {}).refreshToken || (readAuthTokens(r.auth_file) || {}).refreshToken || "";
        return `${r.email}----${r.password}----${rt}----${at}`;
    });
    if (markSold && ids.length) {
        db.markSold(ids);
        broadcast("snapshot", db.listAccounts());
        broadcast("stats", db.stats());
    }
    res.set("Content-Type", "text/plain; charset=utf-8");
    res.send(lines.join("\n"));
});
app.get("/api/export", (req, res) => {
    const format = String(req.query.format || "jsonl");
    const rows = db.listAccounts("success");
    const records = rows.map((r) => ({
        email: r.email,
        password: r.password,
        card: r.card || "",   // 绑定的接码卡密(新格式，导出用)
        phone: r.phone || "", // 绑定的接码手机号，不含接码链接
        plan: r.plan,
        session: readSession(r.auth_file), // auth 文件的原始内容(含 /api/auth/session)
    }));
    if (format === "csv") {
        const head = "email,password,card,phone,plan,session\n";
        const body = records.map((r) =>
            [r.email, r.password, r.card, r.phone, r.plan, JSON.stringify(r.session)]
                .map((v) => `"${String(v ?? "").replace(/"/g, '""')}"`).join(",")).join("\n");
        res.set("Content-Type", "text/csv; charset=utf-8");
        res.set("Content-Disposition", `attachment; filename="accounts.csv"`);
        return res.send(head + body);
    }
    if (format === "txt") {
        // 每行 邮箱----密码----rt----at。rt 取 codex 文件(rt_file)的 refresh_token;at 取网页文件(auth_file)的 access_token
        const lines = rows.map((r) => {
            const at = (readAuthTokens(r.auth_file) || {}).accessToken || "";
            const rt = (readAuthTokens(r.rt_file) || {}).refreshToken || (readAuthTokens(r.auth_file) || {}).refreshToken || "";
            return `${r.email}----${r.password}----${rt}----${at}`;
        });
        res.set("Content-Type", "text/plain; charset=utf-8");
        res.set("Content-Disposition", `attachment; filename="accounts.txt"`);
        return res.send(lines.join("\n"));
    }
    // 默认 jsonl：每行一个账号，session 为文件内容对象
    res.set("Content-Type", "application/x-ndjson; charset=utf-8");
    res.set("Content-Disposition", `attachment; filename="accounts.jsonl"`);
    res.send(records.map((r) => JSON.stringify(r)).join("\n"));
});

// 新导出:按批次/范围导出,格式区分带rt与只有at
//   带rt : 邮箱----邮箱密码----GPT密码----rt----sessjson
//   只有at: 邮箱----邮箱密码----GPT密码----sessjson
//   csv:统一列(邮箱,邮箱密码,GPT密码,rt,sessjson);txt:上述 ---- 分隔、每行一条。
//   query: format=txt|csv, scope=all|hasRt|atOnly, batch=<批次名>(不传=全部), ids=1,2,3(选中)
app.get("/api/export/full", (req, res) => {
    const format = String(req.query.format || "txt");
    const scope = String(req.query.scope || "all");
    const batch = req.query.batch != null ? String(req.query.batch) : null;
    const idSet = req.query.ids ? new Set(String(req.query.ids).split(",").map(Number)) : null;

    let rows = db.listAccounts("success");
    if (batch != null) rows = rows.filter((r) => (r.batch || "") === batch);
    if (idSet) rows = rows.filter((r) => idSet.has(r.id));
    if (scope === "hasRt") rows = rows.filter((r) => r.rt_file);
    else if (scope === "atOnly") rows = rows.filter((r) => !r.rt_file);
    if (req.query.markSold === "1" && rows.length) { // 导出同时标记已售出
        try { db.markSold(rows.map((r) => r.id)); broadcast("snapshot", db.listAccounts()); } catch (_) { /* ignore */ }
    }

    const gptPw = appConfig.defaultPassword || "";
    const recs = rows.map((r) => {
        const at = readAuthTokens(r.auth_file) || {};
        const rt = (readAuthTokens(r.rt_file) || {}).refreshToken || at.refreshToken || "";
        const sess = readSession(r.auth_file);
        return {email: r.email, mailPw: r.password, gpt: r.auth_file ? gptPw : "", rt, sessjson: sess ? JSON.stringify(sess) : "", hasRt: !!rt};
    });

    if (format === "csv") {
        const head = "邮箱,邮箱密码,GPT密码,rt,sessjson\n";
        const body = recs.map((r) => [r.email, r.mailPw, r.gpt, r.rt, r.sessjson]
            .map((v) => `"${String(v ?? "").replace(/"/g, '""')}"`).join(",")).join("\n");
        res.set("Content-Type", "text/csv; charset=utf-8");
        res.set("Content-Disposition", `attachment; filename="export.csv"`);
        return res.send(head + body);
    }
    const lines = recs.map((r) => r.hasRt
        ? [r.email, r.mailPw, r.gpt, r.rt, r.sessjson].join("----")
        : [r.email, r.mailPw, r.gpt, r.sessjson].join("----"));
    res.set("Content-Type", "text/plain; charset=utf-8");
    res.set("Content-Disposition", `attachment; filename="export.txt"`);
    res.send(lines.join("\n"));
});

// 批次列表(去重+计数,按最近导入排序:最近的在前。用于前端筛选/导出下拉 + 导入默认上一个批次)
app.get("/api/batches", (req, res) => {
    const map = new Map();
    for (const r of db.listAccounts()) {
        const b = r.batch || ""; if (!b) continue;
        const e = map.get(b) || {count: 0, lastId: 0};
        e.count += 1; e.lastId = Math.max(e.lastId, r.id);
        map.set(b, e);
    }
    const arr = [...map.entries()].map(([name, e]) => ({name, count: e.count, lastId: e.lastId}));
    arr.sort((a, b) => b.lastId - a.lastId); // 最近导入(最大 id)的批次排最前
    res.json(arr.map(({name, count}) => ({name, count})));
});

// ---------- 静态前端(生产) ----------
if (existsSync(WEB_DIST)) {
    app.use(express.static(WEB_DIST, {setHeaders: (res, p) => { if (p.endsWith(".html")) res.setHeader("Cache-Control", "no-cache"); }}));
    app.get(/^(?!\/api).*/, (req, res) => { res.set("Cache-Control", "no-cache"); res.sendFile(path.join(WEB_DIST, "index.html")); });
}

setMailProxy(scheduler.mailProxy); // 收件箱初始用邮箱代理(config.mailProxyUrl)
// 重启自启:若持久化了 vless，自动重新起独立 xray 并把 regProxy 指向它
if (scheduler.xrayVless) {
    try {
        const r = startXray(scheduler.xrayVless);
        scheduler.regProxy = `socks5://127.0.0.1:${r.port}`;
        console.log(`[server] 独立 xray 已自启: ${r.node} @ 127.0.0.1:${r.port}`);
    } catch (e: any) {
        console.warn(`[server] 独立 xray 自启失败: ${e?.message ?? e}`);
    }
}
app.listen(PORT, () => {
    console.log(`[server] http://localhost:${PORT}  (前端 ${existsSync(WEB_DIST) ? "已托管" : "未构建, 用 vite dev"})`);
});
