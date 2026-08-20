// Gmail 应用专用密码 SMTP（465）。给已交付测试发信用，不走网页。
import {sendSmtpMail} from "./smtp-client.js";

export function sendGmailSmtp({
    email,
    appPassword,
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
        host: "smtp.gmail.com",
        port: 465,
        email,
        password: appPassword,
        to,
        subject,
        text,
        html,
        fromName,
        proxy,
        jump,
        timeoutMs,
        label: "Gmail SMTP",
    });
}
