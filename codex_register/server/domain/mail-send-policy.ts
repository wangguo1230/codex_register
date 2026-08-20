// @ts-nocheck
import {maskProxyUrl} from "../../src/mail/proxy-pool.js";

export function publicMailSendLog(row) {
    const url = String(row?.proxy_url || "");
    return {
        ...row,
        proxy_url: url ? maskProxyUrl(url) : "",
        jump_url: row?.jump_url ? maskProxyUrl(row.jump_url) : "",
    };
}

export function isMailcomAddress(email) {
    return /@mail\.com$/i.test(String(email || ""));
}

export function isGmailAddress(email) {
    return /@(gmail|googlemail)\.com$/i.test(String(email || ""));
}

export function looksRebound(queueItem) {
    const current = String(queueItem?.email || "").trim().toLowerCase();
    const from = String(queueItem?.rebind_from || "").trim().toLowerCase();
    const to = String(queueItem?.rebind_email || "").trim().toLowerCase();
    if (from && from !== current) return true;
    if (queueItem?.rebind_status === "ok") return true;
    return !!(to && to === current && from && from !== current);
}

/** 换绑过必须用原始邮箱发；没换绑才用当前邮箱。 */
export function refundSenderOf(queueItem) {
    const from = String(queueItem?.rebind_from || "").trim().toLowerCase();
    if (from) return from;
    if (looksRebound(queueItem)) return "";
    return String(queueItem?.email || "").trim().toLowerCase();
}

export function buildTestMailContent({from, to, subject} = {}) {
    const stamp = new Date().toISOString().replace("T", " ").slice(0, 19);
    const normalizedSubject = String(subject || `退款测试邮件 ${stamp.slice(11)}`);
    const text = `这是一封测试邮件，用来验证 mail.com 协议发信。\n发件：${from || ""}\n收件：${to || ""}\n时间：${stamp}\n\n正式退款正文稍后单独补充。`;
    const html = `<html><body style="font-family:sans-serif;font-size:14px;line-height:1.6">
<p>这是一封<strong>测试邮件</strong>，用来验证 mail.com 协议发信。</p>
<p>发件：${String(from || "").replace(/</g, "&lt;")}<br/>收件：${String(to || "").replace(/</g, "&lt;")}<br/>时间：${stamp}</p>
<p>正式退款正文稍后单独补充。</p>
</body></html>`;
    return {subject: normalizedSubject, text, html};
}
