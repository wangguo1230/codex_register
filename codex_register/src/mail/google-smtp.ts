// Gmail 应用专用密码 SMTP（465）。给已交付测试发信用，不走网页。
import tls from "node:tls";

function b64(s: string) {
    return Buffer.from(s, "utf8").toString("base64");
}

function rfc2047(s: string) {
    if (/^[\x20-\x7e]*$/.test(s)) return s;
    return `=?UTF-8?B?${b64(s)}?=`;
}

export async function sendGmailSmtp({
    email, appPassword, to, subject, text, html, fromName, timeoutMs = 25000,
}: {
    email: string;
    appPassword: string;
    to: string | string[];
    subject: string;
    text?: string;
    html?: string;
    fromName?: string;
    timeoutMs?: number;
}) {
    const user = String(email || "").trim();
    const pass = String(appPassword || "").replace(/\s+/g, "");
    const rcpts = (Array.isArray(to) ? to : [to]).map((x) => String(x || "").trim()).filter(Boolean);
    if (!user || !pass) throw new Error("Gmail SMTP 缺少邮箱或应用密码");
    if (!rcpts.length) throw new Error("Gmail SMTP 缺少收件人");

    const fromHdr = fromName ? `"${String(fromName).replace(/"/g, "")}" <${user}>` : user;
    const boundary = `b${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    const plain = String(text || "").replace(/\r?\n/g, "\r\n");
    const rich = String(html || `<html><body><pre>${plain.replace(/[&<>]/g, (c) => ({"&": "&amp;", "<": "&lt;", ">": "&gt;"}[c]))}</pre></body></html>`).replace(/\r?\n/g, "\r\n");
    const data = [
        `From: ${fromHdr}`,
        `To: ${rcpts.join(", ")}`,
        `Subject: ${rfc2047(String(subject || "test"))}`,
        "MIME-Version: 1.0",
        `Content-Type: multipart/alternative; boundary="${boundary}"`,
        "",
        `--${boundary}`,
        "Content-Type: text/plain; charset=utf-8",
        "Content-Transfer-Encoding: 8bit",
        "",
        plain,
        `--${boundary}`,
        "Content-Type: text/html; charset=utf-8",
        "Content-Transfer-Encoding: 8bit",
        "",
        rich,
        `--${boundary}--`,
        "",
    ].join("\r\n");

    return new Promise<{ok: true; status: number}>((resolve, reject) => {
        const sock = tls.connect({host: "smtp.gmail.com", port: 465, servername: "smtp.gmail.com"}, () => {});
        const timer = setTimeout(() => fail(new Error("Gmail SMTP 超时")), timeoutMs);
        let buf = "";
        const fail = (e: Error) => {
            clearTimeout(timer);
            try { sock.destroy(); } catch { /* */ }
            reject(e);
        };
        const send = (line: string) => sock.write(line + "\r\n");
        const steps = [
            {expect: /^220/, write: "EHLO localhost"},
            {expect: /^250/m, write: "AUTH LOGIN"},
            {expect: /^334/, write: b64(user)},
            {expect: /^334/, write: b64(pass)},
            {expect: /^235/, write: `MAIL FROM:<${user}>`},
            {expect: /^250/, write: `RCPT TO:<${rcpts[0]}>`},
            ...rcpts.slice(1).map((r) => ({expect: /^250/, write: `RCPT TO:<${r}>`})),
            {expect: /^250/, write: "DATA"},
            {expect: /^354/, write: `${data}\r\n.`},
            {expect: /^250/, write: "QUIT"},
        ];
        let i = 0;
        sock.setEncoding("utf8");
        sock.on("data", (chunk) => {
            buf += chunk;
            if (!/\r\n$/.test(buf) && !buf.endsWith("\n")) return;
            const last = buf.trim().split(/\r?\n/).filter(Boolean).pop() || "";
            const step = steps[i];
            if (!step) return;
            if (!step.expect.test(last) && !step.expect.test(buf)) {
                fail(new Error(`Gmail SMTP 被拒: ${last.slice(0, 160)}`));
                return;
            }
            buf = "";
            send(step.write);
            i += 1;
            if (i >= steps.length) {
                clearTimeout(timer);
                try { sock.end(); } catch { /* */ }
                resolve({ok: true, status: 250});
            }
        });
        sock.on("error", (e) => fail(e instanceof Error ? e : new Error(String(e))));
        sock.on("end", () => {
            if (i < steps.length) fail(new Error("Gmail SMTP 连接中断"));
        });
    });
}
