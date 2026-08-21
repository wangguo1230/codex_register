// @ts-nocheck
// mail.com 单封发送：粘性出口、跳板租约、重试和邮箱代理状态持久化。
import * as db from "../db.js";
import {scheduler} from "../scheduler.js";
import {
    JUMP_MAX_EXITS,
    isProxySessionDead,
    kookeeySessionOf,
    mailJumpPool,
    mailProxyPool,
    maskProxyUrl,
    mintStickySession,
    pickLiveMailProxy,
} from "../../src/mail/proxy-pool.js";
import {mailSendWorkerRunner} from "./mail-send-worker-runner.js";

const SAME_PROXY_TRIES = Math.max(2, Number(process.env.MAILCOM_SEND_PROXY_TRIES || 3));
const FAIL_BEFORE_ROTATE = Math.max(2, Number(process.env.MAILCOM_SEND_PROXY_FAILS || 3));
const PROBE_BUDGET_MS = Math.max(3000, Number(process.env.MAILCOM_SEND_PROBE_MS || 8000));
const SEND_LEASE_MS = Math.max(60_000, Number(process.env.MAILCOM_SEND_LEASE_MS || 120_000));

/** 邮箱跳板开关关闭后，忽略旧版 mailProxyJump 回退值和跳板池。 */
export function selectMailJump(enabled: boolean, leasedUrl = "", fallback = "") {
    return enabled ? String(leasedUrl || fallback || "").trim() : "";
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
function isRetryableSend(err) {
    if (isProxySessionDead(err)) return true;
    return /timeout|超时|预检失败|ETIMEDOUT|ECONNRESET|ECONNREFUSED|HTTP 5\d\d|HTTP 429|net::|ERR_TUNNEL|ERR_PROXY|socket hang up/i.test(String((err as Error)?.message || err || ""));
}

async function writeSendLog(fields) {
    try { return await db.insertMailSendLog(fields); } catch (e) {
        console.warn("[mail-send] 写日志失败", String((e as Error)?.message || e).slice(0, 120));
        return 0;
    }
}

async function releaseLease(lease) {
    try { await lease?.release?.(); } catch { /* 释放失败不覆盖发信结果 */ }
}

async function withJump(owner, fn, {skip = false} = {}) {
    if (skip) return fn("");
    const who = String(owner || "mail-send");
    const enabled = scheduler.proxyJumpMailEnabled !== false;
    let jumpLease = null;
    if (enabled && mailJumpPool.urls.length) {
        try {
            jumpLease = await mailJumpPool.lease(who, {timeoutMs: 45_000, leaseMs: SEND_LEASE_MS, maxPerJump: JUMP_MAX_EXITS});
        } catch (error) {
            throw new Error(`邮箱跳板池全忙（等待 45s）：${String(error?.message || error).slice(0, 160)}`);
        }
    }
    const jumpUrl = selectMailJump(enabled, jumpLease?.url, scheduler.mailProxyJump);
    try {
        return await fn(jumpUrl);
    } finally {
        await releaseLease(jumpLease);
    }
}

async function leaseSendExit(owner, preferUrl = "") {
    const lease = await mailProxyPool.lease(owner, {
        fallback: scheduler.mailProxyFallback(),
        maxPerTemplate: Math.max(1, Math.min(8, scheduler.pwConcurrency || 1)),
        freshSession: !preferUrl,
        preferUrl,
        timeoutMs: 45_000,
        leaseMs: SEND_LEASE_MS,
    });
    try {
        const url = String(lease.url || "").trim();
        if (!url) throw new Error("发信必须走邮箱代理池，禁止直连");
        return {...lease, url};
    } catch (error) {
        await releaseLease(lease);
        throw error;
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
    const log = typeof opts.log === "function" ? opts.log : (m) => console.log(m);

    let mb = opts.mailbox || null;
    if (!mb && opts.mailboxId) mb = await db.getMailbox(opts.mailboxId);
    if (!mb && opts.email) mb = await db.getMailboxByEmailAny(opts.email);
    const email = String(mb?.email || opts.email || "").trim().toLowerCase();
    const password = String(opts.password || mb?.password || "").trim();
    if (!email || !password) throw new Error("发信缺少邮箱或密码");
    if (!mb) mb = {email, password, proxy_url: "", proxy_ip: "", proxy_fail: 0};

    // 直连模式不依赖跳板，避免代理池拥塞时无意义地等待租约。
    const forceDirect = !/^(0|false|no)$/i.test(String(process.env.MAILCOM_SEND_DIRECT ?? "1"));
    return withJump(`send:${email}`, async (leasedJump) => {
        // 跳板租约和旧版 fallback 已由 withJump 统一解析；这里不能再次读取
        // scheduler.mailProxyJump，否则会绕过“关闭邮箱跳板”开关。
        const jumpUrl = String(leasedJump || "").trim();
        // 当前带账密住宅代理的本地转发环会卡死 Chrome（RSS 冲到几十 GB），
        // 与收信 worker 对齐：浏览器发信默认直连；粘性出口仍写入邮箱，供后续代理链路修好后复用。
        const rememberedExit = String(mb.proxy_url || "").trim();
        let exitLease = null;
        let exitUrl = "";

        const runSend = async (exit, reused, attemptTag) => {
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
                log(`发信${attemptTag} mail.com CATS ${maskProxyUrl(exit)}${sess ? ` session=${sess}` : ""}${ip ? ` ip=${ip}` : ""}（${reused ? "邮箱已记出口" : "新出口"} · 第 ${i}/${SAME_PROXY_TRIES} 次）${forceDirect ? " · 浏览器直连" : (jumpUrl ? ` · 跳板 ${maskProxyUrl(jumpUrl)}` : " · 无跳板")}`);
                if (!forceDirect && (i === 1 || !ip)) {
                    const probeController = new AbortController();
                    try {
                        const live = await withTimeout(
                            pickLiveMailProxy(exit, {
                                tries: 1,
                                rotate: false,
                                jump: jumpUrl,
                                signal: probeController.signal,
                                targetHost: "webmail-cats-live.mail.com",
                                targetPort: 443,
                                log: (m) => log(`发信探测 ${m}`),
                            }),
                            PROBE_BUDGET_MS,
                            `探测超时 ${PROBE_BUDGET_MS}ms`,
                        );
                        if (live?.probe?.ip && live.probe.ip !== "?") ip = live.probe.ip;
                        if (live && !live.ok) {
                            throw new Error(`发信代理预检失败: ${live.probe?.reason || "出口不可用"}`);
                        }
                    } catch (e) {
                        const reason = String((e as Error)?.message || e).slice(0, 120);
                        throw new Error(reason.startsWith("发信代理预检失败") ? reason : `发信代理预检失败: ${reason}`);
                    } finally {
                        probeController.abort();
                    }
                }
                try {
                    // CATS mailsubmission 必须在 worker 子进程跑。
                    if (forceDirect) {
                        log(`发信${attemptTag} CATS 浏览器走直连（MAILCOM_SEND_DIRECT=1；出口 ${maskProxyUrl(exit)} 仅记账）`);
                    }
                    const r = await mailSendWorkerRunner.run({
                        email,
                        password,
                        to,
                        subject,
                        html,
                        text,
                        fromName,
                        headless: true,
                        proxy: forceDirect ? "" : exit,
                        jump: forceDirect ? "" : jumpUrl,
                        profile: mb?.browser_fp || undefined,
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
                    log(`发信${attemptTag}失败 ${err} session=${sess || "-"}`);
                    await writeSendLog({...baseLog(), proxy_ip: ip, status: "fail", error: err});
                    if (mb.id) {
                        db.appendMailboxLog(mb.id, `[发信] 第 ${i}/${SAME_PROXY_TRIES} 次失败 ${err.slice(0, 140)} session=${sess || "-"}`).catch(() => {});
                    }
                    // 代理预检或 SMTP 整段超时已经足以判定当前出口不可用，不重复等待同一条线路。
                    if (/发信超时|发信代理预检失败/.test(err) || !isRetryableSend(e) || i >= SAME_PROXY_TRIES) break;
                    log(`同一粘性出口再试（${i}/${SAME_PROXY_TRIES} 已失败）`);
                }
            }
            throw lastErr || new Error("发信失败");
        };

        try {
            try {
                exitLease = await leaseSendExit(`send:${email}`, rememberedExit);
            } catch (error) {
                throw new Error(`邮箱出口代理池全忙（等待 45s）：${String(error?.message || error).slice(0, 160)}`);
            }
            exitUrl = exitLease.url;
            const changed = !rememberedExit || rememberedExit !== exitUrl;
            if (changed) {
                await rememberOnMailbox(mb, exitUrl, "", 0);
                log(rememberedExit
                    ? `邮箱粘性出口不在当前代理池，已切换 ${maskProxyUrl(rememberedExit)} → ${maskProxyUrl(exitUrl)}`
                    : `发信首次从公共代理池租用出口 ${maskProxyUrl(exitUrl)}（写入邮箱管理）`);
            } else {
                log(`发信从公共代理池复用粘性出口 ${maskProxyUrl(exitUrl)}`);
            }
            try {
                return await runSend(exitUrl, !changed, changed ? "绑定后" : "");
            } catch (e) {
                if (!isProxySessionDead(e) && !isRetryableSend(e)) throw e;
                let fails = Number(mb.proxy_fail || 0) + 1;
                if (mb.id) {
                    try { fails = await db.bumpMailboxProxyFail(mb.id); } catch { /* */ }
                }
                mb.proxy_fail = fails;
                const sess = kookeeySessionOf(exitUrl) || "-";
                const forceRotate = /发信超时|发信代理预检失败/.test(String((e as Error)?.message || e || ""));
                if (!forceRotate && fails < FAIL_BEFORE_ROTATE) {
                    const msg = `粘性代理暂不可用（${fails}/${FAIL_BEFORE_ROTATE}），仍保留邮箱 session=${sess}`;
                    log(msg);
                    throw new Error(`${msg}: ${String((e as Error)?.message || e).slice(0, 160)}`);
                }
                await releaseLease(exitLease);
                try {
                    exitLease = await leaseSendExit(`send-rotate:${email}`, nextSticky(exitUrl));
                } catch (error) {
                    throw new Error(`邮箱出口代理池换出口失败（等待 45s）：${String(error?.message || error).slice(0, 160)}`);
                }
                const next = exitLease.url;
                await rememberOnMailbox(mb, next, "", 0);
                log(`出口连续 ${fails} 次不可用，更新邮箱粘性 ${maskProxyUrl(exitUrl)} → ${maskProxyUrl(next)} session=${kookeeySessionOf(next) || "-"}`);
                if (mb.id) {
                    db.appendMailboxLog(mb.id, `[发信] 出口已更新 session=${sess} → ${kookeeySessionOf(next) || "-"}`).catch(() => {});
                }
                return runSend(next, false, "换出口后");
            }
        } finally {
            await releaseLease(exitLease);
        }
    }, {skip: forceDirect});
}
