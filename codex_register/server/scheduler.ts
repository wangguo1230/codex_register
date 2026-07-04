// @ts-nocheck
// 并发调度器：worker 子进程池，支持并发数配置 / 暂停 / 恢复 / 重跑
import {EventEmitter} from "node:events";
import {spawn} from "node:child_process";
import {writeFileSync, rmSync, mkdtempSync, readFileSync, existsSync} from "node:fs";
import os from "node:os";
import path from "node:path";
import {fileURLToPath} from "node:url";
import * as db from "./db.js";
import {appConfig} from "../src/config.js";
import {resolveEngine} from "./domain/register-engine.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CODEX_ROOT = path.resolve(__dirname, "..");
const TSX_BIN = path.resolve(CODEX_ROOT, "node_modules", ".bin", "tsx");
const EVENT_PREFIX = "@@EVENT@@";
const DAILY_FILE = path.resolve(CODEX_ROOT, "data", "daily.json"); // 定时任务配置+统计持久化
const SETTINGS_FILE = path.resolve(CODEX_ROOT, "data", "settings.json"); // 运行时配置持久化(前端改的开关/代理/上限等)
// 持久化的运行时配置字段(其余如 paused/running 是运行态不存)
const SETTINGS_KEYS = ["concurrency", "otpSingle", "simulateChat", "regProxy", "mailProxy", "smsEnabled", "smsLinkTemplate", "rtEnabled", "smsMaxBind", "xrayVless", "regEngine", "autoChangePasswd", "bitBrowser"];

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
        this.smsEnabled = true;        // 注册若要求手机验证(add-phone)时启用接码池，不要求则不影响
        this.smsLinkTemplate = appConfig.smsLinkTemplate; // 接码收码链接模板(key/project 通用，phone 动态替换)
        this.rtEnabled = false;        // 注册成功后是否额外走 codex OAuth 拿可续期 rt(强制 add-phone，接码有成本，默认关)
        this.smsMaxBind = 3;           // 每个接码号最多绑定几个账号(0=不限，直到被 OpenAI 拒)
        this.xrayVless = "";           // 独立注册代理的 vless 链接(启用则 index 起独立 xray 并把 regProxy 指向它)
        this.regEngine = "http";       // 注册引擎:http(sentinel HTTP 模拟) / browser(真 Chrome 过 CF)
        this.autoChangePasswd = false; // 注册成功后自动改 mail.com 密码(随机20位)并同步库
        this.bitBrowser = false;       // 浏览器引擎用比特浏览器:每号独立指纹窗口(需本地比特客户端开着 Local API)
        this.paused = true;            // 默认暂停，前端点"开始"才跑
        this.running = new Map();      // accountId -> { child, tmpFile, gotResult }
        this.tmpDir = mkdtempSync(path.join(os.tmpdir(), "codex-reg-"));
        this.daily = this.loadDaily(); // 定时任务配置+统计(持久化)
        this.loadSettings();           // 覆盖上面默认值为上次持久化的运行时配置
    }

    // ---- 运行时配置持久化(data/settings.json) ----
    loadSettings() {
        try {
            if (existsSync(SETTINGS_FILE)) {
                const s = JSON.parse(readFileSync(SETTINGS_FILE, "utf8"));
                for (const k of SETTINGS_KEYS) if (s[k] !== undefined) this[k] = s[k];
            }
        } catch { /* 损坏则保留默认 */ }
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

    start() {
        this.paused = false;
        this.tick();
    }

    pause() {
        // 软暂停：不再认领新任务，运行中的让它跑完
        this.paused = true;
    }

    stopAll() {
        this.paused = true;
        for (const [id, info] of this.running) {
            try { info.child.kill("SIGTERM"); } catch { /* ignore */ }
        }
    }

    retry(id) {
        if (this.running.has(id)) return false;
        db.resetToPending(id);
        this.emit("status", {id, status: "pending"});
        this.emit("stats", db.stats());
        this.tick();
        return true;
    }

    retryAllFailed() {
        db.resetAllFailed();
        this.emit("stats", db.stats());
        this.broadcastSnapshot();
        this.tick();
    }

    broadcastSnapshot() {
        this.emit("snapshot", db.listAccounts());
    }

    state() {
        return {paused: this.paused, concurrency: this.concurrency, otpSingle: this.otpSingle, simulateChat: this.simulateChat, smsEnabled: this.smsEnabled, smsLinkTemplate: this.smsLinkTemplate, rtEnabled: this.rtEnabled, smsMaxBind: this.smsMaxBind, regEngine: this.regEngine, autoChangePasswd: this.autoChangePasswd, bitBrowser: this.bitBrowser, daily: this.daily, regProxy: this.regProxy, mailProxy: this.mailProxy, running: [...this.running.keys()]};
    }

    tick() {
        if (this.paused) return;
        // 浏览器引擎跑真 Chrome(headed，重)，硬上限 4，避免开一堆窗口卡机；用户并发设更小则用更小
        const effective = this.regEngine === "browser" ? Math.min(this.concurrency, 4) : this.concurrency;
        while (this.running.size < effective) {
            const acc = db.claimNext();
            if (!acc) break;
            this.spawnWorker(acc);
        }
        this.emit("stats", db.stats());
    }

    spawnWorker(acc) {
        const tmpFile = path.join(this.tmpDir, `mc-${acc.id}.txt`);
        writeFileSync(tmpFile, `${acc.email}----${acc.password}\n`, "utf8");

        // 注册知识收敛在引擎:调度器只管进程/并发/事件(通用)。按账号所属域选引擎(当前 claimNext 只出 gpt)。
        const engine = resolveEngine(acc.domain || "gpt");
        const {script, env} = engine.buildSpawn(acc, this, tmpFile);
        const child = spawn(TSX_BIN, [script], {
            cwd: CODEX_ROOT,
            env: {...process.env, ...env},
        });
        const info = {child, tmpFile, gotResult: false, engine};
        this.running.set(acc.id, info);
        this.emit("status", {id: acc.id, status: "running"});
        this.emit("stats", db.stats());
        this.log(acc.id, `▶ 启动注册 worker (pid=${child.pid})`);

        let buf = "";
        const onData = (chunk) => {
            buf += chunk.toString();
            let idx;
            while ((idx = buf.indexOf("\n")) >= 0) {
                const line = buf.slice(0, idx);
                buf = buf.slice(idx + 1);
                this.handleLine(acc.id, line);
            }
        };
        child.stdout.on("data", onData);
        child.stderr.on("data", (d) => {
            const t = d.toString().trim();
            if (t) this.log(acc.id, `[stderr] ${t}`);
        });
        child.on("error", (err) => this.log(acc.id, `[spawn error] ${err?.message ?? err}`));
        child.on("exit", (code) => this.onExit(acc.id, code));
    }

    // job runner 只做:分帧解析 worker 输出 → result 事件转发给该 job 的引擎解释,普通行落日志。
    // 业务如何"读懂"结果(写库/标记状态/注册后改密)全在引擎(onResult),调度器不含任何业务知识。
    handleLine(id, line) {
        if (!line.trim()) return;
        if (line.startsWith(EVENT_PREFIX)) {
            let ev;
            try { ev = JSON.parse(line.slice(EVENT_PREFIX.length)); } catch { return; }
            if (ev.type === "result") {
                const info = this.running.get(id);
                if (info) info.gotResult = true;
                const engine = info?.engine || resolveEngine("gpt");
                engine.onResult(this, id, ev);
            } else if (ev.message) {
                this.log(id, ev.message);
            }
        } else {
            this.log(id, line);
        }
    }

    log(id, line) {
        db.appendLog(id, line);
        this.emit("log", {id, line, ts: Date.now()});
    }

    onExit(id, code) {
        const info = this.running.get(id);
        this.running.delete(id);
        if (info) {
            try { rmSync(info.tmpFile, {force: true}); } catch { /* ignore */ }
            // 没收到结果事件就退出 = 异常,交由引擎按域解释(GPT 判失败)
            if (!info.gotResult) (info.engine || resolveEngine("gpt")).onAbnormalExit(this, id, code);
        }
        this.emit("stats", db.stats());
        this.tick(); // 释放槽位，继续下一个
    }
}

export const scheduler = new Scheduler();
