// @ts-nocheck
/**
 * Gmail 老号安全整备：拆掉卖家找回入口，再换钥匙。
 * 顺序：删恢复手机 → 删辅助邮箱 → 换 TOTP → 开 IMAP → 改密 → 登出其它设备。
 * 底线（2FA+IMAP）放在改密前面，避免改密后的「再登录」把取件卡死。
 */
import {mkdirSync} from "node:fs";
import path from "node:path";
import {ensureGoogleLoggedIn, googleReauthPassword} from "./google-auth.js";
import {change2faOnPage, changePasswordOnPage} from "./google-manage.js";
import {enableGmailFetch} from "./google-imap.js";

const RECOVERY_EMAIL_URLS = [
    "https://myaccount.google.com/signinoptions/rescueemail?hl=en",
    "https://myaccount.google.com/signinoptions/recoveryoptions?hl=en",
    "https://myaccount.google.com/security?hl=en",
];
const RECOVERY_PHONE_URLS = [
    "https://myaccount.google.com/signinoptions/rescuephone?hl=en",
    "https://myaccount.google.com/signinoptions/phone?hl=en",
    "https://myaccount.google.com/security?hl=en",
];
const DEVICE_URLS = [
    "https://myaccount.google.com/device-activity?hl=en",
    "https://gds.google.com/web/home?hl=en",
];

const REMOVE_WORDS = [
    "Remove", "Delete", "删除", "移除", "Remove phone", "Remove email",
    "Delete phone", "Delete email", "Hapus", "Remover", "Supprimer", "Quitar",
];
const CONFIRM_WORDS = [
    "Remove", "Delete", "Confirm", "Yes", "Continue", "OK",
    "删除", "移除", "确认", "确定", "继续", "是",
];
const SIGNOUT_WORDS = [
    "Sign out", "Sign out of all other devices", "Sign out of all devices",
    "登出", "退出", "退出其它设备", "退出其他设备", "Sign out of other sessions",
];

function summarizeLoginFail(raw = "") {
    const s = String(raw || "");
    if (/听写|type the text you hear|type the characters/i.test(s)) return "登不上·听写验证";
    if (/Something went wrong|故障弹窗/i.test(s)) return "登不上·页面故障";
    if (/Verify it|确认辅助|recovery email/i.test(s)) return "登不上·要验证辅助邮箱";
    if (/signin\/rejected|拒绝页/i.test(s)) return "登不上·出口被拒";
    if (/登录页一直空白|一直 Loading/i.test(s)) return "登不上·登录页空白";
    if (/challenge\/pwd|密码页过不去|Loading Welcome|Enter your password/i.test(s)) return "登不上·密码页过不去";
    if (/邮箱页提交|仍在邮箱页|identifier/i.test(s)) return "登不上·邮箱页不走";
    if (/代理中断|SSL/i.test(s)) return s.split("\n")[0].slice(0, 120);
    return (s || "登录失败").split("\n")[0].slice(0, 120);
}

async function dump(page, name, log) {
    try {
        const dir = path.resolve(process.cwd(), "captures", "screenshots");
        mkdirSync(dir, {recursive: true});
        await page.screenshot({path: path.join(dir, `${name}_${Date.now()}.png`)});
    } catch { /* ignore */ }
}

async function clickAny(page, keywords, timeout = 2500) {
    for (const kw of keywords) {
        const btn = page.getByRole("button", {name: new RegExp(`^\\s*${kw}\\s*$`, "i")}).first();
        if (await btn.isVisible({timeout: 700}).catch(() => false)) {
            await btn.click().catch(() => {});
            return kw;
        }
        const loc = page.locator(`button:has-text("${kw}"), [role="button"]:has-text("${kw}"), a:has-text("${kw}")`).first();
        if (await loc.isVisible({timeout: 700}).catch(() => false)) {
            await loc.click().catch(() => {});
            return kw;
        }
    }
    return "";
}

async function bodyHas(page, re) {
    const t = await page.innerText("body").catch(() => "");
    return re.test(String(t || ""));
}

async function pageLooks404(page) {
    const blob = `${page.url()} ${String(await page.innerText("body").catch(() => ""))}`;
    return /404|not found on this server|requested url was not found|that's an error/i.test(blob);
}

async function gotoReauth(page, url, cred, log) {
    try {
        await page.goto(url, {waitUntil: "domcontentloaded", timeout: 60000});
    } catch { /* ignore */ }
    await page.waitForTimeout(1500);
    if (await pageLooks404(page)) {
        log(`[整备] 地址已失效，跳过 ${url.replace("https://myaccount.google.com", "")}`);
        return false;
    }
    await googleReauthPassword(page, {
        password: cred.password, totpSecret: cred.totpSecret, totpFallback: cred.totpPrev || "", log,
    });
    await page.waitForTimeout(2500);
    return true;
}

async function alreadyGone(page, kind) {
    const hasCard = await page.locator(kind === "email" ? "text=/Your recovery email/i" : "text=/Your recovery phone/i")
        .first().isVisible({timeout: 1200}).catch(() => false);
    if (hasCard) return false;
    const add = page.getByRole("button", {
        name: kind === "email" ? /add( a)? recovery email/i : /add recovery phone/i,
    }).or(page.getByText(kind === "email" ? /Add( a)? recovery email/i : /Add recovery phone/i));
    return add.first().isVisible({timeout: 1500}).catch(() => false);
}

/** 删除恢复手机号。没有则 ok=true。 */
export async function removeRecoveryPhone(page, cred, log = () => {}) {
    log("[整备] 删除恢复手机号");
    for (const url of RECOVERY_PHONE_URLS) {
        if (!await gotoReauth(page, url, cred, log)) continue;
        if (await alreadyGone(page, "phone")) {
            log("[整备] 本来就没有恢复手机号");
            return {ok: true, skipped: true};
        }
        const hit = await clickAny(page, REMOVE_WORDS, 3000);
        if (!hit) continue;
        await page.waitForTimeout(1500);
        await clickAny(page, CONFIRM_WORDS, 2500);
        await page.waitForTimeout(2500);
        if (await alreadyGone(page, "phone") || await bodyHas(page, /removed|deleted|已删除|已移除/i)) {
            log("[整备] 恢复手机号已删除");
            return {ok: true};
        }
    }
    await dump(page, "secure_phone", log);
    log("[整备] 未找到恢复手机号删除入口(可能本来就没有)");
    return {ok: true, skipped: true};
}

/** 删除辅助/恢复邮箱。没有则 ok=true。 */
export async function removeRecoveryEmail(page, cred, log = () => {}) {
    log("[整备] 删除辅助邮箱");
    for (const url of RECOVERY_EMAIL_URLS) {
        if (!await gotoReauth(page, url, cred, log)) continue;
        if (await alreadyGone(page, "email")) {
            log("[整备] 本来就没有辅助邮箱");
            return {ok: true, skipped: true};
        }
        // 新版 UI：卡片右侧是铅笔 + 垃圾桶图标，没有 “Delete” 文案
        const trash = page.locator(
            '[aria-label*="Delete" i], [aria-label*="Remove" i], [aria-label*="删除"], [data-tooltip*="Delete" i], [data-tooltip*="Remove" i]',
        ).first();
        if (await trash.isVisible({timeout: 2000}).catch(() => false)) {
            await trash.click();
        } else {
            const card = page.locator("text=/Your recovery email/i").locator("xpath=ancestor::*[.//button][1]");
            const iconBtns = card.locator("button");
            const n = await iconBtns.count().catch(() => 0);
            if (n >= 2) await iconBtns.nth(n - 1).click().catch(() => {});
            else if (!await clickAny(page, REMOVE_WORDS, 3000)) {
                const edit = await clickAny(page, ["Edit", "编辑", "Change", "更改"], 2000);
                if (edit) {
                    await page.waitForTimeout(1500);
                    await clickAny(page, REMOVE_WORDS, 2500);
                }
            }
        }
        await page.waitForTimeout(1200);
        await clickAny(page, CONFIRM_WORDS, 2500);
        await page.waitForTimeout(2500);
        if (await alreadyGone(page, "email") || await bodyHas(page, /removed|deleted|已删除|已移除/i)) {
            log("[整备] 辅助邮箱已删除");
            return {ok: true};
        }
    }
    await dump(page, "secure_email", log);
    log("[整备] 未能确认辅助邮箱已删除");
    return {ok: false, error: "未能删除辅助邮箱"};
}

/** 登出其它设备，保留当前比特窗口。 */
export async function signOutOtherDevices(page, cred, log = () => {}) {
    log("[整备] 登出其它设备");
    let signed = 0;
    for (const url of DEVICE_URLS) {
        if (!await gotoReauth(page, url, cred, log)) continue;
        const all = await clickAny(page, [
            "Sign out of all other devices",
            "Sign out of all devices",
            "退出其它设备",
            "退出其他设备",
            "Sign out of other sessions",
        ], 3000);
        if (all) {
            await page.waitForTimeout(1000);
            await clickAny(page, CONFIRM_WORDS.concat(["Sign out", "登出"]), 2500);
            await page.waitForTimeout(2000);
            log("[整备] 已点退出其它设备");
            return {ok: true, signed: -1};
        }

        // 逐个设备卡片点 Sign out（跳过 This device / 当前设备）
        const buttons = page.locator('button, [role="button"], a');
        const n = Math.min(await buttons.count().catch(() => 0), 40);
        for (let i = 0; i < n; i++) {
            const b = buttons.nth(i);
            if (!await b.isVisible().catch(() => false)) continue;
            const txt = ((await b.innerText().catch(() => "")) || "").replace(/\s+/g, " ").trim();
            if (!/sign out|登出|退出/i.test(txt)) continue;
            if (/this device|当前设备|this computer/i.test(txt)) continue;
            const parent = await b.evaluate((el) => (el.closest("li,article,section,div") || el).textContent || "").catch(() => "");
            if (/this device|当前设备|you're using|正在使用/i.test(parent) && /this device|当前/i.test(parent)) continue;
            await b.click().catch(() => {});
            await page.waitForTimeout(800);
            await clickAny(page, CONFIRM_WORDS.concat(["Sign out", "登出"]), 1500);
            signed += 1;
            await page.waitForTimeout(800);
        }
        if (signed) {
            log(`[整备] 已登出 ${signed} 个其它设备`);
            return {ok: true, signed};
        }
    }
    await dump(page, "secure_devices", log);
    log("[整备] 未见其它设备可登出(可能只有当前窗口)");
    return {ok: true, signed: 0, skipped: true};
}

/**
 * 完整整备。cred 会被就地更新为新密码 / 新 TOTP。
 */
export async function hardenGoogleAccountOnPage(page, cred, log = () => {}, onCheckpoint = async () => {}) {
    const out = {
        ok: true,
        password: "",
        totpSecret: "",
        recoveryCleared: false,
        phoneCleared: false,
        sessionsSignedOut: 0,
        devicesDone: false,
        passwordChanged: false,
        totpRotated: false,
        imapPassword: "",
        missing: [],
        errors: [],
    };

    const {planHardenSkip} = await import("./google-state.js");
    const skip = cred.skip || planHardenSkip(cred);
    const hadRecovery = !!(cred.recoveryEmail || "").trim();
    const leftLabel = {totp: "换2FA", password: "改密", devices: "踢设备", phone: "删手机", recovery: "删辅助邮箱", imap: "IMAP"};
    if (skip.left?.length) log(`[邮箱管理] 续跑，只做: ${skip.left.map((k) => leftLabel[k] || k).join("、")}`);
    else log("[邮箱管理] 缺口已齐");
    const closed = (e) => /has been closed|Target page|Target closed|Browser has been closed/i.test(String(e || ""));
    const noteErr = (e, fallback) => {
        const s = String(e || fallback || "失败");
        // 已经登录进去了，单步失败只记缺口，禁止再抛「换 session」把窗关掉。
        out.errors.push(closed(s) ? "窗口被关" : s.split("\n")[0].slice(0, 160));
    };
    const pageGone = () => {
        try { return page.isClosed(); } catch { return true; }
    };
    const {isMailboxJobStopped} = await import("./mailbox-job-stop.js");
    const stopNow = () => isMailboxJobStopped();
    const finalize = () => {
        if (!out.imapPassword && (skip.imap || String(cred.imapPassword || "").trim())) {
            out.imapPassword = cred.imapPassword || out.imapPassword || "kept";
        }
        if (!out.totpRotated && skip.totp) out.totpRotated = true;
        const missing = [];
        if (!(out.totpRotated || skip.totp)) missing.push("2FA");
        if (!out.imapPassword && !skip.imap) missing.push("IMAP");
        if (!out.passwordChanged) missing.push("改密");
        if (!out.devicesDone && !skip.devices) missing.push("踢设备");
        if (!out.phoneCleared && !skip.phone) missing.push("手机");
        if (!out.recoveryCleared && hadRecovery && !skip.recovery) missing.push("辅助邮箱");
        out.missing = missing;
        out.ok = !missing.includes("2FA") && !missing.includes("IMAP");
        return out;
    };
    const stopAndKeep = () => {
        log("[邮箱管理] 已停止，已落库的步骤保留，后续不再跑");
        return finalize();
    };

    const runTimed = async (label, fn, ms = 90000, failOnTimeout = false) => {
        let timer;
        try {
            return await Promise.race([
                fn(),
                new Promise((resolve) => {
                    timer = setTimeout(() => {
                        log(`[邮箱管理] ${label} 超时 ${Math.round(ms / 1000)}s，先跳过`);
                        resolve(failOnTimeout
                            ? {ok: false, error: `${label}超时`, timeout: true}
                            : {ok: true, skipped: true, timeout: true});
                    }, ms);
                }),
            ]);
        } finally {
            clearTimeout(timer);
        }
    };

    const gone = (step) => {
        if (!pageGone()) return false;
        noteErr("窗口被关", "窗口被关");
        log(`[邮箱管理] 窗口已关（${step} 之后），后续步骤不再跑`);
        return true;
    };

    if (stopNow()) return stopAndKeep();
    if (skip.phone) {
        log("[邮箱管理 1/6] 恢复手机已清，跳过");
        out.phoneCleared = true;
    } else {
        log("[邮箱管理 1/6] 删除恢复手机号");
        const phone = await runTimed("删手机", () => removeRecoveryPhone(page, cred, log).catch((e) => ({ok: false, error: String(e?.message || e)})));
        out.phoneCleared = !!phone?.ok || !!phone?.timeout;
        if (!phone?.ok && !phone?.timeout) noteErr(phone?.error, "删手机号失败");
    }
    if (gone("删手机")) return finalize();

    if (stopNow()) return stopAndKeep();
    if (skip.recovery) {
        log("[邮箱管理 2/6] 辅助邮箱已清，跳过");
        out.recoveryCleared = true;
        cred.recoveryEmail = "";
    } else {
        log("[邮箱管理 2/6] 删除辅助邮箱");
        const rec = await runTimed("删辅助邮箱", () => removeRecoveryEmail(page, cred, log).catch((e) => ({ok: false, error: String(e?.message || e)})));
        out.recoveryCleared = !!(rec?.ok && !rec?.skipped) || (!hadRecovery && !!rec?.ok) || !!rec?.timeout;
        if (rec?.skipped && !hadRecovery) out.recoveryCleared = true;
        if (out.recoveryCleared) cred.recoveryEmail = "";
        if (!rec?.ok && !rec?.timeout) noteErr(rec?.error, "删辅助邮箱失败");
    }
    if (gone("删辅助邮箱")) return finalize();

    const takeImap = async (why) => {
        if (skip.imap || out.imapPassword) {
            log("[邮箱管理] IMAP 已有应用密码，跳过");
            out.imapPassword = out.imapPassword || cred.imapPassword || "";
            return;
        }
        log(`[邮箱管理] 开通 IMAP（${why}）`);
        try {
            const fetchR = await enableGmailFetch(page, {
                email: cred.email, password: cred.password,
                totpSecret: cred.totpSecret, totpFallback: cred.totpPrev || "", log,
            });
            if (fetchR?.ok && fetchR.imapPassword) {
                out.imapPassword = fetchR.imapPassword;
                cred.imapPassword = fetchR.imapPassword;
                await onCheckpoint({imapPassword: fetchR.imapPassword});
            } else noteErr(fetchR?.error, "IMAP 开通失败");
        } catch (e) {
            noteErr(e?.message || e, "IMAP 开通失败");
        }
    };

    // 先取应用密码、再换我们的 2FA。刚换完验证器 Google 常拒发密码；应用密码不跟某一把 TOTP 绑定。
    if (stopNow()) return stopAndKeep();
    if (skip.imap) {
        out.imapPassword = cred.imapPassword || "";
        log("[邮箱管理 3/6] IMAP 已有应用密码，跳过");
    } else if (!String(cred.totpSecret || "").trim()) {
        log("[邮箱管理 3/6] 还没有可用 TOTP，先换 2FA 再取 IMAP");
    } else {
        await takeImap("用当前验证器，换 2FA 之前");
    }
    if (gone("IMAP")) return finalize();

    if (stopNow()) return stopAndKeep();
    if (skip.totp) {
        log("[邮箱管理 4/6] 换 2FA 已做过，跳过");
        out.totpRotated = true;
        out.totpSecret = cred.totpSecret || out.totpSecret;
    } else {
        log("[邮箱管理 4/6] 更换 Google 2FA");
        const oldTotp = cred.totpSecret;
        const t = await runTimed("换2FA", () => change2faOnPage(page, {
            email: cred.email, password: cred.password,
            totpSecret: cred.totpSecret, recoveryEmail: cred.recoveryEmail, log,
            onPersist: onCheckpoint,
        }).catch((e) => ({ok: false, error: String(e?.message || e)})), 180000, true);
        if (t?.ok && t.totpSecret) {
            cred.totpPrev = oldTotp && oldTotp !== t.totpSecret ? oldTotp : cred.totpPrev;
            cred.totpSecret = t.totpSecret;
            out.totpSecret = t.totpSecret;
            out.totpRotated = true;
            log("[邮箱管理] 新 Google TOTP 已生效");
            await onCheckpoint({totpSecret: t.totpSecret});
        } else {
            noteErr(t?.error, "换 2FA 失败");
            log(`[邮箱管理] 换 2FA 失败: ${t?.error || ""}`);
            if (out.imapPassword || skip.imap) {
                log("[邮箱管理] IMAP 已有，换 2FA 失败就收工，不再改密以免重登");
                return finalize();
            }
        }
    }
    if (gone("换2FA")) return finalize();
    if ((out.totpRotated || skip.totp) && (out.imapPassword || skip.imap)) {
        log("[邮箱管理] 2FA+IMAP 已齐，本轮结束，不再改密/踢设备");
        return finalize();
    }

    if (skip.password) {
        log("[邮箱管理 5/6] 密码已换过，跳过");
        out.passwordChanged = true;
    } else if (stopNow()) {
        return stopAndKeep();
    } else {
        log("[邮箱管理 5/6] 修改 Google 密码");
        const pw = await changePasswordOnPage(page, {
            email: cred.email, password: cred.password,
            totpSecret: cred.totpSecret, totpFallback: cred.totpPrev || "",
            recoveryEmail: cred.recoveryEmail, log,
            onPersist: async (np) => { await onCheckpoint({password: np, passwordChanged: true, verified: true}); },
        }).catch((e) => ({ok: false, error: String(e?.message || e)}));
        if (pw?.ok && pw.newPassword && pw.verified !== false) {
            cred.password = pw.newPassword;
            out.password = pw.newPassword;
            out.passwordChanged = true;
            log("[邮箱管理] 新 Google 密码已生效（已验证）");
            await onCheckpoint({password: pw.newPassword, passwordChanged: true, verified: true});
        } else {
            if (pw?.submitted && pw.newPassword) {
                log(`[留痕] 改密已提交但未见成功文案，不覆盖库内密码 候选=${pw.newPassword}`);
                await onCheckpoint({password: pw.newPassword, verified: false});
            }
            noteErr(pw?.detail || pw?.error, "改密失败");
            log(`[邮箱管理] 改密失败: ${pw?.detail || pw?.error || ""}`);
        }
    }
    if (gone("改密")) return finalize();

    if (stopNow()) return stopAndKeep();
    if (process.env.REG_SKIP_DEVICES === "1" || skip.devices) {
        log("[邮箱管理 6/6] 踢设备已做过，跳过");
        out.devicesDone = true;
    } else {
        log("[邮箱管理 6/6] 踢出其它设备");
        const sess = await runTimed("踢设备", () => signOutOtherDevices(page, cred, log).catch((e) => ({ok: false, error: String(e?.message || e)})));
        out.sessionsSignedOut = sess?.signed || 0;
        out.devicesDone = !!sess?.ok || !!sess?.timeout;
        if (!sess?.ok && !sess?.timeout) noteErr(sess?.error, "登出设备失败");
    }

    finalize();
    const errBrief = out.errors.filter((e) => e !== "窗口被关").map((e) => String(e).split("\n")[0].slice(0, 80)).join("；");
    const title = out.ok ? (out.missing.length ? "可用" : "完成") : ("未完成: " + (out.missing.join("/") || "部分步骤失败"));
    log(`[邮箱管理] ${title}${errBrief ? " · " + errBrief : ""}`);
    return out;
}

async function openGoogleBitOnce({proxyUrl = "", jumpUrl = "", name = "gmail", remark = "gmail-manage", log = () => {}, signal, fn, onProxy} = {}) {
    const {bitSessionReady, createBitWindow, openBitWindow, closeBitWindow, deleteBitWindow, trackBitWindow, untrackBitWindow, isBitLoggedOut} = await import("../bitbrowser.js");
    const {chromium} = await import("playwright-core");
    const {pickLiveMailProxy, maskProxyUrl} = await import("./proxy-pool.js");
    const {isMailboxJobStopped, shouldForceDropWindow} = await import("./mailbox-job-stop.js");
    const stopped = () => !!(signal?.aborted || isMailboxJobStopped());
    if (stopped()) throw new Error("已停止");
    const bit = await bitSessionReady();
    if (!bit.ok) throw new Error(bit.reason);
    let liveProxy = proxyUrl || "";
    let chainClose = () => {};
    let bitProxy = "";
    let extractIp = true;
    let timeZone = "";
    if (liveProxy) {
        if (stopped()) throw new Error("已停止");
        const {getMailProxyJump} = await import("./proxy-pool.js");
        const jumpNow = String(jumpUrl || getMailProxyJump() || "").trim();
        log(jumpNow ? `[网络] 先测代理出口 / Google（经跳板 ${jumpNow}）` : "[网络] 先测代理出口 / Google（无跳板，直连网关，国内会超时）");
        const picked = await pickLiveMailProxy(liveProxy, {tries: 3, rotate: true, log: (m) => log(`[网络] ${m}`), jump: jumpNow});
        if (!picked.ok) throw new Error(`代理不通，先别登 Google: ${picked.probe.reason || "未知"}`);
        liveProxy = picked.url;
        log(`[网络] 通 出口 ${picked.probe.ip} Google=${picked.probe.google} ${picked.probe.ms}ms ${maskProxyUrl(liveProxy)}`);
        try { onProxy?.(liveProxy, picked.probe.ip || ""); } catch { /* */ }
        const jump = jumpNow;
        if (jump) {
            const {wrapExitThroughJump, timezoneFromExitUrl} = await import("./proxy-chain.js");
            const wrapped = await wrapExitThroughJump(liveProxy, jump);
            chainClose = wrapped.close;
            bitProxy = wrapped.url;
            extractIp = false;
            timeZone = timezoneFromExitUrl(liveProxy);
            log(`[网络] 链式 跳板→${wrapped.destHost}:${wrapped.destPort} 本机转发 :${wrapped.localPort}${timeZone ? " tz=" + timeZone : ""}`);
        } else {
            bitProxy = liveProxy;
        }
        const bitProbe = await pickLiveMailProxy(bitProxy, {tries: 1, rotate: false, log: (m) => log(`[网络] 比特将用的链 ${m}`), jump: ""});
        if (!bitProbe.ok) {
            throw new Error(`代理不通 开窗前复测失败: ${bitProbe.probe.reason || "未知"}`);
        }
    }
    let bitId = "";
    const dropWindow = () => { if (bitId) closeBitWindow(bitId); };
    // 停止不要立刻关窗：改密/换2FA 可能已在 Google 生效，先等落库。
    const stopWatch = setInterval(() => { if (shouldForceDropWindow()) dropWindow(); }, 800);
    try {
        if (stopped()) throw new Error("已停止");
        try {
            bitId = await createBitWindow({
                proxy: bitProxy || "",
                name: String(name || "gmail").slice(0, 32),
                remark: remark || "gmail-manage",
                timeZone,
            });
        } catch (e) {
            const msg = String(e?.message || e);
            if (/login out|未登录/i.test(msg) || isBitLoggedOut()) {
                throw new Error("比特已退出登录，请先在客户端重新登录");
            }
            throw e;
        }
        log(`[指纹] 比特窗口 ${bitId}${liveProxy ? " ← " + String(liveProxy).replace(/:[^:@/]+@/, ":***@") : "（无代理）"}${bitProxy && bitProxy !== liveProxy ? " 经跳板" : ""}`);
        trackBitWindow(bitId);
        const {ws} = await openBitWindow(bitId, {extractIp});
        if (stopped()) throw new Error("已停止");
        const browser = await chromium.connectOverCDP(ws);
        const ctx = browser.contexts()[0] || await browser.newContext();
        const page = ctx.pages()[0] || await ctx.newPage();
        page.setDefaultTimeout(30000);
        page.setDefaultNavigationTimeout(60000);
        // 登录后 Google 会去 youtube SetSID 同步 Cookie，经跳板常 SSL 掐死。整备不需要 YouTube。
        await page.route(/accounts\.youtube\.com|youtube\.com\/accounts\/SetSID|accounts\.blogger\.com/i, (route) => route.abort()).catch(() => {});
        const {applyGoogleEnglish} = await import("./google-auth.js");
        await applyGoogleEnglish(page);
        await page.waitForTimeout(1500);
        const splash = String(await page.innerText("body").catch(() => ""));
        if (/正在连接|代理IP自身连通|无法连接网络|Checking the proxy|something wrong with the proxy|No internet/i.test(splash)) {
            throw new Error("代理不通 比特预检页连不上出口，换 session 重开窗");
        }
        try {
            return await fn(page);
        } finally {
            untrackBitWindow(bitId);
        }
    } finally {
        clearInterval(stopWatch);
        if (bitId) {
            await closeBitWindow(bitId);
            await deleteBitWindow(bitId);
        }
        try { chainClose(); } catch { /* */ }
    }
}

/**
 * 开比特窗跑一轮。
 * 只有「还没登录进 Google」时，出口死了才关窗换 IP。
 * 一旦 markLoggedIn，窗里已有账号会话，再关会拆掉刚换的 2FA/密码，只许记步骤失败。
 */
export async function withGoogleBitSession({proxyUrl = "", jumpUrl = "", name = "gmail", remark = "gmail-manage", log = () => {}, signal, onProxy} = {}, fn) {
    const {isMailboxJobStopped} = await import("./mailbox-job-stop.js");
    const {isProxySessionDead, mintStickySession, kookeeySessionOf} = await import("./proxy-pool.js");
    const stopped = () => !!(signal?.aborted || isMailboxJobStopped());
    let liveProxy = proxyUrl || "";
    const maxAttempts = liveProxy && kookeeySessionOf(liveProxy) ? 2 : 1;
    const sess = {
        loggedIn: false,
        markLoggedIn() { this.loggedIn = true; },
    };
    let lastErr;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
        if (stopped()) throw new Error("已停止");
        if (attempt) {
            if (sess.loggedIn) break;
            liveProxy = mintStickySession(liveProxy);
            log(`[网络] 登录前出口挂了，换 session（${attempt + 1}/${maxAttempts}）`);
            try { onProxy?.(liveProxy, ""); } catch { /* */ }
        }
        try {
            return await openGoogleBitOnce({
                proxyUrl: liveProxy, jumpUrl, name, remark, log, signal, onProxy,
                fn: (page) => fn(page, sess),
            });
        } catch (e) {
            lastErr = e;
            const msg = String(e?.message || e);
            if (stopped() || /已停止|比特已退出登录/.test(msg)) throw e;
            if (sess.loggedIn) {
                log("[网络] 已在账号里，步骤失败不关窗换出口");
                throw e;
            }
            if (attempt < maxAttempts - 1 && isProxySessionDead(e)) continue;
            throw e;
        }
    }
    throw lastErr;
}

/** 开比特窗口跑完整整备（邮箱面板 / 独立脚本用）。 */
export async function runGoogleHardenWithBit(acc, {proxyUrl = "", jumpUrl = "", log = () => {}, onCheckpoint = async () => {}, onProxy, signal} = {}) {
    const {straightenGoogleCreds} = await import("../mfa.js");
    const straight = straightenGoogleCreds(acc);
    const {planHardenSkip} = await import("./google-state.js");
    const skip = planHardenSkip(acc);
    const cred = {
        email: acc.email,
        password: acc.password || "",
        totpSecret: straight.totpSecret,
        recoveryEmail: straight.recoveryEmail,
        imapPassword: acc.imap_password || acc.imapPassword || "",
        pw_status: acc.pw_status || "",
        google_state: acc.google_state || {},
        skip,
    };
    if (straight.swapped && straight.totpSecret) {
        log("  导入字段对调：totp/辅助邮箱已纠正");
        try {
            const {applyMailboxUpdate} = await import("../../server/db.js");
            await applyMailboxUpdate(acc.email, {
                totp_secret: straight.totpSecret,
                recovery_email: straight.recoveryEmail,
            });
            log("  已写回库：密钥和辅助邮箱对调");
        } catch { /* 跑任务时写回失败不挡登录 */ }
    } else if (straight.swapped && !straight.totpSecret) {
        log(`  totp 列是邮箱 ${straight.recoveryEmail || ""}，当辅助邮箱用，不把空密钥写回 totp`);
        if (straight.recoveryEmail) {
            try {
                const {applyMailboxUpdate} = await import("../../server/db.js");
                await applyMailboxUpdate(acc.email, {recovery_email: straight.recoveryEmail});
                log("  已写回库：辅助邮箱（totp 列原值）");
            } catch { /* 写回失败仍用内存里的辅助邮箱登录 */ }
        }
    }
    if (skip.all) {
        log("[整备] 缺口已齐，不再开窗");
        return {
            ok: true, skipped: true, password: cred.password, totpSecret: cred.totpSecret,
            totpRotated: true,
            imapPassword: cred.imapPassword, recoveryCleared: true, passwordChanged: true, devicesDone: true,
        };
    }
    const short = String(acc.email || "").split("@")[0].slice(0, 12);
    return withGoogleBitSession({proxyUrl, jumpUrl, name: `harden-${short}`, remark: "gmail-harden", log, signal, onProxy}, async (page, sess) => {
        try {
            const {lookupMailboxesByEmails} = await import("../../server/db.js");
            const [fresh] = await lookupMailboxesByEmails([acc.email]);
            if (fresh) {
                if (fresh.password) cred.password = fresh.password;
                if (fresh.totp_secret) cred.totpSecret = fresh.totp_secret;
                if (fresh.imap_password) cred.imapPassword = fresh.imap_password;
                cred.recoveryEmail = fresh.recovery_email || "";
                cred.pw_status = fresh.pw_status || cred.pw_status;
                cred.google_state = fresh.google_state || cred.google_state;
            }
        } catch { /* 重开窗时读库失败仍用内存凭证 */ }
        cred.skip = planHardenSkip(cred);
        let loginFail = "";
        const ok = await ensureGoogleLoggedIn(page, "https://myaccount.google.com/security?hl=en", {...cred, requireInbox: false}, (m) => {
            const s = String(m || "").replace(/^\s+/, "");
            if (/登录失败|登录未完成|reCAPTCHA|人机|听写|密码框|邮箱页|拒绝页|Something went wrong|故障弹窗|Verify it|辅助邮箱|代理中断|Loading Welcome|challenge\/pwd/i.test(s)) {
                loginFail = s;
            }
            log(m);
        });
        if (!ok) {
            const why = summarizeLoginFail(loginFail);
            return {ok: false, error: why, errors: [why], login: false};
        }
        sess?.markLoggedIn?.();
        // 进账号后整段都算改钥窗口：停任务也不能 2.5 秒就拆窗。
        const {enterMailJobCritical} = await import("./mailbox-job-stop.js");
        const leave = enterMailJobCritical();
        try {
            const done = await hardenGoogleAccountOnPage(page, cred, log, onCheckpoint);
            return {...done, login: true};
        } finally {
            leave();
        }
    });
}
