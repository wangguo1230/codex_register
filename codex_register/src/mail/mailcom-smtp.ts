// mail.com 密码 SMTP（465）。发信不需要启动浏览器或获取网页 token。
import {sendSmtpMail} from "./smtp-client.js";

export function sendMailcomSmtp({
    email,
    password,
    to,
    subject,
    text,
    html,
    fromName,
    proxy = "",
    jump = "",
    timeoutMs = 25_000,
} = {}) {
    return sendSmtpMail({
        host: "smtp.mail.com",
        port: 465,
        email,
        password,
        to,
        subject,
        text,
        html,
        fromName,
        proxy,
        jump,
        timeoutMs,
        label: "mail.com SMTP",
    });
}
