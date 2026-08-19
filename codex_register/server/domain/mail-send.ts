// @ts-nocheck
// mail.com 发信：用邮箱管理已记住的粘性出口。
// 同一条代理连试多次；连续不可用才换 session 并写回 mailboxes.proxy_url。
// Playwright 必须丢到子进程：跟 :3100 同进程会把事件循环卡死，前端表现为 500。
import {spawn} from "node:child_process";
import {existsSync, unlinkSync, writeFileSync} from "node:fs";
import os from "node:os";
import path from "node:path";
import {fileURLToPath} from "node:url";
import * as db from "../db.js";
import {scheduler} from "../scheduler.js";
import {cleanSpawnEnv} from "../strip-env-proxy.js";
import {ensureMailcomProfile} from "../../src/mail/mailcom-fingerprint.js";
import {
    mailProxyPool,
    mailJumpPool,
    kookeeySessionOf,
    maskProxyUrl,
    pickLiveMailProxy,
    isProxySessionDead,
    mintStickySession,
    JUMP_MAX_EXITS,
} from "../../src/mail/proxy-pool.js";

const SAME_PROXY_TRIES = Math.max(2, Number(process.env.MAILCOM_SEND_PROXY_TRIES || 3));
const FAIL_BEFORE_ROTATE = Math.max(2, Number(process.env.MAILCOM_SEND_PROXY_FAILS || 3));
const PROBE_BUDGET_MS = Math.max(3000, Number(process.env.MAILCOM_SEND_PROBE_MS || 8000));
const SEND_WORKER_MS = Math.max(60_000, Number(process.env.MAILCOM_SEND_TIMEOUT_MS || 180_000));
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const TSX_BIN = existsSync(path.join(ROOT, "node_modules", ".bin", "tsx"))
    ? path.join(ROOT, "node_modules", ".bin", "tsx")
    : "tsx";

let sendChild = null;

function runSendWorker(job, log) {
    const jobFile = path.join(os.tmpdir(), `mail-send-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`);
    writeFileSync(jobFile, JSON.stringify(job));
    return new Promise((resolve, reject) => {
        const child = spawn(TSX_BIN, ["scripts/worker-mail-send.ts", jobFile], {
            cwd: ROOT,
            env: cleanSpawnEnv({MAILCOM_HEADLESS: job.headless === false ? "0" : "1"}),
            stdio: ["ignore", "pipe", "pipe"],
            detached: process.platform !== "win32",
        });
        sendChild = child;
        const killChild = () => {
            try {
                if (process.platform !== "win32" && child.pid) process.kill(-child.pid, "SIGKILL");
                else child.kill("SIGKILL");
            } catch {
                try { child.kill("SIGKILL"); } catch { /* */ }
            }
        };
        let out = "";
        const pump = (buf) => {
            const s = String(buf || "");
            out += s;
            if (out.length > 512 * 1024) out = out.slice(-256 * 1024);
            for (const line of s.split(/\r?\n/)) {
                const t = line.trim();
                if (!t || t.startsWith("@@RESULT@@")) continue;
                log(t.slice(0, 220));
            }
        };
        child.stdout?.on("data", pump);
        child.stderr?.on("data", pump);
        const timer = setTimeout(() => {
            killChild();
            reject(new Error(`发信超时 ${Math.round(SEND_WORKER_MS / 1000)}s`));
        }, SEND_WORKER_MS);
        const done = (fn, val) => {
            clearTimeout(timer);
            if (sendChild === child) sendChild = null;
            try { unlinkSync(jobFile); } catch { /* */ }
            fn(val);
        };
        child.on("error", (e) => done(reject, e));
        child.on("close", (code) => {
            const hit = out.split(/\r?\n/).reverse().find((l) => l.startsWith("@@RESULT@@"));
            if (hit) {
                try {
                    const r = JSON.parse(hit.slice("@@RESULT@@".length));
                    if (r?.ok) { done(resolve, r); return; }
                    done(reject, new Error(r?.error || "发信失败"));
                    return;
                } catch { /* */ }
            }
            done(reject, new Error((out || `worker exit ${code}`).replace(/\s+/g, " ").slice(-240)));
        });
    });
}

function withTimeout(promise, ms, label = "超时") {
    let timer;
    return Promise.race([
        Promise.resolve(promise).finally(() => { try { clearTimeout(timer); } catch { /* */ } }),
        new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error(label)), Math.max(500, Number(ms) || 0));
        }),
    ]);
}

function publicProxy(row) {
    const url = String(row?.proxy_url || "");
    return {
        ...row,
        proxy_url: url ? maskProxyUrl(url) : "",
        jump_url: row?.jump_url ? maskProxyUrl(row.jump_url) : "",
    };
}

function isRetryableSend(err) {
    if (isProxySessionDead(err)) return true;
    return /timeout|超时|ETIMEDOUT|ECONNRESET|ECONNREFUSED|HTTP 5\d\d|HTTP 429|net::|ERR_TUNNEL|ERR_PROXY|socket hang up/i.test(String((err as Error)?.message || err || ""));
}

async function writeSendLog(fields) {
    try { return await db.insertMailSendLog(fields); } catch (e) {
        console.warn("[mail-send] 写日志失败", String((e as Error)?.message || e).slice(0, 120));
        return 0;
    }
}

async function withJump(owner, fn) {
    const who = String(owner || "mail-send");
    let jumpLease = null;
    if (mailJumpPool.urls.length) {
        jumpLease = await mailJumpPool.lease(who, {timeoutMs: 45_000, maxPerJump: JUMP_MAX_EXITS});
    }
    const jumpUrl = jumpLease?.url || scheduler.mailProxyJump || "";
    try {
        return await fn(jumpUrl);
    } finally {
        try { jumpLease?.release(); } catch { /* */ }
    }
}

async function leaseNewSticky(owner, preferUrl = "") {
    const lease = await mailProxyPool.lease(owner, {
        fallback: scheduler.mailProxyFallback(),
        maxPerTemplate: Math.max(1, Math.min(8, scheduler.pwConcurrency || 1)),
        freshSession: !preferUrl,
        preferUrl,
        timeoutMs: 45_000,
    });
    try {
        const url = String(lease.url || "").trim();
        if (!url) throw new Error("发信必须走邮箱代理池，禁止直连");
        return url;
    } finally {
        try { lease.release(); } catch { /* */ }
    }
}

function nextSticky(oldUrl) {
    const cur = String(oldUrl || "").trim();
    if (!cur) return "";
    if (kookeeySessionOf(cur)) return mintStickySession(cur);
    return "";
}

async function rememberOnMailbox(mb, url, ip = "", fail = 0) {
    if (!mb) return;
    mb.proxy_url = url;
    if (ip) mb.proxy_ip = ip;
    mb.proxy_fail = fail;
    if (mb.id) await db.setMailboxProxy(mb.id, url, ip || mb.proxy_ip || "", fail);
}

/**
 * 用邮箱已记住的粘性出口发一封。没有才从池子领一条并立刻写到邮箱上。
 * 同一条连试 SAME_PROXY_TRIES 次；累计 FAIL_BEFORE_ROTATE 次不可用才换并更新邮箱。
 */
export async function sendMailcomViaPool(opts: any = {}) {
    const to = opts.to;
    const subject = opts.subject;
    const html = opts.html;
    const text = opts.text;
    const fromName = opts.fromName;
    const headless = opts.headless;
    const log = typeof opts.log === "function" ? opts.log : (m) => console.log(m);

    let mb = opts.mailbox || null;
    if (!mb && opts.mailboxId) mb = await db.getMailbox(opts.mailboxId);
    if (!mb && opts.email) mb = await db.getMailboxByEmailAny(opts.email);
    const email = String(mb?.email || opts.email || "").trim().toLowerCase();
    const password = String(opts.password || mb?.password || "").trim();
    if (!email || !password) throw new Error("发信缺少邮箱或密码");
    if (!mb) mb = {email, password, proxy_url: "", proxy_ip: "", proxy_fail: 0};

    return withJump(`send:${email}`, async (jumpUrl) => {
        let exitUrl = String(mb.proxy_url || "").trim();
        let firstBind = false;
        if (!exitUrl) {
            exitUrl = await leaseNewSticky(`send-bind:${email}`);
            firstBind = true;
            await rememberOnMailbox(mb, exitUrl, "", 0);
            log(`发信首次绑定出口 ${maskProxyUrl(exitUrl)} session=${kookeeySessionOf(exitUrl) || "-"}（写入邮箱管理）`);
        }

        const runSend = async (exit, reused, attemptTag) => {
            const profile = ensureMailcomProfile(mb.browser_fp, exit);
            if (mb.id && JSON.stringify(mb.browser_fp || {}) !== JSON.stringify(profile)) {
                await db.setMailboxBrowserFp(mb.id, profile).catch(() => {});
                mb.browser_fp = profile;
            }
            const sess = kookeeySessionOf(exit) || "";
            let ip = String(mb.proxy_ip || "").trim();
            const baseLog = () => ({
                mailbox_id: mb.id || 0,
                email,
                to_email: Array.isArray(to) ? to.join(",") : String(to || ""),
                subject: String(subject || ""),
                proxy_url: exit,
                proxy_session: sess,
                proxy_ip: ip,
                jump_url: jumpUrl,
                reused: reused ? 1 : 0,
                created_at: Date.now(),
            });
            let lastErr;
            for (let i = 1; i <= SAME_PROXY_TRIES; i++) {
                log(`发信${attemptTag} ${maskProxyUrl(exit)}${sess ? ` session=${sess}` : ""}${ip ? ` ip=${ip}` : ""} tz=${profile.timezoneId} ${profile.viewportWidth}x${profile.viewportHeight}（${reused ? "邮箱已记出口" : "新出口"} · 第 ${i}/${SAME_PROXY_TRIES} 次）${jumpUrl ? ` · 跳板 ${maskProxyUrl(jumpUrl)}` : " · 无跳板"}`);
                if (i === 1 || !ip) {
                    try {
                        const live = await withTimeout(
                            pickLiveMailProxy(exit, {tries: 1, rotate: false, jump: jumpUrl, log: (m) => log(`发信探测 ${m}`)}),
                            PROBE_BUDGET_MS,
                            `探测超时 ${PROBE_BUDGET_MS}ms`,
                        );
                        if (live?.probe?.ip && live.probe.ip !== "?") ip = live.probe.ip;
                        if (live && !live.ok) log(`发信探测未过: ${live.probe?.reason || "未知"}，仍用原 session 发`);
                    } catch (e) {
                        log(`发信探测跳过（${String((e as Error)?.message || e).slice(0, 80)}），直接登录发`);
                    }
                }
                try {
                    const r = await runSendWorker({
                        email, password, to, subject, html, text, fromName,
                        headless: headless ?? true, proxy: exit, jump: jumpUrl, profile,
                    }, log);
                    if (mb.id) {
                        await db.resetMailboxProxyFail(mb.id).catch(() => {});
                        if (ip && ip !== mb.proxy_ip) await db.setMailboxProxy(mb.id, exit, ip);
                    }
                    mb.proxy_fail = 0;
                    if (ip) mb.proxy_ip = ip;
                    await writeSendLog({
                        ...baseLog(),
                        proxy_ip: ip,
                        status: "sent",
                        http_status: r.status || 0,
                        location: r.location || "",
                    });
                    if (mb.id) {
                        db.appendMailboxLog(mb.id, `[发信] 成功 → ${baseLog().to_email} session=${sess || "-"} ip=${ip || "-"}`).catch(() => {});
                    }
                    return {
                        ok: true,
                        ...r,
                        proxySession: sess,
                        proxyIp: ip,
                        proxyMasked: maskProxyUrl(exit),
                        jumpMasked: jumpUrl ? maskProxyUrl(jumpUrl) : "",
                        reused,
                        tries: i,
                    };
                } catch (e) {
                    lastErr = e;
                    const err = String((e as Error)?.message || e).slice(0, 300);
                    await writeSendLog({...baseLog(), proxy_ip: ip, status: "fail", error: err});
                    if (mb.id) {
                        db.appendMailboxLog(mb.id, `[发信] 第 ${i}/${SAME_PROXY_TRIES} 次失败 ${err.slice(0, 140)} session=${sess || "-"}`).catch(() => {});
                    }
                    // 子进程整段超时已经等够了，不要同一条出口再空等 3×180s
                    if (/发信超时/.test(err) || !isRetryableSend(e) || i >= SAME_PROXY_TRIES) break;
                    log(`同一粘性出口再试（${i}/${SAME_PROXY_TRIES} 已失败）`);
                }
            }
            throw lastErr || new Error("发信失败");
        };

        try {
            return await runSend(exitUrl, !firstBind, firstBind ? "绑定后" : "");
        } catch (e) {
            if (!isProxySessionDead(e) && !isRetryableSend(e)) throw e;
            let fails = Number(mb.proxy_fail || 0) + 1;
            if (mb.id) {
                try { fails = await db.bumpMailboxProxyFail(mb.id); } catch { /* */ }
            }
            mb.proxy_fail = fails;
            const sess = kookeeySessionOf(exitUrl) || "-";
            const forceRotate = /发信超时/.test(String((e as Error)?.message || e || ""));
            if (!forceRotate && fails < FAIL_BEFORE_ROTATE) {
                const msg = `粘性代理暂不可用（${fails}/${FAIL_BEFORE_ROTATE}），仍保留邮箱 session=${sess}`;
                log(msg);
                throw new Error(`${msg}: ${String((e as Error)?.message || e).slice(0, 160)}`);
            }
            let next = nextSticky(exitUrl);
            if (!next || next === exitUrl) {
                next = await leaseNewSticky(`send-rotate:${email}`);
            }
            await rememberOnMailbox(mb, next, "", 0);
            log(`出口连续 ${fails} 次不可用，更新邮箱粘性 ${maskProxyUrl(exitUrl)} → ${maskProxyUrl(next)} session=${kookeeySessionOf(next) || "-"}`);
            if (mb.id) {
                db.appendMailboxLog(mb.id, `[发信] 出口已更新 session=${sess} → ${kookeeySessionOf(next) || "-"}`).catch(() => {});
            }
            return runSend(next, false, "换出口后");
        }
    });
}

export async function sendMailcomBatch(items, {concurrency, log, shouldStop} = {} as any) {
    const list = Array.isArray(items) ? items : [];
    const cap = Math.max(1, Math.min(8, Number(concurrency || scheduler.pwConcurrency || 1)));
    const out = [];
    let i = 0;
    const workers = Array.from({length: Math.min(cap, list.length || 1)}, async () => {
        while (i < list.length) {
            const idx = i++;
            const item = list[idx];
            if (typeof shouldStop === "function" && shouldStop()) {
                out[idx] = {ok: false, email: item?.email, error: "已停止"};
                continue;
            }
            try {
                out[idx] = await sendMailcomViaPool({...item, log});
            } catch (e) {
                out[idx] = {ok: false, email: item?.email, error: String((e as Error)?.message || e).slice(0, 240)};
            }
        }
    });
    await Promise.all(workers);
    return {
        ok: out.every((x) => x?.ok),
        total: list.length,
        sent: out.filter((x) => x?.ok).length,
        failed: out.filter((x) => !x?.ok).length,
        items: out,
    };
}

export async function listMailSendLogsPublic(opts = {}) {
    const rows = await db.listMailSendLogs(opts);
    return rows.map(publicProxy);
}

function isMailcomAddr(email) {
    return /@mail\.com$/i.test(String(email || ""));
}

function isGmailAddr(email) {
    return /@(gmail|googlemail)\.com$/i.test(String(email || ""));
}

function looksRebound(q) {
    const cur = String(q?.email || "").trim().toLowerCase();
    const from = String(q?.rebind_from || "").trim().toLowerCase();
    const to = String(q?.rebind_email || "").trim().toLowerCase();
    if (from && from !== cur) return true;
    if (q?.rebind_status === "ok") return true;
    if (to && to === cur && from && from !== cur) return true;
    return false;
}

/** 换绑过必须用原始邮箱发；没换绑才用当前邮箱。 */
export function refundSenderOf(q) {
    const from = String(q?.rebind_from || "").trim().toLowerCase();
    if (from) return from;
    if (looksRebound(q)) return "";
    return String(q?.email || "").trim().toLowerCase();
}

export function buildTestMailContent({from, to, subject} = {}) {
    const stamp = new Date().toISOString().replace("T", " ").slice(0, 19);
    const sub = String(subject || `退款测试邮件 ${stamp.slice(11)}`);
    const text = `这是一封测试邮件，用来验证 mail.com 协议发信。\n发件：${from || ""}\n收件：${to || ""}\n时间：${stamp}\n\n正式退款正文稍后单独补充。`;
    const html = `<html><body style="font-family:sans-serif;font-size:14px;line-height:1.6">
<p>这是一封<strong>测试邮件</strong>，用来验证 mail.com 协议发信。</p>
<p>发件：${String(from || "").replace(/</g, "&lt;")}<br/>收件：${String(to || "").replace(/</g, "&lt;")}<br/>时间：${stamp}</p>
<p>正式退款正文稍后单独补充。</p>
</body></html>`;
    return {subject: sub, text, html};
}

export async function previewDeliveredSend(ids, testTo = "") {
    const to = String(testTo || "").trim();
    const items = [];
    for (const id of (ids || []).map(Number).filter(Number.isInteger)) {
        const q = await db.getRechargeQueueItem(id);
        if (!q) {
            items.push({id, ok: false, reason: "队列项不存在"});
            continue;
        }
        const from = refundSenderOf(q);
        const rebound = looksRebound(q);
        const mb = from ? await db.getMailboxByEmailAny(from) : null;
        const mailcom = isMailcomAddr(from);
        const gmail = isGmailAddr(from);
        let reason = "";
        if (rebound && !from) reason = "换绑过但没记下原始邮箱，不能用现在的 Gmail 发";
        else if (!from) reason = "没有发件邮箱";
        else if (rebound && !mailcom && !from) reason = "换绑必须用原始 mail.com 发";
        else if (mailcom && !mb?.password) reason = `邮箱库没有原邮箱 ${from} 的密码`;
        else if (!rebound && gmail && !String(mb?.imap_password || "").trim()) reason = `Gmail 没有 IMAP 应用密码，无法 SMTP 发信`;
        else if (!mailcom && !gmail) reason = `不支持的发件域名: ${from}`;
        const via = mailcom ? "mail.com" : gmail ? "gmail-smtp" : "";
        const mail = buildTestMailContent({from, to: to || "（测试收件人）"});
        items.push({
            id: q.id,
            queueEmail: q.email,
            from,
            rebindFrom: q.rebind_from || "",
            rebound,
            to: to || "",
            subject: mail.subject,
            text: mail.text,
            html: mail.html,
            canSend: !reason,
            reason,
            via,
            proxySession: mb?.proxy_url ? (mb.proxy_url.match(/-(\d+)(?:-\d+m)?$/i) || [])[1] || "" : "",
            group: q.batch || "",
        });
    }
    return {ok: true, to, items};
}

export async function testSendDelivered(ids, opts: any = {}) {
    const to = String(opts.to || "").trim();
    if (!to) throw new Error("请填写测试收件人");
    const preview = await previewDeliveredSend(ids, to);
    const sendable = preview.items.filter((x) => x.canSend);
    const skipped = preview.items.filter((x) => !x.canSend);
    const results = skipped.map((x) => ({id: x.id, email: x.queueEmail, from: x.from, ok: false, skipped: true, error: x.reason}));
    const log = typeof opts.log === "function" ? opts.log : (m) => console.log(m);
    const shouldStop = typeof opts.shouldStop === "function" ? opts.shouldStop : () => false;
    const mailcomItems = [];
    for (const row of sendable) {
        if (shouldStop()) {
            results.push({id: row.id, email: row.queueEmail, from: row.from, ok: false, skipped: true, error: "已停止"});
            continue;
        }
        const mb = await db.getMailboxByEmailAny(row.from);
        const mail = buildTestMailContent({from: row.from, to, subject: opts.subject});
        if (isGmailAddr(row.from)) {
            try {
                const {sendGmailSmtp} = await import("../../src/mail/google-smtp.js");
                log(`Gmail SMTP ${row.from} → ${to}`);
                const r = await sendGmailSmtp({
                    email: row.from,
                    appPassword: mb?.imap_password,
                    to,
                    fromName: String(row.from).split("@")[0],
                    subject: mail.subject,
                    text: opts.text || mail.text,
                    html: opts.html || mail.html,
                });
                results.push({id: row.id, email: row.queueEmail, from: row.from, ok: true, skipped: false, error: "", status: r.status, via: "gmail-smtp"});
            } catch (e) {
                results.push({id: row.id, email: row.queueEmail, from: row.from, ok: false, skipped: false, error: String((e as Error)?.message || e).slice(0, 240), via: "gmail-smtp"});
            }
            continue;
        }
        mailcomItems.push({
            email: row.from,
            password: mb?.password,
            mailbox: mb,
            to,
            fromName: String(row.from).split("@")[0],
            subject: mail.subject,
            text: opts.text || mail.text,
            html: opts.html || mail.html,
            _id: row.id,
            _queueEmail: row.queueEmail,
        });
    }
    if (mailcomItems.length) {
        const r = await sendMailcomBatch(mailcomItems, {concurrency: opts.concurrency || 1, log, shouldStop});
        for (let i = 0; i < (r.items || []).length; i++) {
            const one = r.items[i] || {};
            const src = mailcomItems[i];
            results.push({
                id: src._id,
                email: src._queueEmail,
                from: src.email,
                ok: !!one.ok,
                skipped: false,
                error: one.error || "",
                proxySession: one.proxySession || "",
                status: one.status || 0,
                via: "mail.com",
            });
        }
    }
    return {
        ok: results.some((x) => x.ok),
        to,
        sent: results.filter((x) => x.ok).length,
        failed: results.filter((x) => !x.ok && !x.skipped).length,
        skipped: results.filter((x) => x.skipped).length,
        items: results,
        preview: preview.items,
    };
}

const sendJob = {
    running: false,
    stop: false,
    to: "",
    queued: 0,
    sent: 0,
    failed: 0,
    skipped: 0,
    error: "",
    startedAt: 0,
    finishedAt: 0,
};

function publicSendJob() {
    return {
        running: !!sendJob.running,
        stop: !!sendJob.stop,
        to: sendJob.to,
        queued: sendJob.queued,
        sent: sendJob.sent,
        failed: sendJob.failed,
        skipped: sendJob.skipped,
        error: sendJob.error,
        startedAt: sendJob.startedAt,
        finishedAt: sendJob.finishedAt,
    };
}

export function getDeliveredSendJob() {
    return publicSendJob();
}

export function stopDeliveredSend() {
    const running = !!sendJob.running;
    sendJob.stop = true;
    if (sendChild) {
        try {
            if (process.platform !== "win32" && sendChild.pid) process.kill(-sendChild.pid, "SIGKILL");
            else sendChild.kill("SIGKILL");
        } catch {
            try { sendChild.kill("SIGKILL"); } catch { /* */ }
        }
    }
    return {ok: true, running, ...publicSendJob()};
}

/** 立刻返回，真正发信在后台跑。前端不能把 Playwright 登录堵在一次 HTTP 里，否则代理一卡就 500。 */
export async function startTestSendDelivered(ids, opts: any = {}) {
    if (sendJob.running) throw new Error("已有测试发信在跑，先停止或等它跑完");
    const to = String(opts.to || "").trim();
    if (!to) throw new Error("请填写测试收件人");
    const list = (ids || []).map(Number).filter(Number.isInteger);
    if (!list.length) throw new Error("未选择账号");
    const preview = await previewDeliveredSend(list, to);
    const sendable = preview.items.filter((x) => x.canSend);
    if (!sendable.length) throw new Error(preview.items[0]?.reason || "没有可发的号");

    sendJob.running = true;
    sendJob.stop = false;
    sendJob.to = to;
    sendJob.queued = sendable.length;
    sendJob.sent = 0;
    sendJob.failed = 0;
    sendJob.skipped = preview.items.length - sendable.length;
    sendJob.error = "";
    sendJob.startedAt = Date.now();
    sendJob.finishedAt = 0;

    const log = typeof opts.log === "function" ? opts.log : (m) => console.log(m);
    const onDone = typeof opts.onDone === "function" ? opts.onDone : null;
    setImmediate(() => {
        testSendDelivered(sendable.map((x) => x.id), {
            ...opts,
            to,
            log,
            shouldStop: () => sendJob.stop,
        }).then((r) => {
            sendJob.sent = r.sent || 0;
            sendJob.failed = r.failed || 0;
            sendJob.skipped = r.skipped || 0;
            sendJob.error = r.ok ? "" : (r.items || []).find((x) => !x.ok && !x.skipped)?.error || "";
            onDone?.(r);
        }).catch((e) => {
            sendJob.error = String((e as Error)?.message || e).slice(0, 240);
            onDone?.({ok: false, error: sendJob.error, sent: 0, failed: sendJob.queued, skipped: sendJob.skipped, to, items: []});
        }).finally(() => {
            sendJob.running = false;
            sendJob.finishedAt = Date.now();
        });
    });

    return {
        ok: true,
        async: true,
        queued: sendable.length,
        skipped: preview.items.length - sendable.length,
        to,
        preview: preview.items,
    };
}
