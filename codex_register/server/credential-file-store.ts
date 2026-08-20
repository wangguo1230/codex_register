// @ts-nocheck
// Worker 凭证文件适配器：兼容数据库 JSONB 优先、文件回退和邮箱单行凭证格式。
import {mkdirSync, readFileSync, writeFileSync} from "node:fs";
import path from "node:path";

export function createCredentialFileStore({readFile = readFileSync, writeFile = writeFileSync, rtDir = ""} = {}) {
    function readJson(file) {
        try { return file ? JSON.parse(readFile(file, "utf8")) : null; } catch { return null; }
    }

    function readAuth(account) {
        return account?.auth_data || readJson(account?.auth_file);
    }

    function readRt(account) {
        return account?.rt_data || readJson(account?.rt_file);
    }

    function writeMailbox(file, record) {
        writeFile(file, [
            record?.email || "",
            record?.password || "",
            record?.mailboxTotp || record?.mailbox_totp || record?.totp_secret || "",
            record?.recoveryEmail || record?.recovery_email || "",
            record?.imapPassword || record?.mailbox_imap || record?.imap_password || "",
        ].join("----") + "\n", "utf8");
    }

    function writeJson(file, data) {
        writeFile(file, JSON.stringify(data) + "\n", "utf8");
    }

    function writeRtForAccount(accountId, data) {
        const dir = String(rtDir || "").trim();
        if (!dir) return "";
        const id = Number(accountId);
        if (!Number.isInteger(id) || id <= 0 || !data) return "";
        mkdirSync(dir, {recursive: true});
        const file = path.join(dir, `${id}.json`);
        writeJson(file, data);
        return file;
    }

    return {readJson, readAuth, readRt, writeMailbox, writeJson, writeRtForAccount};
}
