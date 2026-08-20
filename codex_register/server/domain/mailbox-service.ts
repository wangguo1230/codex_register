// @ts-nocheck
// 邮箱域统一服务(架构 v2:职责归一化的邮箱域入口)
//   - 资源池:按 usage(free/gpt/claude)查询/统计 + CAS 隔离分配(★不能串)
//   - 邮箱能力:登录验证/收信/取OTP/改密 —— 按 mailbox.provider 路由
// 设计:上层(server/scheduler)只依赖本服务,不再直接 import 具体 provider 文件,满足 DIP。
import * as db from "../db.js";
import {
    verifyMailcomLogin as verifyMailcomLoginInProcess,
    changeMailcomPassword as changeMailcomPasswordInProcess,
    fetchInboxList as fetchMailcomInboxListInProcess,
    fetchMailBodyFor as fetchMailcomBodyForInProcess,
    setMailProxy,
    getMailProxy,
    sendMailcomMail,
} from "../../src/mail/mailcom.js";
import {
    runMailcomBrowserTask,
    mailcomBrowserWorkerRunner,
} from "./mailcom-browser-worker.js";
import {fetchGmailImapInbox, fetchGmailImapBody} from "../../src/mail/google-imap.js";
import {getEmailVerificationCode} from "../../src/mailbox.js";

const VERIFY_MS = Math.max(60_000, Number(process.env.MAILCOM_VERIFY_TIMEOUT_MS || 90_000));
const IN_PROCESS = () => process.env.MAILCOM_WORKER === "1" || process.env.MAILCOM_INPROCESS === "1";

function workerResultError(result, fallback) {
    if (result?.ok) return result;
    throw new Error(String(result?.error || result?.detail || fallback));
}

/** :3100 里只派子进程；worker 自己再走进程内 Playwright。 */
export async function verifyMailcomLogin(email, password, log = (m) => {}, opts = {}) {
    if (IN_PROCESS()) {
        return verifyMailcomLoginInProcess(email, password, log, opts);
    }
    const result = await runMailcomBrowserTask({
        kind: "verify",
        email,
        password,
        opts,
        headless: opts.headless,
    }, {log, maxMs: VERIFY_MS});
    return {
        ok: !!result?.ok,
        reason: String(result?.reason || result?.error || "验密子进程无结果").slice(0, 160),
        wrongPassword: !!result?.wrongPassword,
    };
}

// ---- 资源池(隔离核心) ----
/** 列邮箱资源:usage 不传=全部;'free'=待分配;'gpt'/'claude'=已归属某业务 */
export const listMailboxes = (usage) => db.listMailboxes(usage);
export const mailboxStats = () => db.mailboxStats();
/** CAS 原子分配:把一个 free 邮箱锁给业务域(gpt/claude)。返回被锁定的 mailbox 或 null(池空)。★物理隔离,不可串 */
export const allocateMailbox = (usage) => db.allocateMailbox(usage);
/** 批量从 free 池分配 count 个给业务域并建 pending 业务号。返回 {allocated}。 */
export const allocateMailboxesTo = (usage, count, batch) => db.allocateMailboxesTo(usage, count, batch);
export const getMailbox = (id) => db.getMailbox(id);
export const importFreeMailboxes = (rows, grp) => db.importFreeMailboxes(rows, grp);
export const deleteMailbox = (id) => db.deleteMailbox(id);
export const setMailboxPassword = (id, pw, pwStatus) => db.setMailboxPassword(id, pw, pwStatus);

// ---- 邮箱能力 ----
export {setMailProxy, getMailProxy, sendMailcomMail};

export async function changeMailcomPassword(email, oldPassword, newPassword, log = () => {}, opts = {}) {
    if (IN_PROCESS()) return changeMailcomPasswordInProcess(email, oldPassword, newPassword, log, opts);
    return runMailcomBrowserTask({
        kind: "change-password",
        email,
        password: oldPassword,
        newPassword,
        opts,
        proxy: opts?.proxy || getMailProxy(),
    }, {log});
}

export const stopMailcomBrowserWorkers = () => mailcomBrowserWorkerRunner.stopAll();
/** 取邮箱验证码(注册/绑定用);支持 minTimestampMs 只取新码、excludeCode 排除旧码 */
export const getOtp = (email, opts) => getEmailVerificationCode(email, opts);

function isGoogleMailbox(mb) {
    if (!mb) return false;
    if (mb.provider === "google") return true;
    return /@(gmail|googlemail)\.com$/i.test(String(mb.email || ""));
}

/**
 * 拉收件箱列表。
 * - Gmail / google: 必须用 IMAP 应用专用密码（不是登录 mail.com）
 * - mail.com 等: Playwright 登录 maillist
 * 兼容旧调用: fetchInboxList(email, password, amount)
 * 新调用: fetchInboxList(mailboxRow | {email,password,provider,imap_password}, amount?)
 */
export async function fetchInboxList(emailOrMb, passwordOrAmount, amountMaybe) {
    // 对象形态
    if (emailOrMb && typeof emailOrMb === "object") {
        const mb = emailOrMb;
        const amount = Number(passwordOrAmount) || 30;
        if (isGoogleMailbox(mb)) {
            const imap = String(mb.imap_password || mb.mailbox_imap || "").trim();
            if (!imap) throw new Error("Gmail 没有 IMAP 应用专用密码，请先整备开通后再看收件箱");
            return fetchGmailImapInbox(mb.email, imap, amount);
        }
        if (IN_PROCESS()) return fetchMailcomInboxListInProcess(mb.email, mb.password, amount);
        const result = await runMailcomBrowserTask({
            kind: "inbox-list",
            email: mb.email,
            password: mb.password,
            amount,
            proxy: getMailProxy(),
        });
        return workerResultError(result, "mail.com 收件箱 worker 失败").mails || [];
    }
    // (email, password, amount) 旧签名: 按域名猜 provider
    const email = String(emailOrMb || "");
    const password = String(passwordOrAmount || "");
    const amount = Number(amountMaybe) || 20;
    if (/@(gmail|googlemail)\.com$/i.test(email)) {
        throw new Error("Gmail 收件箱请传完整 mailbox（含 imap_password），或先开通 IMAP 应用专用密码");
    }
    if (IN_PROCESS()) return fetchMailcomInboxListInProcess(email, password, amount);
    const result = await runMailcomBrowserTask({
        kind: "inbox-list",
        email,
        password,
        amount,
        proxy: getMailProxy(),
    });
    return workerResultError(result, "mail.com 收件箱 worker 失败").mails || [];
}

/**
 * 拉单封正文。
 * - Gmail: IMAP UID；需 imapPassword 或缓存会话
 * - mail.com: 在独立 worker 内建立短生命周期 maillist 会话
 * 兼容: fetchMailBodyFor(email, mailId) | fetchMailBodyFor(mb, mailId)
 */
export async function fetchMailBodyFor(emailOrMb, mailId, imapPassword = "") {
    if (emailOrMb && typeof emailOrMb === "object") {
        const mb = emailOrMb;
        if (isGoogleMailbox(mb)) {
            const imap = String(mb.imap_password || mb.mailbox_imap || imapPassword || "").trim();
            if (!imap) throw new Error("Gmail 没有 IMAP 应用专用密码");
            return fetchGmailImapBody(mb.email, mailId, imap);
        }
        if (IN_PROCESS()) return fetchMailcomBodyForInProcess(mb.email, mailId);
        const result = await runMailcomBrowserTask({
            kind: "inbox-body",
            email: mb.email,
            password: mb.password,
            mailId,
            proxy: getMailProxy(),
        });
        return workerResultError(result, "mail.com 正文 worker 失败").body || "";
    }
    const email = String(emailOrMb || "");
    if (/@(gmail|googlemail)\.com$/i.test(email)) {
        if (!imapPassword) throw new Error("Gmail 正文需要 IMAP 应用专用密码");
        return fetchGmailImapBody(email, mailId, imapPassword);
    }
    if (IN_PROCESS()) return fetchMailcomBodyForInProcess(email, mailId);
    throw new Error("mail.com 正文需要完整 mailbox（含密码）");
}

// 发件人:Anthropic/Claude 官方(禁用/封号通知一般来自 @anthropic.com)
const CLAUDE_SENDER_RE = /anthropic|claude/i;
// 禁用/封号语义:主题或正文命中即视为禁用通知。通用正则先上,命中主题会回传供人工核对,后续可按真实样本收紧。
const CLAUDE_DISABLED_RE = /(account|access)\b[^.]{0,48}(disabled|deactivat|suspend|terminat|banned?|blocked|closed|restrict)|violat\w*[^.]{0,24}(usage|acceptable|polic)|we('ve| have)\s+(disabled|suspended|deactivated|closed|banned|terminated)\s+your|(帐|账)号[^。]{0,20}(禁用|封禁|停用|冻结|已封|受限)|违反[^。]{0,20}(使用|政策|条款)/i;
/**
 * 扫描邮箱收件箱,查找 Anthropic/Claude 发来的账号禁用/封号通知邮件。
 * 轻量:先按发件人/主题筛候选,主题命中直接判定,否则在 worker 内取正文再判。
 * @returns {hit:true, subject, from, via} 命中禁用通知 | {hit:false, scanned} 未命中
 */
export async function scanClaudeDisabledMail(email, password, {amount = 30, log = () => {}, mailbox = null} = {}) {
    let mb = mailbox;
    if (!mb) {
        try { mb = await db.getMailboxByEmail(email); } catch { /* */ }
    }
    if (!mb) {
        mb = {email, password, provider: /@(gmail|googlemail)\.com$/i.test(email) ? "google" : "mailcom"};
    } else if (password && !mb.password) {
        mb = {...mb, password};
    }
    const mails = await fetchInboxList(mb, amount);
    const candidates = (Array.isArray(mails) ? mails : []).filter((m) => CLAUDE_SENDER_RE.test(`${m.from || ""} ${m.subject || ""}`));
    log(`收件箱 ${Array.isArray(mails) ? mails.length : 0} 封,其中 Anthropic/Claude 相关 ${candidates.length} 封`);
    for (const m of candidates) {
        if (CLAUDE_DISABLED_RE.test(m.subject || "")) return {hit: true, subject: m.subject || "", from: m.from || "", via: "subject"};
        let body = "";
        try { body = await fetchMailBodyFor(mb, m.id); } catch { /* 正文取不到就跳过该封 */ }
        if (body && CLAUDE_DISABLED_RE.test(body)) return {hit: true, subject: m.subject || "", from: m.from || "", via: "body"};
    }
    return {hit: false, scanned: candidates.length};
}
