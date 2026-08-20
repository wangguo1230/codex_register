// @ts-nocheck
// 注册 Worker 运行器：子进程、输出帧、代理租约和临时文件生命周期。
import {spawn} from "node:child_process";
import {existsSync, mkdtempSync, rmSync, writeFileSync} from "node:fs";
import os from "node:os";
import path from "node:path";
import * as db from "../db.js";
import {appConfig} from "../../src/config.js";
import {randomPassword} from "../../src/utils.js";
import {gptJumpPool, gptProxyPool, JUMP_MAX_EXITS} from "../../src/mail/proxy-pool.js";
import {pickXrayBrowserProxy} from "../xray-proxy.js";
import {cleanSpawnEnv} from "../strip-env-proxy.js";
import {attachBoundedStdio} from "../bounded-stdio.js";
import {resolveEngine} from "./register-engine.js";

const EVENT_PREFIX = "@@EVENT@@";

export function createRegistrationWorkerRunner({scheduler, rootDir} = {}) {
    const isWindows = process.platform === "win32";
    const localTsx = path.resolve(rootDir, "node_modules", ".bin", `tsx${isWindows ? ".cmd" : ""}`);
    const tsxBin = existsSync(localTsx) ? localTsx : "tsx";
    const tmpDir = mkdtempSync(path.join(os.tmpdir(), "codex-reg-"));

    // running Map 键=复合 runId(`${domain}:${id}`),避免 gpt/claude 各自自增 id 重叠碰撞。
    async function spawnWorker(acc) {
        const domain = acc.domain || "gpt";
        const runId = `${domain}:${acc.id}`;
        let info = null;
        try {
            if (domain === "gpt") {
                const cur = String(acc.gpt_password || "").trim();
                const started = !!(acc.auth_file || acc.token || acc.started_at);
                const defaultPw = String(appConfig.defaultPassword || "").trim();
                // 未真正开过号：空密码或库里仍是统一默认密码 → 每人随机一串
                if (!started && (!cur || (defaultPw && cur === defaultPw))) {
                    const pw = randomPassword(16);
                    await db.updateAccount(acc.id, {gpt_password: pw});
                    acc.gpt_password = pw;
                    scheduler.log(acc.id, "GPT 密码已按号随机生成");
                } else if (!cur) {
                    const pw = randomPassword(16);
                    await db.updateAccount(acc.id, {gpt_password: pw});
                    acc.gpt_password = pw;
                }
            }
            const tmpFile = path.join(tmpDir, `mc-${domain}-${acc.id}.txt`);
            writeFileSync(tmpFile, [acc.email, acc.password, acc.mailbox_totp || "", acc.recovery_email || "", acc.mailbox_imap || ""].join("----") + "\n", "utf8");
            info = {child: null, tmpFile, gotResult: false, engine: null, domain, id: acc.id, mailboxId: acc.mailbox_id, releasing: false, wantGptPool: domain === "gpt", mailLease: null, jumpLease: null, cancelTermination: null};
            scheduler.running.set(runId, info);
    
            // 注册知识收敛在引擎:调度器只管进程/并发/事件(通用)。按账号所属域选引擎。
            const engine = resolveEngine(domain);
            let script, env;
            try {
                ({script, env} = engine.buildSpawn(acc, scheduler, tmpFile));
            } catch (e) {
                scheduler.running.delete(runId);
                const err = String(e?.message || e);
                scheduler.log(acc.id, `❌ 无法启动注册: ${err}`);
                if (domain === "gpt") {
                    await db.markFailed(acc.id, err);
                    scheduler.emit("status", {id: acc.id, status: "failed"});
                    try { scheduler.emit("stats", await db.stats()); } catch { /* */ }
                }
                try { rmSync(tmpFile, {force: true}); } catch { /* */ }
                return;
            }
            const isBrowserWorker = /worker-register-browser|register-browser|worker-register-claude/i.test(String(script || ""));
            if (isBrowserWorker) {
                const xray = await pickXrayBrowserProxy(scheduler.regProxy, scheduler.rtProxy, "socks5://127.0.0.1:10811", "socks5://127.0.0.1:10808");
                if (!xray) {
                    scheduler.running.delete(runId);
                    const err = "浏览器必须走 xray，本机没有可用的 xray socks（10811/10808）";
                    scheduler.log(acc.id, `❌ 无法启动注册: ${err}`);
                    if (domain === "gpt") {
                        await db.markFailed(acc.id, err);
                        scheduler.emit("status", {id: acc.id, status: "failed"});
                        try { scheduler.emit("stats", await db.stats()); } catch { /* */ }
                    }
                    try { rmSync(tmpFile, {force: true}); } catch { /* */ }
                    return;
                }
                env.PROXY_URL = xray;
                env.MAIL_PROXY_JUMP = "";
                logJob(info, `浏览器走 xray ${xray}（不用 JS 转发 kookeey）`);
            } else if (info.wantGptPool) {
                try {
                    const wantJump = scheduler.hasGptJumpConfig();
                    if (wantJump && gptJumpPool.urls.length) {
                        try {
                            info.jumpLease = await gptJumpPool.lease(acc.email, {timeoutMs: 20_000, maxPerJump: JUMP_MAX_EXITS});
                        } catch (e) {
                            logJob(info, `跳板租不到（${String(e?.message || e).slice(0, 80)}），直连 GPT 代理池`);
                            info.jumpLease = null;
                        }
                    }
                    info.mailLease = await gptProxyPool.lease(acc.email, {
                        fallback: "",
                        timeoutMs: 20_000,
                        maxPerTemplate: 1,
                        freshSession: true,
                    });
                    const jump = wantJump ? (info.jumpLease?.url || scheduler.gptProxyJump || "") : "";
                    env.PROXY_URL = info.mailLease.url || "";
                    env.MAIL_PROXY_JUMP = jump;
                    logJob(info, `GPT 代理池租到 ${String(info.mailLease.url || "直连").replace(/:[^:@/]+@/, ":***@")}（${jump ? "跳板 " + jump : "无跳板，直连代理池"}）`);
                } catch (e) {
                    try { info.jumpLease?.release(); } catch { /* */ }
                    scheduler.running.delete(runId);
                    await db.releaseGptIfRunning(acc.id);
                    scheduler.log(acc.id, `GPT 代理池租不到: ${e?.message || e}，退回排队`);
                    try { rmSync(tmpFile, {force: true}); } catch { /* */ }
                    return;
                }
            }
            const child = spawn(tsxBin, [script], {cwd: rootDir, env: cleanSpawnEnv(env), shell: isWindows});
            info.child = child;
            info.engine = engine;
            if (domain === "claude") scheduler.emit("claude", {stats: await db.claudeStats()});
            else {
                scheduler.emit("status", {id: acc.id, status: "running"});
                try { scheduler.emit("stats", await db.stats()); } catch { /* */ }
            }
            logJob(info, `▶ 启动注册 worker (pid=${child.pid})`);
    
            let outputChain = Promise.resolve();
            const enqueueOutput = (task) => {
                outputChain = outputChain
                    .then(task)
                    .catch((error) => logJob(info, `[handleLine] ${String(error?.message || error).slice(0, 120)}`));
            };
            const output = attachBoundedStdio(child, {
                lineLimit: 512 * 1024,
                stderrLineLimit: 160,
                stderrPrefix: "[stderr] ",
                onLine: (line) => enqueueOutput(() => handleLine(info, line)),
                onEvent: (event) => enqueueOutput(() => handleEvent(info, event)),
            });
            child.on("error", (err) => logJob(info, `[spawn error] ${err?.message ?? err}`));
            child.on("close", (code) => {
                output.flush?.();
                void outputChain.then(() => onExit(runId, code));
            });
        } catch (e) {
            // 兜底：任何未预期错误都回收 running，避免卡槽 + unhandledRejection 打崩进程
            try { info?.mailLease?.release(); } catch { /* */ }
            try { info?.jumpLease?.release(); } catch { /* */ }
            scheduler.running.delete(runId);
            try { await db.releaseGptIfRunning(acc.id); } catch { /* */ }
            try { if (info?.tmpFile) rmSync(info.tmpFile, {force: true}); } catch { /* */ }
            throw e;
        }
    }
    
    // job runner 只做:分帧解析 worker 输出 → result 事件转发给该 job 的引擎解释,普通行落日志。
    async function handleLine(info, line) {
        if (!line.trim()) return;
        if (line.startsWith(EVENT_PREFIX)) {
            let ev;
            try { ev = JSON.parse(line.slice(EVENT_PREFIX.length)); } catch { return; }
            await handleEvent(info, ev);
        } else {
            logJob(info, line);
        }
    }

    async function handleEvent(info, event) {
        if (event?.type === "result") {
            info.gotResult = true;
            await info.engine.onResult(scheduler, info.id, event);
        } else if (event?.type === "mailbox_update") {
            await db.applyMailboxUpdate(event.email || "", {
                password: event.password,
                totp_secret: event.totp_secret,
                imap_password: event.imap_password,
                recovery_email: event.recovery_email,
            }).catch(() => {});
            if (event.message) logJob(info, event.message);
            else logJob(info, `邮箱凭证已更新${event.imap_password ? "(应用专用密码)" : ""}`);
        } else if (event?.message) {
            logJob(info, event.message);
        }
    }
    
    // 帧日志(内部)按域路由:claude→独立 claude_logs(键 claude_account id);gpt→logs 表。三域日志各自独立。fire-and-forget 写库,不阻塞事件流。
    function logJob(info, line) {
        if (info.domain === "claude") { db.appendClaudeLog(info.id, line).catch(() => {}); scheduler.emit("claudeLog", {id: info.id, line, ts: Date.now()}); }
        else { db.appendLog(info.id, line).catch(() => {}); scheduler.emit("log", {id: info.id, line, ts: Date.now()}); }
    }
    
    // 引擎用的公共日志(GPT onResult 调 runner.log(id,...))→ logs 表。claude onResult 不用(见 register-engine)。fire-and-forget。
    function log(id, line) {
        db.appendLog(id, line).catch(() => {});
        scheduler.emit("log", {id, line, ts: Date.now()});
    }
    
    async function onExit(runId, code) {
        const info = scheduler.running.get(runId);
        scheduler.running.delete(runId);
        if (info) {
            try { info.cancelTermination?.(); } catch { /* */ }
            try { info.mailLease?.release(); } catch { /* */ }
            try { info.jumpLease?.release(); } catch { /* */ }
            try { rmSync(info.tmpFile, {force: true}); } catch { /* ignore */ }
            // 没收到结果事件就退出 = 异常,交由引擎按域解释
            if (!info.gotResult && info.engine) await info.engine.onAbnormalExit(scheduler, info.id, code, info);
        }
        scheduler.emit("stats", await db.stats());
        scheduler.tick(); // 释放槽位，继续下一个
    }

    function dispose() {
        try { rmSync(tmpDir, {recursive: true, force: true}); } catch { /* */ }
    }

    return {spawnWorker, handleLine, logJob, log, onExit, dispose};
}
