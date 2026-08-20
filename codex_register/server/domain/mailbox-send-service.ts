// @ts-nocheck
// 邮箱发信分发：只负责解析邮箱提供商，具体协议仍由各 provider 实现。
import * as db from "../db.js";
import {sendGmailSmtp} from "../../src/mail/google-smtp.js";
import {isGmailAddress, isMailcomAddress} from "./mail-send-policy.js";
import {sendMailcomViaPool} from "./mailcom-send-service.js";

const defaultStore = {
    getMailbox: (id) => db.getMailbox(id),
    getMailboxByEmail: (email) => db.getMailboxByEmailAny(email),
    insertLog: (row) => db.insertMailSendLog(row),
    appendMailboxLog: (id, line) => db.appendMailboxLog(id, line),
};

function recipientsOf(value) {
    return (Array.isArray(value) ? value : [value])
        .map((item) => String(item || "").trim().toLowerCase())
        .filter(Boolean);
}

function providerOf(mailbox, email) {
    const provider = String(mailbox?.provider || "").toLowerCase();
    if (provider === "google" || provider === "gmail" || isGmailAddress(email)) return "gmail";
    if (provider === "mailcom" || isMailcomAddress(email)) return "mailcom";
    return "";
}

export function createMailboxSendService({
    store = defaultStore,
    sendMailcom = sendMailcomViaPool,
    sendGmail = sendGmailSmtp,
    now = () => Date.now(),
} = {}) {
    async function writeLog(row) {
        try { await store.insertLog(row); } catch { /* 发信结果不能被日志故障覆盖 */ }
    }

    return async function sendMailbox(opts: any = {}) {
        let mailbox = opts.mailbox || null;
        if (!mailbox && opts.mailboxId) mailbox = await store.getMailbox(Number(opts.mailboxId));
        if (!mailbox && opts.email) mailbox = await store.getMailboxByEmail(String(opts.email));

        const email = String(mailbox?.email || opts.email || "").trim().toLowerCase();
        const to = recipientsOf(opts.to);
        if (!email) throw new Error("请选择发件邮箱");
        if (!mailbox) throw new Error(`邮箱库中不存在 ${email}`);
        if (!to.length) throw new Error("请填写收件人");

        const provider = providerOf(mailbox, email);
        if (provider === "mailcom") {
            const result = await sendMailcom({...opts, mailbox, email, to});
            return {...result, via: "mail.com"};
        }
        if (provider !== "gmail") throw new Error(`暂不支持该发件邮箱: ${email}`);

        const appPassword = String(opts.appPassword || mailbox.imap_password || "").trim();
        if (!appPassword) throw new Error(`Gmail ${email} 缺少 IMAP 应用专用密码`);
        const subject = String(opts.subject || "");
        const baseLog = {
            mailbox_id: Number(mailbox.id || 0),
            email,
            to_email: to.join(","),
            subject,
            proxy_url: "",
            proxy_session: "",
            proxy_ip: "",
            jump_url: "",
            reused: 0,
            created_at: now(),
        };
        let proxyUrl = "";
        let jumpUrl = "";
        try {
            const send = () => sendGmail({
                    email,
                    appPassword,
                    to,
                    subject,
                    text: opts.text,
                    html: opts.html,
                    fromName: opts.fromName,
                    proxy: proxyUrl,
                    jump: jumpUrl,
                });
            const result = typeof opts.withProxy === "function"
                ? await opts.withProxy(`smtp:${email}`, async (exit, jump) => {
                    proxyUrl = String(exit || "").trim();
                    jumpUrl = String(jump || "").trim();
                    return send();
                }, mailbox)
                : await send();
            await writeLog({...baseLog, proxy_url: proxyUrl, jump_url: jumpUrl, status: "sent", http_status: Number(result?.status || 250), location: "", error: ""});
            if (mailbox.id) {
                await store.appendMailboxLog(mailbox.id, `[发信] Gmail SMTP 成功 → ${to.join(",")}${proxyUrl ? ` 代理=${proxyUrl}` : " 直连"}`).catch(() => {});
            }
            return {ok: true, status: Number(result?.status || 250), from: email, to, via: "gmail-smtp", proxyUrl, jumpUrl};
        } catch (error) {
            const message = String(error?.message || error).slice(0, 300);
            await writeLog({...baseLog, proxy_url: proxyUrl, jump_url: jumpUrl, status: "fail", http_status: 0, location: "", error: message});
            if (mailbox.id) {
                await store.appendMailboxLog(mailbox.id, `[发信] Gmail SMTP 失败 ${message.slice(0, 160)}${proxyUrl ? ` 代理=${proxyUrl}` : " 直连"}`).catch(() => {});
            }
            throw error;
        }
    };
}

export const sendMailboxViaProvider = createMailboxSendService();
