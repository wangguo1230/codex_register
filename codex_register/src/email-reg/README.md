# email-reg — 纯邮箱注册模块

把「不用手机、只用邮箱注册 ChatGPT 账号」这条链路新增/修复的逻辑，从 `openai.ts` /
`mail/hotmail.ts` / `mailbox.ts` 抽出来集中到这里。原文件改成 import 引用，行为不变。

## 背景

仓库现成的批量脚本（`codex.sh` 等）走的是 `--phone` 手机优先注册。codex_register 里其实
还有一条**纯邮箱**路径（模式 3 = 默认 / `--at`，对应 `OpenAIClient.authRegisterHTTP`），
但它是上游原版、从没在当前 chatgpt.com 流程下验证过，开箱即坏。本模块就是让它跑通、并让
产出的 auth 文件信息自包含。

跑纯邮箱注册：

```sh
cd codex_register
npm run dev -- --at --n 1          # 自动从 hotmail 池取邮箱，注册并存 auth 文件
npm run dev -- --email a@b.com --at
```

前提：`codex_register/hotmail/tokens.txt`（或 `HOTMAIL_TOKENS_FILE`）里有可用邮箱卡密用于
收验证码。

## 三块逻辑

| 文件 | 作用 | 原位置 |
|---|---|---|
| `nextauth-csrf.ts` | boot 后预取 `/api/auth/csrf`，让 NextAuth set `__Host-next-auth.csrf-token` cookie | `openai.ts` `bootChatGPTSession` |
| `mailbox-credential.ts` | 邮箱接码凭据类型 `MailboxCredential` + `----` 行格式化 | `mailbox.ts` 类型 / `hotmail.ts` 拼接 |
| `auth-record.ts` | auth 文件记录构造：`session` 完整格式 + `mailbox` 接码凭据 + JWT 兜底 | `openai.ts` `saveChatGPTAccessToken` |

### 1. NextAuth csrf 预取（让纯邮箱注册能开门）

chatgpt.com 首页（`GET /`）现在只下发 `oai-did`，不再 set NextAuth 的
`__Host-next-auth.csrf-token`。纯邮箱注册第 3 步 `openSignupPage` 走 chatgpt.com 的
`/api/auth/signin/openai`，必须带 csrfToken；不预取就会卡在
「未找到 `__Host-next-auth.csrf-token`，无法打开注册页」。

### 2. 邮箱接码凭据

注册用的邮箱常是底层 hotmail 账号的别名，真正能接码（重新登录/读收件箱取 OTP）的是底层
账号那条 `login----password----clientId----refreshToken`。`getMailboxCredential(email)` 把它
取回并写进 auth 文件的 `mailbox` 字段。

### 3. auth 文件格式

写到 `codex_register/auth/at/<date>-<email>.json`：

```jsonc
{
  "email": "...",
  "session": { /* /api/auth/session 完整原始响应 */
    "WARNING_BANNER": "...", "user": {...}, "expires": "...",
    "account": {"id": "...", "planType": "...", ...},
    "accessToken": "...", "authProvider": "openai", "sessionToken": "...", "rumViewTags": {...}
  },
  "mailbox": { "login": "...", "password": "...", "client_id": "...", "refresh_token": "...", "line": "...----...." },
  "cookie": "...",
  "last_refresh": "...",
  "type": "chatgpt"
}
```

`session` 优先用刚抓到的原始 payload；重登录 fallback 路径（本 client 没自己抓过 session）
则用 access_token 的 JWT claims 兜底重建一个最小 session 对象，保证字段结构一致。

## 已知限制

- 纯邮箱产出的是**网页端 token**（`client_id app_X8zY6vW2pQ9tR3dE7nK1jL5gH`），
  **无 refresh_token**，约 10 天后过期且无法自动续期。需要长期可续期的 codex 凭据，仍要走
  `--phone` 链路（产出 `app_EMoamEEZ73f0CkXaXp7hrann` + refresh_token）。
- 能否纯邮箱注册成功取决于 OpenAI 当时是否对该出口 IP 要求手机验证（服务端驱动）。
- 导出 sub2api 时，因 auth 文件把 token 放在 `.session` 内层，需先抽出 `.session` 再喂
  `tokens_to_sub2api.py`（或改脚本识别该嵌套结构）。
