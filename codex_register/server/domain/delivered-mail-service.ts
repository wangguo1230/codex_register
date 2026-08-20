// @ts-nocheck
import * as db from "../db.js";
import {
    buildTestMailContent,
    isGmailAddress,
    isMailcomAddress,
    looksRebound,
    refundSenderOf,
} from "./mail-send-policy.js";
import {sendMailcomBatch} from "./mail-send-batch-service.js";

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
        const mailcom = isMailcomAddress(from);
        const gmail = isGmailAddress(from);
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
        if (isGmailAddress(row.from)) {
            try {
                const {sendGmailSmtp} = await import("../../src/mail/google-smtp.js");
                log(`Gmail SMTP ${row.from} → ${to}`);
                let proxyUrl = "";
                let jumpUrl = "";
                const send = () => sendGmailSmtp({
                    email: row.from,
                    appPassword: mb?.imap_password,
                    to,
                    fromName: String(row.from).split("@")[0],
                    subject: mail.subject,
                    text: opts.text || mail.text,
                    html: opts.html || mail.html,
                    proxy: proxyUrl,
                    jump: jumpUrl,
                });
                const r = typeof opts.withProxy === "function"
                    ? await opts.withProxy(`smtp:${row.from}`, async (exit, jump) => {
                        proxyUrl = String(exit || "").trim();
                        jumpUrl = String(jump || "").trim();
                        log(`Gmail SMTP ${row.from} 使用代理 ${proxyUrl ? "已租用" : "直连"}`);
                        return send();
                    }, mb)
                    : await send();
                results.push({id: row.id, email: row.queueEmail, from: row.from, ok: true, skipped: false, error: "", status: r.status, via: "gmail-smtp", proxyUrl, jumpUrl});
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
            const error = one.error || (one.ok ? "" : "worker 未返回失败原因");
            if (!one.ok) {
                log(`测试发信 ${src.email} 失败: ${error}`);
            }
            results.push({
                id: src._id,
                email: src._queueEmail,
                from: src.email,
                ok: !!one.ok,
                skipped: false,
                error,
                proxySession: one.proxySession || "",
                status: one.status || 0,
                via: "mail.com",
            });
        }
    }
    const failedItems = results.filter((x) => !x.ok && !x.skipped);
    return {
        ok: results.some((x) => x.ok),
        to,
        sent: results.filter((x) => x.ok).length,
        failed: failedItems.length,
        skipped: results.filter((x) => x.skipped).length,
        error: failedItems.map((x) => `${x.email || x.from || "未知账号"}: ${x.error || "未知发信错误"}`).join(" | ").slice(0, 1000),
        items: results,
        preview: preview.items,
    };
}
