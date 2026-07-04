/**
 * 纯邮箱注册（email-only registration）模块。
 *
 * 这次为「不用手机、只用邮箱注册 ChatGPT 账号」补的三块逻辑，从 openai.ts / hotmail.ts /
 * mailbox.ts 抽出来集中到这里，原文件改成 import 引用：
 *
 *  - nextauth-csrf   : boot 后预取 NextAuth csrf cookie（否则纯邮箱注册第 3 步就挂）
 *  - mailbox-credential : 邮箱接码凭据类型 + `----` 行格式化
 *  - auth-record     : auth 文件记录构造（session 完整格式 + 接码凭据 + JWT 兜底）
 *
 * 详见本目录 README.md。
 */
export {ensureNextAuthCsrf, type FetchFn} from "./nextauth-csrf.js";
export {
    type MailboxCredential,
    formatCredentialLine,
    buildHotmailCredential,
} from "./mailbox-credential.js";
export {
    buildAuthRecord,
    decodeJwtPayload,
    type AuthRecord,
    type SessionPayload,
    type AuthAccessClaims,
    type BuildAuthRecordInput,
} from "./auth-record.js";
