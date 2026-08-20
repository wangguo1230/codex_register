// @ts-nocheck
// 账号凭证的无状态读取与文本格式化规则。

export function extractSession(data) {
    if (!data || typeof data !== "object") return null;
    return data.session !== undefined ? data.session : data;
}

export function readSessionFromFile(authFile, readJson) {
    return extractSession(readJson(authFile));
}

export function isGoogleMailbox(account) {
    return account?.provider === "google"
        || /@(gmail|googlemail)\.com$/i.test(String(account?.email || ""));
}

export function isMailcomMailbox(account) {
    if (isGoogleMailbox(account)) return false;
    const provider = String(account?.provider || "").toLowerCase();
    return provider === "mailcom" || provider === "mail.com" || provider === "";
}

export function isExportableAccount(account) {
    if (isGoogleMailbox(account) && String(account?.gpt_password || "").trim()) return true;
    return account?.status === "success" && !account?.dead_at;
}

export function formatAccountExportLine(account, {rt = "", sep = "----", withRt = false, withGpt = false} = {}) {
    const email = account.email || "";
    const mailPassword = account.password || account.mailPw || "";
    const mailboxTotp = String(account.mailbox_totp || account.mail2fa || "").trim();
    const imapPassword = String(account.mailbox_imap || account.imap_password || account.imap || "").trim();
    const gptPassword = String(account.gpt_password || "").trim();
    const gptTotp = String(account.totp_secret || account.gpt2fa || "").trim();
    const parts = isGoogleMailbox(account)
        ? [email, mailPassword, mailboxTotp]
        : [email, mailPassword, imapPassword];
    if (gptPassword || gptTotp || rt || withRt || withGpt) {
        parts.push(gptPassword, gptTotp);
        if (withRt || rt) parts.push(rt || "");
    }
    return parts.join(sep);
}
