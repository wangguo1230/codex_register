// @ts-nocheck
// 邮箱域统一服务(架构 v2:职责归一化的邮箱域入口)
//   - 资源池:按 usage(free/gpt/claude)查询/统计 + CAS 隔离分配(★不能串)
//   - 邮箱能力:登录验证/收信/取OTP/改密 —— 委托底层 provider(当前全为 mailcom)
// 设计:上层(server/scheduler)只依赖本服务,不再直接 import 具体 provider 文件,满足 DIP。
//   将来接入多 provider 时,在此按 mailbox.provider 路由,上层无感。
import * as db from "../db.js";
import {
    changeMailcomPassword,
    verifyMailcomLogin,
    fetchInboxList,
    fetchMailBodyFor,
    setMailProxy,
    getMailProxy,
} from "../../src/mail/mailcom.js";
import {getEmailVerificationCode} from "../../src/mailbox.js";

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

// ---- 邮箱能力(委托 provider;函数名保持稳定,便于上层平滑切换到本服务) ----
export {changeMailcomPassword, verifyMailcomLogin, fetchInboxList, fetchMailBodyFor, setMailProxy, getMailProxy};
/** 取邮箱验证码(注册/绑定用);支持 minTimestampMs 只取新码、excludeCode 排除旧码 */
export const getOtp = (email, opts) => getEmailVerificationCode(email, opts);

// 发件人:Anthropic/Claude 官方(禁用/封号通知一般来自 @anthropic.com)
const CLAUDE_SENDER_RE = /anthropic|claude/i;
// 禁用/封号语义:主题或正文命中即视为禁用通知。通用正则先上,命中主题会回传供人工核对,后续可按真实样本收紧。
const CLAUDE_DISABLED_RE = /(account|access)\b[^.]{0,48}(disabled|deactivat|suspend|terminat|banned?|blocked|closed|restrict)|violat\w*[^.]{0,24}(usage|acceptable|polic)|we('ve| have)\s+(disabled|suspended|deactivated|closed|banned|terminated)\s+your|(帐|账)号[^。]{0,20}(禁用|封禁|停用|冻结|已封|受限)|违反[^。]{0,20}(使用|政策|条款)/i;
/**
 * 扫描邮箱收件箱,查找 Anthropic/Claude 发来的账号禁用/封号通知邮件。
 * 轻量(复用缓存会话,秒级):先按发件人/主题筛候选,主题命中直接判定,否则取正文再判。
 * @returns {hit:true, subject, from, via} 命中禁用通知 | {hit:false, scanned} 未命中
 */
export async function scanClaudeDisabledMail(email, password, {amount = 30, log = () => {}} = {}) {
    const mails = await fetchInboxList(email, password, amount);
    const candidates = (Array.isArray(mails) ? mails : []).filter((m) => CLAUDE_SENDER_RE.test(`${m.from || ""} ${m.subject || ""}`));
    log(`收件箱 ${Array.isArray(mails) ? mails.length : 0} 封,其中 Anthropic/Claude 相关 ${candidates.length} 封`);
    for (const m of candidates) {
        if (CLAUDE_DISABLED_RE.test(m.subject || "")) return {hit: true, subject: m.subject || "", from: m.from || "", via: "subject"};
        let body = "";
        try { body = await fetchMailBodyFor(email, m.id); } catch { /* 正文取不到就跳过该封 */ }
        if (body && CLAUDE_DISABLED_RE.test(body)) return {hit: true, subject: m.subject || "", from: m.from || "", via: "body"};
    }
    return {hit: false, scanned: candidates.length};
}
