// @ts-nocheck
// 并发调度器：worker 子进程池，支持并发数配置 / 暂停 / 恢复 / 重跑
import {EventEmitter} from "node:events";
import {spawn, execSync} from "node:child_process";
import {writeFileSync, rmSync, mkdtempSync, readFileSync, existsSync} from "node:fs";
import os from "node:os";
import path from "node:path";
import {fileURLToPath} from "node:url";
import * as db from "./db.js";
import {appConfig} from "../src/config.js";
import {randomPassword} from "../src/utils.js";
import {resolveEngine} from "./domain/register-engine.js";
import {mailProxyPool, gptProxyPool, expandProxyImport, toProxyImportLine, setMailProxyJump} from "../src/mail/proxy-pool.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CODEX_ROOT = path.resolve(__dirname, "..");
const IS_WIN = process.platform === "win32";
const TSX_BIN = (() => {
    const local = path.resolve(CODEX_ROOT, "node_modules", ".bin", "tsx" + (IS_WIN ? ".cmd" : ""));
    if (existsSync(local)) return local;
    return "tsx";
})();
const EVENT_PREFIX = "@@EVENT@@";
const DAILY_FILE = path.resolve(CODEX_ROOT, "data", "daily.json"); // 定时任务配置+统计持久化
const SETTINGS_FILE = path.resolve(CODEX_ROOT, "data", "settings.json"); // 运行时配置持久化(前端改的开关/代理/上限等)
// 持久化的运行时配置字段(其余如 paused/running 是运行态不存)
const SETTINGS_KEYS = ["concurrency", "otpSingle", "simulateChat", "regProxy", "mailProxy", "mailProxyEnabled", "smsEnabled", "smsLinkTemplate", "rtEnabled", "smsMaxBind", "xrayVless", "regEngine", "bitBrowser", "claudeProxy", "claudeXrayVless", "regProxyPort", "claudeProxyPort", "mailSeparator", "rechargeBaseUrl", "rechargeAppId", "rechargeApiKey", "rechargeForwardIp", "rechargeConcurrency", "rechargeInterval", "xrayBinPath", "pwConcurrency", "rtProxy", "rtConcurrency", "mfaEnabled", "rebindGmailAfterPaid", "rebindAfterPaid", "mailProxyPool", "mailProxyJump", "gptProxyPool", "gptProxyJump"];

// 定时任务默认配置(含运行统计)。持久化到 data/daily.json，重启保留。
const DAILY_DEFAULT = {
    enabled: false,
    hour: 4,                              // 每天几点跑(0-23，本地时区)
    items: {chat: true, rt: true, at: true}, // 跑哪些:养号/rt续期/at续期
    lastRunAt: 0,                         // 最后一次运行时间戳(ms)
    runCount: 0,                          // 累计运行(触发)次数
    chatTotal: 0,                         // 累计养号次数(每次运行的养号账号数累加)
    rtTotal: 0,                           // 累计 rt 续期次数
    atTotal: 0,                           // 累计 at 续期次数
    lastResult: "",                       // 最后一次运行摘要
    running: false,                       // 运行中标志(防重入，不持久化)
};

class Scheduler extends EventEmitter {
    constructor() {
        super();
        this.concurrency = 2;
        this.otpSingle = true;         // 默认单封验证码(跳过主动二次发码)
        this.simulateChat = true;      // 默认注册后模拟一次聊天(养号)
        this.regProxy = appConfig.defaultProxyUrl;  // 注册 GPT 代理
        this.mailProxy = appConfig.mailProxyUrl;     // 邮箱登录代理(默认空=直连)
        this.mailProxyEnabled = true;  // 邮箱代理开关(false=即使配了也不走代理)
        this.smsEnabled = true;        // 注册若要求手机验证(add-phone)时启用接码池，不要求则不影响
        this.smsLinkTemplate = appConfig.smsLinkTemplate; // 接码收码链接模板(key/project 通用，phone 动态替换)
        this.rtEnabled = false;        // 注册成功后是否额外走 codex OAuth 拿可续期 rt(强制 add-phone，接码有成本，默认关)
        this.mfaEnabled = true;        // 注册成功后绑 TOTP,后续登录走密码+验证器,少靠邮箱
        this.smsMaxBind = 3;           // 每个接码号最多绑定几个账号(0=不限，直到被 OpenAI 拒)
        this.xrayVless = "";           // 已废弃：GPT 不再起独立 xray，注册走 gptProxyPool + jump
        this.regEngine = "http";       // 注册引擎:http(sentinel HTTP 模拟) / browser(真 Chrome 过 CF)
        this.bitBrowser = false;       // 浏览器引擎用比特浏览器:每号独立指纹窗口(需本地比特客户端开着 Local API)
        // deleteMailboxWithAccount 已废弃，所有删除一律软删邮箱
        this.rechargeBaseUrl = "";     // 充值平台 API Base URL(如 https://xxx.com/api/open/v1)
        this.rechargeAppId = "";       // 充值平台 App ID(ak_xxxx)
        this.rechargeApiKey = "";      // 充值平台 API Key(sk_xxxx)
        this.rechargeForwardIp = "";   // 充值请求 X-Forwarded-For 透传 IP(空则用直连 IP)
        this.rechargeConcurrency = 3;  // 充值提交并发数
        this.rechargeInterval = 3;     // 每批次间隔(秒)
        this.paused = true;            // GPT 域暂停(默认暂停，前端点"开始"才跑)
        this.pausedClaude = true;      // Claude 域暂停(独立,三域各自控制)
        // Claude 独立代理(过 claude.ai CF,与 GPT 的 regProxy 分开;空=回退 regProxy)+ 独立 vless
        this.claudeProxy = "";
        this.claudeXrayVless = "";
        // 独立 xray 的本地监听端口(可配置+持久化):用专属端口与系统 v2rayN/其他服务隔离,清理时只按各自端口精确清,永不误杀。
        this.regProxyPort = 10809;
        this.claudeProxyPort = 10810;
        this.mailSeparator = "----";   // 邮箱----密码 分隔符(导入/校验共用)
        this.xrayBinPath = "";         // xray 二进制路径(前端可配;空=自动探测)
        this.pwConcurrency = 1;        // 邮箱批量改密并发(headed Chrome,默认串行)
        this.rtProxy = "";             // 充值页代理:重登过 CF + RT 刷新/获取(空=回退 regProxy)
        this.rtConcurrency = 4;        // 导出含RT时并发获取数
        this.rebindAfterPaid = "gmail";   // 充值平台回 paid 后换绑目标: off | gmail | mailcom
        this.rebindGmailAfterPaid = true; // 兼容旧配置(true=gmail)
        this.mailProxyPool = [];          // 邮箱整备/换2FA/改密专用代理池(一行一个,1代理=1指纹)
        this.mailProxyJump = "";          // 邮箱任务跳板
        this.gptProxyPool = [];           // GPT 注册专用代理池，和邮箱池分开租
        this.gptProxyJump = "";           // GPT 注册跳板
        this.running = new Map();      // runId(`${domain}:${id}`) -> { child, tmpFile, gotResult, domain, id, mailboxId, engine }
        this.maintLock = null; // 浏览器维护互斥锁:null=空闲, string=持有者标识(如 "batch-at-relogin")
        this.releasingGpt = false;     // 本实例停止 GPT:被杀 worker 退回 pending,供其他实例认领
        this.releasingClaude = false;
        this.tmpDir = mkdtempSync(path.join(os.tmpdir(), "codex-reg-"));
        this.daily = this.loadDaily(); // 定时任务配置+统计(持久化)
        this.loadSettings();           // 覆盖上面默认值为上次持久化的运行时配置
        mailProxyPool.setUrls(this.mailProxyPool || []);
        gptProxyPool.setUrls(this.gptProxyPool || []);
        setMailProxyJump(this.mailProxyJump || "");
        // 多实例:其他实例退回的 pending 不会触发本机事件,空闲时靠这轮询接着认领
        setInterval(() => { if (!this.paused || !this.pausedClaude) this.tick(); }, 3000);
    }

    // ---- 运行时配置持久化(data/settings.json) ----
    loadSettings() {
        try {
            if (existsSync(SETTINGS_FILE)) {
                const s = JSON.parse(readFileSync(SETTINGS_FILE, "utf8"));
                for (const k of SETTINGS_KEYS) if (s[k] !== undefined) this[k] = s[k];
                if (Array.isArray(s.mailProxyPool)) this.mailProxyPool = s.mailProxyPool;
                if (s.mailProxyJump === undefined) this.mailProxyJump = this.detectMailProxyJump();
                if (s.gptProxyPool === undefined) this.gptProxyPool = Array.isArray(this.mailProxyPool) ? this.mailProxyPool.slice() : [];
                else if (Array.isArray(s.gptProxyPool)) this.gptProxyPool = s.gptProxyPool;
                if (s.gptProxyJump === undefined) this.gptProxyJump = this.mailProxyJump || this.detectMailProxyJump();
                this.normalizeRebindAfterPaid();
                if (s.gptProxyPool === undefined || s.gptProxyJump === undefined) this.saveSettings();
            } else {
                this.mailProxyJump = this.detectMailProxyJump();
                this.gptProxyJump = this.mailProxyJump;
            }
        } catch { /* 损坏则保留默认 */ }
    }
    normalizeRebindAfterPaid() {
        const v = String(this.rebindAfterPaid || "");
        if (v === "off" || v === "gmail" || v === "mailcom") {
            this.rebindGmailAfterPaid = v === "gmail";
            return;
        }
        this.rebindAfterPaid = this.rebindGmailAfterPaid === false ? "off" : "gmail";
        this.rebindGmailAfterPaid = this.rebindAfterPaid === "gmail";
    }
    saveSettings() {
        try {
            const out = {};
            for (const k of SETTINGS_KEYS) out[k] = this[k];
            writeFileSync(SETTINGS_FILE, JSON.stringify(out, null, 2) + "\n", "utf8");
        } catch { /* 忽略写失败 */ }
    }

    // ---- 定时任务(每天养号+rt续期+at续期) ----
    loadDaily() {
        const d = {...DAILY_DEFAULT, items: {...DAILY_DEFAULT.items}};
        try {
            if (existsSync(DAILY_FILE)) {
                const saved = JSON.parse(readFileSync(DAILY_FILE, "utf8"));
                Object.assign(d, saved, {items: {...d.items, ...(saved.items || {})}, running: false});
            }
        } catch { /* 损坏则用默认 */ }
        return d;
    }
    saveDaily() {
        try {
            const {running, ...persist} = this.daily; // running 是内存态，不持久化
            writeFileSync(DAILY_FILE, JSON.stringify(persist, null, 2) + "\n", "utf8");
        } catch { /* 忽略写失败 */ }
    }
    setDaily({enabled, hour, items} = {}) {
        if (typeof enabled === "boolean") this.daily.enabled = enabled;
        if (Number.isInteger(hour)) this.daily.hour = Math.max(0, Math.min(23, hour));
        if (items && typeof items === "object") this.daily.items = {...this.daily.items, ...items};
        this.saveDaily();
        this.emit("daily", this.daily);
        return this.daily;
    }
    // 运行结束后记录统计(lastRunAt/runCount/各项累计/摘要)
    recordDailyRun({chatN = 0, rtN = 0, atN = 0, accounts = 0, trigger = "cron"} = {}) {
        this.daily.lastRunAt = Date.now();
        this.daily.runCount += 1;
        this.daily.chatTotal += chatN;
        this.daily.rtTotal += rtN;
        this.daily.atTotal += atN;
        this.daily.lastResult = `[${trigger}] ${accounts}个号 · 养号${chatN}/rt${rtN}/at${atN}`;
        this.saveDaily();
        this.emit("daily", this.daily);
    }

    setConcurrency(n) {
        this.concurrency = Math.max(1, Math.min(16, Number(n) || 1));
        this.saveSettings();
        this.tick();
        return this.concurrency;
    }

    setPwConcurrency(n) {
        this.pwConcurrency = Math.max(1, Math.min(8, Number(n) || 1));
        this.saveSettings();
        return this.pwConcurrency;
    }

    setMailProxyPool(textOrList, {append = false, copies = 1} = {}) {
        const incoming = Array.isArray(textOrList)
            ? expandProxyImport(textOrList.join("\n"), copies)
            : expandProxyImport(String(textOrList || ""), copies);
        const prev = Array.isArray(this.mailProxyPool) ? this.mailProxyPool.slice() : [];
        const prevSet = new Set(prev);
        const inserted = incoming.filter((u) => !prevSet.has(u));
        const skipped = incoming.length - inserted.length;
        const urls = append ? [...prev, ...inserted] : incoming;
        this.mailProxyPool = urls;
        mailProxyPool.setUrls(urls);
        this.saveSettings();
        return {
            ...this.mailProxyPoolSnap(),
            inserted: append ? inserted.length : incoming.length,
            skipped: append ? skipped : 0,
            lines: urls.map(toProxyImportLine),
        };
    }

    mailProxyFallback() {
        if (this.mailProxyEnabled !== false && this.mailProxy) return this.mailProxy;
        return this.regProxy || "";
    }

    mailProxyPoolSnap() {
        return mailProxyPool.snapshot(this.mailProxyFallback());
    }

    detectMailProxyJump() {
        try {
            execSync("lsof -tiTCP:10808 -sTCP:LISTEN", {stdio: "ignore"});
            return "socks5://127.0.0.1:10808";
        } catch { /* 系统代理没开 */ }
        return this.regProxy || "";
    }

    setMailProxyJump(url) {
        this.mailProxyJump = String(url || "").trim();
        setMailProxyJump(this.mailProxyJump);
        this.saveSettings();
        return this.mailProxyJump;
    }

    setGptProxyPool(textOrList, {append = false, copies = 1} = {}) {
        const incoming = Array.isArray(textOrList)
            ? expandProxyImport(textOrList.join("\n"), copies)
            : expandProxyImport(String(textOrList || ""), copies);
        const prev = Array.isArray(this.gptProxyPool) ? this.gptProxyPool.slice() : [];
        const prevSet = new Set(prev);
        const inserted = incoming.filter((u) => !prevSet.has(u));
        const skipped = incoming.length - inserted.length;
        const urls = append ? [...prev, ...inserted] : incoming;
        this.gptProxyPool = urls;
        gptProxyPool.setUrls(urls);
        this.saveSettings();
        return {
            ...this.gptProxyPoolSnap(),
            inserted: append ? inserted.length : incoming.length,
            skipped: append ? skipped : 0,
            lines: urls.map(toProxyImportLine),
        };
    }

    gptProxyPoolSnap() {
        return gptProxyPool.snapshot("");
    }

    setGptProxyJump(url) {
        this.gptProxyJump = String(url || "").trim();
        this.saveSettings();
        return this.gptProxyJump;
    }

    // ---- 域级控制(GPT/Claude 各自暂停/停止,共用同一进程池) ----
    start() { this.paused = false; this.tick(); }
    pause() { this.paused = true; }
    stopAll() { this.paused = true; this.killDomain("gpt"); }
    startClaude() { this.pausedClaude = false; this.tick(); }
    pauseClaude() { this.pausedClaude = true; }
    stopClaude() { this.pausedClaude = true; this.killDomain("claude"); }
    killDomain(domain) {
        for (const info of this.running.values()) {
            if (info.domain === domain) {
                info.releasing = true;
                try { info.child.kill("SIGTERM"); } catch { /* ignore */ }
            }
        }
    }

    // 浏览器维护互斥:acquireLock 成功返回 true 并设置持有者;releaseLock 只有持有者自己能释放
    acquireLock(owner) { if (this.maintLock) return false; this.maintLock = owner; return true; }
    releaseLock(owner) { if (this.maintLock === owner) { this.maintLock = null; return true; } return false; }

    // 某业务号是否正在跑(默认 gpt 域;index.ts 删/改前检查用)。running 键是复合 `${domain}:${id}`。
    isRunning(id, domain = "gpt") { return this.running.has(`${domain}:${id}`); }

    async retry(id) {
        if (this.isRunning(id)) return false;
        await db.resetToPending(id);
        this.emit("status", {id, status: "pending"});
        this.emit("stats", await db.stats());
        this.tick();
        return true;
    }

    async retryAllFailed() {
        await db.resetAllFailed();
        this.emit("stats", await db.stats());
        await this.broadcastSnapshot();
        this.tick();
    }

    async broadcastSnapshot() {
        this.emit("snapshot", await db.listAccounts());
    }

    state() {
        return {instanceId: db.instanceId, paused: this.paused, pausedClaude: this.pausedClaude, concurrency: this.concurrency, otpSingle: this.otpSingle, simulateChat: this.simulateChat, smsEnabled: this.smsEnabled, smsLinkTemplate: this.smsLinkTemplate, rtEnabled: this.rtEnabled, mfaEnabled: this.mfaEnabled !== false, smsMaxBind: this.smsMaxBind, regEngine: this.regEngine, bitBrowser: this.bitBrowser, daily: this.daily, regProxy: this.regProxy, mailProxy: this.mailProxy, mailProxyEnabled: this.mailProxyEnabled !== false, claudeProxy: this.claudeProxy, xrayVless: this.xrayVless || "", claudeXrayVless: this.claudeXrayVless, regProxyPort: this.regProxyPort, claudeProxyPort: this.claudeProxyPort, mailSeparator: this.mailSeparator, xrayBinPath: this.xrayBinPath || "",
            pwConcurrency: this.pwConcurrency, rtProxy: this.rtProxy || "", rtConcurrency: this.rtConcurrency, defaultPassword: String(appConfig.defaultPassword || "").trim(),
            mailProxyPool: this.mailProxyPool || [], mailProxyPoolLines: (this.mailProxyPool || []).map(toProxyImportLine), mailProxyPoolSnap: this.mailProxyPoolSnap(),
            mailProxyJump: this.mailProxyJump || "",
            gptProxyPool: this.gptProxyPool || [], gptProxyPoolLines: (this.gptProxyPool || []).map(toProxyImportLine), gptProxyPoolSnap: this.gptProxyPoolSnap(),
            gptProxyJump: this.gptProxyJump || "",
            running: [...this.running.values()].filter((i) => i.domain === "gpt").map((i) => i.id),
            runningClaude: [...this.running.values()].filter((i) => i.domain === "claude").map((i) => i.id)};
    }

    async tick() {
        if (this.ticking) return;
        this.ticking = true;
        try {
        if (this.paused && this.pausedClaude) return; // 两域都暂停才完全不认领
        // 浏览器引擎跑真 Chrome(headed，重)，硬上限 4，避免开一堆窗口卡机；用户并发设更小则用更小
        const effective = this.regEngine === "browser" ? Math.min(this.concurrency, 4) : this.concurrency;
        while (this.running.size < effective) {
            // 各域仅在本域未暂停时认领。GPT 优先,再 Claude。邮箱整备不占这池。
            let acc = null;
            if (!this.paused) acc = await db.claimNext();
            if (!acc && !this.pausedClaude) acc = await db.claimNextClaude();
            if (!acc) break;
            if ((acc.domain || "gpt") === "gpt") {
                const snap = this.gptProxyPoolSnap();
                const busy = [...this.running.values()].filter((i) => i.wantGptPool).length;
                if (busy >= Math.max(1, snap.slots || 1)) {
                    await db.releaseGptIfRunning(acc.id);
                    this.log(acc.id, "GPT 代理池已满（1 代理 = 1 指纹），先退回排队");
                    break;
                }
            }
            this.spawnWorker(acc);
        }
        this.emit("stats", await db.stats());
        } finally { this.ticking = false; }
    }

    // running Map 键=复合 runId(`${domain}:${id}`),避免 gpt/claude 各自自增 id 重叠碰撞。
    async spawnWorker(acc) {
        const domain = acc.domain || "gpt";
        if (domain === "gpt" && !acc.gpt_password) {
            const touched = !!(acc.auth_file || acc.token || acc.error || acc.started_at);
            const pw = touched ? String(appConfig.defaultPassword || "").trim() : randomPassword(16);
            if (pw) {
                await db.updateAccount(acc.id, {gpt_password: pw});
                acc.gpt_password = pw;
            }
        }
        const runId = `${domain}:${acc.id}`;
        const tmpFile = path.join(this.tmpDir, `mc-${domain}-${acc.id}.txt`);
        writeFileSync(tmpFile, [acc.email, acc.password, acc.mailbox_totp || "", acc.recovery_email || "", acc.mailbox_imap || ""].join("----") + "\n", "utf8");
        const info = {child: null, tmpFile, gotResult: false, engine: null, domain, id: acc.id, mailboxId: acc.mailbox_id, releasing: false, wantGptPool: domain === "gpt", mailLease: null};
        this.running.set(runId, info);
        if (info.wantGptPool) {
            try {
                info.mailLease = await gptProxyPool.lease(acc.email, {
                    fallback: "",
                    timeoutMs: 20_000,
                    maxPerTemplate: 1,
                });
                const jump = this.gptProxyJump || "";
                this.logJob(info, `GPT 代理池租到 ${String(info.mailLease.url || "直连").replace(/:[^:@/]+@/, ":***@")}（1 代理 = 1 指纹${jump ? `，经跳板 ${jump}` : "，无跳板直连网关"}）`);
            } catch (e) {
                this.running.delete(runId);
                await db.releaseGptIfRunning(acc.id);
                this.log(acc.id, `GPT 代理池租不到: ${e?.message || e}，退回排队`);
                return;
            }
        }

        // 注册知识收敛在引擎:调度器只管进程/并发/事件(通用)。按账号所属域选引擎。
        const engine = resolveEngine(domain);
        const {script, env} = engine.buildSpawn(acc, this, tmpFile);
        if (info.mailLease) env.PROXY_URL = info.mailLease.url || "";
        env.MAIL_PROXY_JUMP = this.gptProxyJump || env.MAIL_PROXY_JUMP || "";
        const child = spawn(TSX_BIN, [script], {cwd: CODEX_ROOT, env: {...process.env, ...env}, shell: IS_WIN});
        info.child = child;
        info.engine = engine;
        if (domain === "claude") this.emit("claude", {stats: await db.claudeStats()});
        else { this.emit("status", {id: acc.id, status: "running"}); this.emit("stats", await db.stats()); }
        this.logJob(info, `▶ 启动注册 worker (pid=${child.pid})`);

        let buf = "";
        const onData = async (chunk) => {
            buf += chunk.toString();
            let idx;
            while ((idx = buf.indexOf("\n")) >= 0) {
                const line = buf.slice(0, idx);
                buf = buf.slice(idx + 1);
                await this.handleLine(info, line);
            }
        };
        child.stdout.on("data", onData);
        child.stderr.on("data", (d) => { const t = d.toString().trim(); if (t) this.logJob(info, `[stderr] ${t}`); });
        child.on("error", (err) => this.logJob(info, `[spawn error] ${err?.message ?? err}`));
        child.on("exit", (code) => this.onExit(runId, code));
    }

    // job runner 只做:分帧解析 worker 输出 → result 事件转发给该 job 的引擎解释,普通行落日志。
    async handleLine(info, line) {
        if (!line.trim()) return;
        if (line.startsWith(EVENT_PREFIX)) {
            let ev;
            try { ev = JSON.parse(line.slice(EVENT_PREFIX.length)); } catch { return; }
            if (ev.type === "result") { info.gotResult = true; await info.engine.onResult(this, info.id, ev); }
            else if (ev.type === "mailbox_update") {
                await db.applyMailboxUpdate(ev.email || "", {
                    password: ev.password, totp_secret: ev.totp_secret,
                    imap_password: ev.imap_password, recovery_email: ev.recovery_email,
                }).catch(() => {});
                if (ev.message) this.logJob(info, ev.message);
                else this.logJob(info, `邮箱凭证已更新${ev.imap_password ? "(应用专用密码)" : ""}`);
            }
            else if (ev.message) this.logJob(info, ev.message);
        } else {
            this.logJob(info, line);
        }
    }

    // 帧日志(内部)按域路由:claude→独立 claude_logs(键 claude_account id);gpt→logs 表。三域日志各自独立。fire-and-forget 写库,不阻塞事件流。
    logJob(info, line) {
        if (info.domain === "claude") { db.appendClaudeLog(info.id, line).catch(() => {}); this.emit("claudeLog", {id: info.id, line, ts: Date.now()}); }
        else { db.appendLog(info.id, line).catch(() => {}); this.emit("log", {id: info.id, line, ts: Date.now()}); }
    }

    // 引擎用的公共日志(GPT onResult 调 runner.log(id,...))→ logs 表。claude onResult 不用(见 register-engine)。fire-and-forget。
    log(id, line) {
        db.appendLog(id, line).catch(() => {});
        this.emit("log", {id, line, ts: Date.now()});
    }

    async onExit(runId, code) {
        const info = this.running.get(runId);
        this.running.delete(runId);
        if (info) {
            try { info.mailLease?.release(); } catch { /* */ }
            try { rmSync(info.tmpFile, {force: true}); } catch { /* ignore */ }
            // 没收到结果事件就退出 = 异常,交由引擎按域解释
            if (!info.gotResult && info.engine) await info.engine.onAbnormalExit(this, info.id, code, info);
        }
        this.emit("stats", await db.stats());
        this.tick(); // 释放槽位，继续下一个
    }
}

export const scheduler = new Scheduler();
