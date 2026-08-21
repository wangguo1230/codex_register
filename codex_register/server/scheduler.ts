// @ts-nocheck
// 并发调度器：worker 子进程池，支持并发数配置 / 暂停 / 恢复 / 重跑
import {EventEmitter} from "node:events";
import path from "node:path";
import {fileURLToPath} from "node:url";
import * as db from "./db.js";
import {appConfig} from "../src/config.js";
import {mailProxyPool, gptProxyPool, toProxyImportLine, setMailProxyJump} from "../src/mail/proxy-pool.js";
import {listJumpXrays} from "./xray-proxy.js";
import {createSchedulerSettingsStore, SCHEDULER_SETTINGS_KEYS} from "./domain/scheduler-settings-store.js";
import {createOwnedOperationLock} from "./domain/owned-operation-lock.js";
import {startSchedulerPollLoop} from "./domain/scheduler-poll-loop.js";
import {createRegistrationWorkerRunner} from "./domain/registration-worker-runner.js";
import {createSchedulerProxyService} from "./domain/scheduler-proxy-service.js";
import {terminateChildProcess} from "./domain/child-process-control.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CODEX_ROOT = path.resolve(__dirname, "..");
const DAILY_FILE = path.resolve(CODEX_ROOT, "data", "daily.json"); // 定时任务配置+统计持久化
const SETTINGS_FILE = path.resolve(CODEX_ROOT, "data", "settings.json"); // 运行时配置持久化(前端改的开关/代理/上限等)
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
        this.rebindConcurrency = 3;    // Gmail 换绑并发数
        this.rechargeInterval = 3;     // 每批次间隔(秒)
        this.paused = true;            // GPT 域暂停(默认暂停，前端点"开始"才跑)
        this.pausedClaude = true;      // Claude 域暂停(独立,三域各自控制)
        // Claude 独立代理(过 claude.ai CF,与 GPT 的 regProxy 分开;空=回退 regProxy)+ 独立 vless
        this.claudeProxy = "";
        this.claudeXrayVless = "";
        // 独立 xray 的本地监听端口(可配置+持久化):用专属端口与系统 v2rayN/其他服务隔离,清理时只按各自端口精确清,永不误杀。
        this.regProxyPort = 10809;
        this.claudeProxyPort = 10810;
        this.jumpProxyPort = 10811;    // 跳板 xray 起始端口，不占用用户 10808
        this.jumpXrayVless = "";       // 兼容：第一条跳板 vless
        this.jumpFleet = [];           // [{vless,socks,port,node,running,error}]
        this.mailSeparator = "----";   // 邮箱----密码 分隔符(导入/校验共用)
        this.xrayBinPath = "";         // xray 二进制路径(前端可配;空=自动探测)
        this.pwConcurrency = 1;        // 邮箱批量改密并发(headed Chrome,默认串行)
        this.rtProxy = "";             // 充值页代理:重登过 CF + RT 刷新/获取(空=回退 regProxy)
        this.rtConcurrency = 4;        // 导出含RT时并发获取数
        this.rebindAfterPaid = "gmail";   // 充值平台回 paid 后换绑目标: off | gmail | mailcom
        this.rebindGmailAfterPaid = true; // 兼容旧配置(true=gmail)
        this.rebindGmailProbeLogin = false; // Gmail 换绑前是否额外开比特探网页登录；默认只依赖换绑池的 IMAP 校验
        this.mailProxyPool = [];          // 邮箱整备/换2FA/改密专用代理池(一行一个,1代理=1指纹)
        this.mailProxyJump = "";          // 兼容：单条跳板（会并进 mailJumpPool）
        this.mailJumpPool = [];           // 邮箱跳板池，1 跳板最多带 2 条出口
        this.gptProxyPool = [];           // GPT 注册专用代理池，和邮箱池分开租
        this.gptProxyJump = "";           // 兼容：单条 GPT 跳板
        this.gptJumpPool = [];            // GPT 跳板池，1 跳板最多带 2 条出口
        // 统一代理池配置；mail/gpt 开关只控制业务视图，底层租约池是同一个。
        this.proxyPool = [];
        this.proxyPoolMailEnabled = true;
        this.proxyPoolGptEnabled = true;
        this.proxyJumpPool = [];
        this.proxyJumpMailEnabled = true;
        this.proxyJumpGptEnabled = true;
        this.running = new Map();      // runId(`${domain}:${id}`) -> { child, tmpFile, gotResult, domain, id, mailboxId, engine }
        this.workerRunner = createRegistrationWorkerRunner({scheduler: this, rootDir: CODEX_ROOT});
        this.proxyService = createSchedulerProxyService({settings: this});
        this.maintenanceLock = createOwnedOperationLock();
        this.releasingGpt = false;     // 本实例停止 GPT:被杀 worker 退回 pending,供其他实例认领
        this.releasingClaude = false;
        this.settingsStore = createSchedulerSettingsStore({settingsFile: SETTINGS_FILE, dailyFile: DAILY_FILE});
        this.daily = this.settingsStore.readDaily();
        this.loadSettings();           // 覆盖上面默认值为上次持久化的运行时配置
        this.syncProxyPoolsFromSettings();
        this.syncJumpPoolsFromSettings();
        setMailProxyJump(this.mailProxyJump || "");
        // 多实例:其他实例退回的 pending 不会触发本机事件,空闲时靠这轮询接着认领
        this.stopPollLoop = startSchedulerPollLoop({
            tick: () => this.tick(),
            isActive: () => !this.paused || !this.pausedClaude,
        });
    }

    // ---- 运行时配置持久化(data/settings.json) ----
    loadSettings() {
        try {
            const s = this.settingsStore.readSettings();
            if (s) {
                for (const k of SCHEDULER_SETTINGS_KEYS) if (s[k] !== undefined) this[k] = s[k];
                const legacyMailPool = Array.isArray(s.mailProxyPool) ? s.mailProxyPool : [];
                const legacyGptPool = Array.isArray(s.gptProxyPool) ? s.gptProxyPool : legacyMailPool;
                const hasSavedProxyPool = Array.isArray(s.proxyPool) && s.proxyPool.length > 0;
                if (!hasSavedProxyPool && (legacyMailPool.length || legacyGptPool.length)) this.proxyPool = [...legacyMailPool, ...legacyGptPool];
                this.proxyPool = [...new Set((this.proxyPool || []).map((value) => String(value || "").trim()).filter(Boolean))];
                if (s.proxyPoolMailEnabled === undefined) this.proxyPoolMailEnabled = legacyMailPool.length > 0 || hasSavedProxyPool;
                if (s.proxyPoolGptEnabled === undefined) this.proxyPoolGptEnabled = legacyGptPool.length > 0 || hasSavedProxyPool;

                const legacyMailJump = Array.isArray(s.mailJumpPool) ? s.mailJumpPool : (s.mailProxyJump ? [s.mailProxyJump] : []);
                const legacyGptJump = Array.isArray(s.gptJumpPool) ? s.gptJumpPool : (s.gptProxyJump ? [s.gptProxyJump] : legacyMailJump);
                const hasSavedJumpPool = Array.isArray(s.proxyJumpPool) && s.proxyJumpPool.length > 0;
                if (!hasSavedJumpPool && (legacyMailJump.length || legacyGptJump.length)) this.proxyJumpPool = [...legacyMailJump, ...legacyGptJump];
                this.proxyJumpPool = [...new Set((this.proxyJumpPool || []).map((value) => String(value || "").trim()).filter(Boolean))];
                if (s.proxyJumpMailEnabled === undefined) this.proxyJumpMailEnabled = legacyMailJump.length > 0 || hasSavedJumpPool;
                if (s.proxyJumpGptEnabled === undefined) this.proxyJumpGptEnabled = legacyGptJump.length > 0 || hasSavedJumpPool;
                if (s.mailProxyJump === undefined) this.mailProxyJump = this.detectMailProxyJump();
                if (s.gptProxyJump === undefined) this.gptProxyJump = this.mailProxyJump || this.detectMailProxyJump();
                this.normalizeRebindAfterPaid();
            } else {
                this.mailProxyJump = this.detectMailProxyJump();
                this.gptProxyJump = this.mailProxyJump;
            }
        } catch { /* 损坏则保留默认 */ }
    }

    /** 用户有没有给 GPT 单独配跳板。没有就不要借用邮箱跳板，注册直连代理池。 */
    hasGptJumpConfig(...args) { return this.proxyService.hasGptJumpConfig(...args); }
    collectJumpLines(...args) { return this.proxyService.collectJumpLines(...args); }
    resolveJumpLine(raw, fleet = this.jumpFleet || []) { return this.proxyService.resolveJumpLine(raw, fleet); }
    jumpPoolSnapshot(...args) { return this.proxyService.jumpPoolSnapshot(...args); }
    ensureJumpFleet(...args) { return this.proxyService.ensureJumpFleet(...args); }
    syncJumpPoolsFromSettings(...args) { return this.proxyService.syncJumpPoolsFromSettings(...args); }
    syncProxyPoolsFromSettings(...args) { return this.proxyService.syncProxyPoolsFromSettings(...args); }
    configureProxyPoolBackend(...args) { return this.proxyService.configureDistributedBackend(...args); }
    initializeSharedProxyPool(...args) { return this.proxyService.initializeSharedConfiguration(...args); }
    releaseOwnProxyLeases(...args) { return this.proxyService.releaseOwnProxyLeases(...args); }
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
        this.settingsStore.writeSettings(this);
    }

    // ---- 定时任务(每天养号+rt续期+at续期) ----
    loadDaily() {
        return this.settingsStore.readDaily();
    }
    saveDaily() {
        this.settingsStore.writeDaily(this.daily);
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

    setMailProxyPool(...args) { return this.proxyService.setMailProxyPool(...args); }
    setProxyPool(...args) { return this.proxyService.setProxyPool(...args); }
    setProxyPoolScopes(...args) { return this.proxyService.setProxyPoolScopes(...args); }
    proxyPoolSnap(...args) { return this.proxyService.proxyPoolSnap(...args); }
    publicProxyPoolSnap(...args) { return this.proxyService.publicProxyPoolSnap(...args); }
    proxyPoolEnabled(...args) { return this.proxyService.proxyPoolEnabled(...args); }
    mailProxyFallback(...args) { return this.proxyService.mailProxyFallback(...args); }
    mailProxyPoolSnap(...args) { return this.proxyService.mailProxyPoolSnap(...args); }
    detectMailProxyJump(...args) { return this.proxyService.detectMailProxyJump(...args); }
    portListening(...args) { return this.proxyService.portListening(...args); }
    setMailProxyJump(...args) { return this.proxyService.setMailProxyJump(...args); }
    setMailJumpPool(...args) { return this.proxyService.setMailJumpPool(...args); }
    setGptJumpPool(...args) { return this.proxyService.setGptJumpPool(...args); }
    applyJumpSocks(...args) { return this.proxyService.applyJumpSocks(...args); }
    setGptProxyPool(...args) { return this.proxyService.setGptProxyPool(...args); }
    gptProxyPoolSnap(...args) { return this.proxyService.gptProxyPoolSnap(...args); }
    publicJumpPoolSnapshot(...args) { return this.proxyService.publicJumpPoolSnapshot(...args); }
    setGptProxyJump(...args) { return this.proxyService.setGptProxyJump(...args); }
    setProxyJumpPool(...args) { return this.proxyService.setProxyJumpPool(...args); }
    setProxyJumpScopes(...args) { return this.proxyService.setProxyJumpScopes(...args); }

    // ---- 域级控制(GPT/Claude 各自暂停/停止,共用同一进程池) ----
    start() {
        this.paused = false;
        void Promise.resolve(this.tick()).catch((e) => console.error("[scheduler.start] tick:", e?.message || e));
    }
    pause() { this.paused = true; }
    stopAll() { this.paused = true; this.killDomain("gpt"); }
    startClaude() {
        this.pausedClaude = false;
        void Promise.resolve(this.tick()).catch((e) => console.error("[scheduler.startClaude] tick:", e?.message || e));
    }
    pauseClaude() { this.pausedClaude = true; }
    stopClaude() { this.pausedClaude = true; this.killDomain("claude"); }
    killDomain(domain) {
        for (const info of this.running.values()) {
            if (info.domain === domain) {
                info.releasing = true;
                info.cancelTermination?.();
                info.cancelTermination = terminateChildProcess(info.child, {graceMs: 12_000});
            }
        }
    }

    // 浏览器维护互斥:acquireLock 成功返回 true 并设置持有者;releaseLock 只有持有者自己能释放
    get maintLock() { return this.maintenanceLock.owner(); }
    acquireLock(owner) { return this.maintenanceLock.acquire(owner); }
    releaseLock(owner) { return this.maintenanceLock.release(owner); }

    dispose() {
        this.stopPollLoop?.();
        this.stopPollLoop = null;
        this.workerRunner.dispose();
    }

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
        return {instanceId: db.instanceId, paused: this.paused, pausedClaude: this.pausedClaude, concurrency: this.concurrency, otpSingle: this.otpSingle, simulateChat: this.simulateChat, smsEnabled: this.smsEnabled, smsLinkTemplate: this.smsLinkTemplate, rtEnabled: this.rtEnabled, mfaEnabled: this.mfaEnabled !== false, smsMaxBind: this.smsMaxBind, regEngine: this.regEngine, bitBrowser: this.bitBrowser, daily: this.daily, regProxy: this.regProxy, mailProxy: this.mailProxy, mailProxyEnabled: this.mailProxyEnabled !== false, claudeProxy: this.claudeProxy, xrayVless: this.xrayVless || "", claudeXrayVless: this.claudeXrayVless, jumpXrayVless: this.jumpXrayVless || "", jumpProxyPort: this.jumpProxyPort || 10811, regProxyPort: this.regProxyPort, claudeProxyPort: this.claudeProxyPort, mailSeparator: this.mailSeparator, xrayBinPath: this.xrayBinPath || "",
            pwConcurrency: this.pwConcurrency, rtProxy: this.rtProxy || "", rtConcurrency: this.rtConcurrency, defaultPassword: String(appConfig.defaultPassword || "").trim(),
            proxyPool: this.proxyPool || [], proxyPoolLines: (this.proxyPool || []).map(toProxyImportLine), proxyPoolSnap: this.proxyPoolSnap(), proxyPoolMailEnabled: this.proxyPoolMailEnabled !== false, proxyPoolGptEnabled: this.proxyPoolGptEnabled !== false,
            proxyJumpPool: this.proxyJumpPool || [], proxyJumpMailEnabled: this.proxyJumpMailEnabled !== false, proxyJumpGptEnabled: this.proxyJumpGptEnabled !== false,
            mailProxyPool: this.mailProxyPool || [], mailProxyPoolLines: (this.mailProxyPool || []).map(toProxyImportLine), mailProxyPoolSnap: this.mailProxyPoolSnap(),
            mailProxyJump: this.mailProxyJump || "",
            mailJumpPool: this.mailJumpPool || [], mailJumpPoolSnap: this.jumpPoolSnapshot(), jumpPoolSnap: this.jumpPoolSnapshot(),
            gptProxyPool: this.gptProxyPool || [], gptProxyPoolLines: (this.gptProxyPool || []).map(toProxyImportLine), gptProxyPoolSnap: this.gptProxyPoolSnap(),
            gptProxyJump: this.gptProxyJump || "",
            gptJumpPool: this.gptJumpPool || [], gptJumpPoolSnap: this.jumpPoolSnapshot(),
            jumpFleet: this.jumpFleet || [],
            // 只回纯字段，避免 state 里混进不可 JSON 化的内容导致 res.json 500
            jumpXrays: (listJumpXrays() || []).map((r) => ({
                name: r?.name || "",
                running: !!r?.running,
                port: Number(r?.port) || 0,
                node: r?.node || "",
                vless: r?.vless || "",
                pid: Number(r?.pid) || 0,
                error: r?.error || "",
            })),
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
                // 必须 await + catch：否则 spawn 抛错变成 unhandledRejection，进程可能被干掉，前端就看到 500
                try {
                    await this.spawnWorker(acc);
                } catch (e) {
                    const msg = String(e?.message || e);
                    console.error("[tick] spawnWorker 异常", acc?.id, acc?.email, msg);
                    try { await db.releaseGptIfRunning(acc.id); } catch { /* */ }
                    try { await db.releaseClaudeIfRunning(acc.id); } catch { /* */ }
                    this.running.delete(`gpt:${acc.id}`);
                    this.running.delete(`claude:${acc.id}`);
                    this.running.delete(`${acc.domain || "gpt"}:${acc.id}`);
                    try { this.log(acc.id, `spawn 异常已回收: ${msg.slice(0, 160)}`); } catch { /* */ }
                }
            }
            try { this.emit("stats", await db.stats()); } catch (e) {
                console.warn("[tick] stats:", e?.message || e);
            }
        } catch (e) {
            console.error("[tick]", e?.message || e);
        } finally {
            this.ticking = false;
        }
    }

    spawnWorker(acc) { return this.workerRunner.spawnWorker(acc); }
    handleLine(info, line) { return this.workerRunner.handleLine(info, line); }
    logJob(info, line) { return this.workerRunner.logJob(info, line); }
    log(id, line) { return this.workerRunner.log(id, line); }
    onExit(runId, code) { return this.workerRunner.onExit(runId, code); }
}

export const scheduler = new Scheduler();
