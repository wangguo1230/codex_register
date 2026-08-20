// 邮箱导入文本解析：只负责格式归一化，不访问数据库或调度器。

function escapeRegExp(value = "") {
    return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isValidEmail(value = "") {
    return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value);
}

export function parseMailboxAccounts(text, {
    separator = "----",
    fallbackPassword = "",
    straighten = (value) => value,
    isEmail = isValidEmail,
} = {}) {
    const delimiter = separator || "----";
    const delimiterPattern = new RegExp(escapeRegExp(delimiter));
    const rows = [];
    for (const raw of String(text || "").split(/\r?\n/)) {
        const line = raw.trim();
        if (!line) continue;
        let parts = line.includes(delimiter) ? line.split(delimiterPattern).map((item) => item.trim()) : [];
        if (parts.filter(Boolean).length < 2 && line.includes("----")) {
            parts = line.split("----").map((item) => item.trim());
        }
        if (parts.filter(Boolean).length < 2) {
            parts = line.split(/[\s,;|\t]+/).map((item) => item.trim()).filter(Boolean);
        }
        const email = String(parts[0] || "").toLowerCase();
        const password = parts[1] || fallbackPassword || "";
        if (!isValidEmail(email) || !password) continue;

        let recoveryEmail = "";
        let totpSecret = "";
        if (parts.length >= 4) {
            recoveryEmail = parts[2] || "";
            totpSecret = parts[3] || "";
        } else if (parts.length === 3) {
            if (isEmail(parts[2])) recoveryEmail = parts[2];
            else totpSecret = parts[2] || "";
        }
        const normalized = straighten({totp_secret: totpSecret, recovery_email: recoveryEmail});
        rows.push({
            email,
            password,
            totp_secret: normalized.totp_secret || "",
            recovery_email: normalized.recovery_email || "",
        });
    }
    return rows;
}

export function extractMailboxEmails(text, {separator = "----"} = {}) {
    const delimiter = separator || "----";
    const delimiterPattern = new RegExp(escapeRegExp(delimiter));
    const emails = [];
    const seen = new Set();
    const push = (raw) => {
        const email = String(raw || "").trim().toLowerCase().replace(/^[<"'\[]+|[>"'\]]+$/g, "");
        if (isValidEmail(email) && !seen.has(email)) {
            seen.add(email);
            emails.push(email);
        }
    };
    for (const raw of String(text || "").split(/\r?\n/)) {
        const line = raw.trim();
        if (!line) continue;
        let head = "";
        if (line.includes(delimiter)) head = line.split(delimiterPattern)[0];
        else if (line.includes("----")) head = line.split("----")[0];
        else head = line.split(/[\s,;:|\t]+/)[0] || "";
        push(head);
        for (const match of line.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g) || []) push(match);
    }
    return emails;
}
