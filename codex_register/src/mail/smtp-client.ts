// SMTP 通用客户端：465/TLS、AUTH LOGIN、纯文本+HTML 双格式和代理跳板。
import tls from "node:tls";
import {connectExitViaJump} from "./proxy-chain.js";

function b64(value: string) {
    return Buffer.from(value, "utf8").toString("base64");
}

function rfc2047(value: string) {
    return /^[\x20-\x7e]*$/.test(value) ? value : `=?UTF-8?B?${b64(value)}?=`;
}

function dotStuff(value: string) {
    return value.replace(/(^|\r\n)\./g, "$1..");
}

export function buildSmtpMime({from, to, subject, text = "", html = "", fromName = ""} = {}) {
    const displayName = String(fromName || "").replace(/"/g, "");
    const sender = displayName
        ? `${/^[\x20-\x7e]*$/.test(displayName) ? `"${displayName}"` : rfc2047(displayName)} <${from}>`
        : String(from || "");
    const recipients = (Array.isArray(to) ? to : [to]).map((item) => String(item || "").trim()).filter(Boolean);
    const plain = String(text || "").replace(/\r?\n/g, "\r\n");
    const rich = String(html || `<html><body><pre>${plain.replace(/[&<>]/g, (char) => ({"&": "&amp;", "<": "&lt;", ">": "&gt;"}[char]))}</pre></body></html>`)
        .replace(/\r?\n/g, "\r\n");
    const boundary = `b${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    return [
        `From: ${sender}`,
        `To: ${recipients.join(", ")}`,
        `Subject: ${rfc2047(String(subject || "test"))}`,
        "MIME-Version: 1.0",
        `Content-Type: multipart/alternative; boundary="${boundary}"`,
        "",
        `--${boundary}`,
        "Content-Type: text/plain; charset=utf-8",
        "Content-Transfer-Encoding: 8bit",
        "",
        dotStuff(plain),
        `--${boundary}`,
        "Content-Type: text/html; charset=utf-8",
        "Content-Transfer-Encoding: 8bit",
        "",
        dotStuff(rich),
        `--${boundary}--`,
        "",
    ].join("\r\n");
}

export async function sendSmtpMail({
    host,
    port = 465,
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
    label = "SMTP",
} = {}) {
    const server = String(host || "").trim();
    const user = String(email || "").trim();
    const pass = String(password || "");
    const recipients = (Array.isArray(to) ? to : [to]).map((item) => String(item || "").trim()).filter(Boolean);
    if (!server) throw new Error(`${label} 缺少 SMTP 主机`);
    if (!user || !pass) throw new Error(`${label} 缺少邮箱或密码`);
    if (!recipients.length) throw new Error(`${label} 缺少收件人`);

    const message = buildSmtpMime({from: user, to: recipients, subject, text, html, fromName});
    const rawSocket = String(proxy || "").trim()
        ? await connectExitViaJump(String(proxy).trim(), String(jump || "").trim(), server, Number(port))
        : null;

    return new Promise((resolve, reject) => {
        let settled = false;
        let timer;
        let buffer = "";
        let replyLines = [];
        let stepIndex = 0;
        const steps = [
            {expect: /^220(?:[ -]|$)/, write: "EHLO localhost"},
            {expect: /^250(?:[ -]|$)/, write: "AUTH LOGIN"},
            {expect: /^334(?:[ -]|$)/, write: b64(user)},
            {expect: /^334(?:[ -]|$)/, write: b64(pass)},
            {expect: /^235(?:[ -]|$)/, write: `MAIL FROM:<${user}>`},
            {expect: /^250(?:[ -]|$)/, write: `RCPT TO:<${recipients[0]}>`},
            ...recipients.slice(1).map((recipient) => ({expect: /^250(?:[ -]|$)/, write: `RCPT TO:<${recipient}>` })),
            {expect: /^250(?:[ -]|$)/, write: "DATA"},
            {expect: /^354(?:[ -]|$)/, write: `${message}\r\n.`},
            {expect: /^250(?:[ -]|$)/, write: "QUIT"},
        ];
        const fail = (error) => {
            if (settled) return;
            settled = true;
            if (timer) clearTimeout(timer);
            try { socket.destroy(); } catch { /* */ }
            reject(error instanceof Error ? error : new Error(String(error)));
        };
        const succeed = () => {
            if (settled) return;
            settled = true;
            if (timer) clearTimeout(timer);
            try { socket.end(); } catch { /* */ }
            resolve({ok: true, status: 250});
        };
        const send = (line) => {
            try { socket.write(`${line}\r\n`); }
            catch (error) { fail(error); }
        };
        const handleReply = (reply, lastLine) => {
            const step = steps[stepIndex];
            if (!step) return;
            if (!step.expect.test(lastLine) && !step.expect.test(reply)) {
                fail(new Error(`${label} 被拒: ${lastLine.slice(0, 160)}`));
                return;
            }
            stepIndex += 1;
            if (stepIndex >= steps.length) {
                succeed();
                return;
            }
            send(steps[stepIndex - 1].write);
        };
        const socket = rawSocket
            ? tls.connect({socket: rawSocket, servername: server})
            : tls.connect({host: server, port: Number(port), servername: server});
        timer = setTimeout(() => fail(new Error(`${label} 超时`)), Math.max(1_000, Number(timeoutMs) || 25_000));
        socket.setEncoding("utf8");
        socket.on("data", (chunk) => {
            buffer += String(chunk || "");
            while (true) {
                const end = buffer.indexOf("\r\n");
                if (end < 0) break;
                const line = buffer.slice(0, end);
                buffer = buffer.slice(end + 2);
                replyLines.push(line);
                if (/^\d{3} /.test(line)) {
                    const reply = replyLines.join("\n");
                    replyLines = [];
                    handleReply(reply, line);
                    if (settled) break;
                }
            }
        });
        socket.once("error", (error) => fail(error));
        socket.once("end", () => {
            if (!settled) fail(new Error(`${label} 连接中断`));
        });
    });
}
