# mail.com 充值发信问题详细报告

**对象账号：** `juanita_cupiditatewgu@mail.com`（mailbox id `3006`）  
**收件测试：** `wangguodong194@163.com`  
**日期：** 2026-08-21  
**范围：** 充值「测试发信」发不出、以及「能收信不能发信」根因与修复实测  

---

## 1. 现象

充值面板测试发信日志大致为：

1. 从公共代理池复用粘性出口（`as.miyaip.online`）
2. `mail.com SMTP … 无跳板`
3. 约 5 秒后失败：`535 Authentication credentials invalid`
4. 汇总：`0 成功 / 1 失败`

同时该号收信正常（能拉到 ChatGPT/OpenAI 邮件），因此表现为 **能收不能发**。

---

## 2. 结论摘要

| 项目 | 结论 |
|------|------|
| 账号是否作废 | **否**。网页登录、收信、CATS 发信均可 |
| 原发信失败直接原因 | 走了 **SMTP**，`smtp.mail.com` 返回 **535 账密无效** |
| 官网真实发信方式 | **不是 SMTP**，是 CATS `mailsubmission` + OAuth Bearer |
| 为何能收不能发 | 收信走网页登录/maillist；发信误走 SMTP，两条鉴权路径不同 |
| 修复后状态 | 已改为 CATS worker 发信；API 实测 **HTTP 202 成功** |

一句话：**不是代理把信挡了，也不是号完全废了，是实现选错了发信协议。**

---

## 3. 代码与官网协议对照

### 3.1 官网真实发信（HAR / 网页源码）

来自 `发送 1navigator-lxa.mail.com.har` 的关键请求：

```http
POST https://webmail-cats-live.mail.com/mailbox/primary/mailsubmission?absoluteURI=false&no_cache=...
Authorization: Bearer <mail_mailbox_w>
Content-Type: application/vnd.ui.trinity.minimalmailmessage+json
x-ui-app: mailcom.webmailer.mail-compose/1.43.6
```

body 形态：

```json
{
  "mailHeader": {
    "messageType": "MAIL",
    "from": "\"Display Name\" <xxx@mail.com>",
    "to": ["wangguodong194@163.com"],
    "subject": "...",
    "date": 1787007055878
  },
  "htmlBody": "<html>...</html>",
  "plaintextBody": null,
  "mailClientMeta": {"mail-drop": "[]"},
  "transientMailProperties": {}
}
```

成功响应：**HTTP 202**。

鉴权链路：

1. 网页登录拿到 `sid/navsid`
2. `oauthbridge.navigator-lxa.mail.com/navigator/oauth2/token` 换 `mail_mailbox_w`
3. 调 CATS `mailsubmission`

**全程不经过 `smtp.mail.com`，也不做 SMTP `AUTH LOGIN`。**

### 3.2 仓库里已有的正确实现

`src/mail/mailcom.ts` → `sendMailcomMail()`  
注释与实现都按 CATS `mailsubmission` 写，和 HAR 一致。

### 3.3 出问题前充值实际走的路径

```
delivered-mail-service.testSendDelivered
  → sendMailcomBatch
    → sendMailcomViaPool
      → sendMailcomSmtp          // smtp.mail.com:465
        → AUTH LOGIN(email, mailboxes.password)
```

`scripts/worker-mail-send.ts` 文件头还写着 Playwright，实现却已改成 SMTP。

预览逻辑只检查「库里有没有 password」，**不会先验 SMTP / CATS 是否真能登。**

---

## 4. 实测结果（同一账号）

### 4.1 收信

- 接口：`GET /api/mailboxes/3006/inbox`
- 结果：`HTTP 200`，约 **17** 封
- 样例：OpenAI sign-in、ChatGPT 临时登录代码等
- 路径：mail.com 浏览器 worker（与发信 SMTP 无关）
- 说明：当前收信 worker 实际近似 **直连网页登录 + maillist**，不是 SMTP/IMAP

### 4.2 SMTP 发信

- 实现：`sendMailcomSmtp` → `smtp.mail.com:465` + `AUTH LOGIN`
- 代理：账号粘性出口（与线上一致时可无跳板）
- 结果：**失败**  
  `mail.com SMTP 被拒: 535 Authentication credentials invalid`
- 含义：TCP/TLS/代理已通到 AUTH，是 **账密被 SMTP 拒绝**，不是超时或代理连不上

库内密码元数据（不暴露明文）：

- 有密码，长度 20，纯 ASCII，无空白
- `pw_status = ✅已改 08-10 22:34(验证)`
- 该「验证」是 **网页改密后再网页登录**，不是 SMTP 验证

### 4.3 CATS 网页发信（直连）

- 实现：`sendMailcomMail` / `worker-mail-send.mjs`
- 结果：**成功**，`status: 202`
- location 形如：`Mailsubmission/-1/<trinity-...@trinity-msg-rest-gmx-mailcom-live-...>`
- 证明：库内密码对 **网页登录 + compose token + mailsubmission** 有效

### 4.4 正式 API 发信（修复后）

- 接口：`POST /api/mailcom/send`
- 结果：

```json
{
  "ok": true,
  "status": 202,
  "from": "juanita_cupiditatewgu@mail.com",
  "to": "wangguodong194@163.com",
  "subject": "API-CATS最终测通 ..."
}
```

服务日志可见：登录成功 → mint list/compose token → 提交成功。

---

## 5. 为什么「能收信不能发信」

| 能力 | 协议 | 鉴权 | 当时结果 |
|------|------|------|----------|
| 收信 | 网页登录 + maillist API | sid / mailbox_r token | 通 |
| 发信（旧） | SMTP 465 | 邮箱密码 AUTH LOGIN | 535 |
| 发信（官网/新） | CATS mailsubmission | sid + mailbox_w Bearer | 通 |

因此：

- 收信通 **不能** 推出 SMTP 通
- SMTP 535 **不能** 推出网页发信不通
- `navigator_lxa.mail.com` 源码/HAR 对应的是 CATS，不是 SMTP

---

## 6. 代理相关发现（次要，但影响稳定性）

1. 旧日志里 SMTP 已连上并返回 535 → **不是代理导致那次失败**
2. CATS + **带账密住宅代理** 的本机 socks 转发环，在本机多次出现：
   - 卡在「发信链式 / Chrome 启动」
   - worker RSS 冲到约 **25–35GB**
   - 事件循环被拖死，超时也不干净
3. 收信能通，很大程度是因为收信 worker **并未强制走该粘性账密代理**（更接近直连）
4. 因此修复后默认：`MAILCOM_SEND_DIRECT=1`
   - 浏览器 CATS **直连发信**（已测通）
   - 粘性出口仍记账，供以后代理链路修好再启用

要强制走代理：启动时设 `MAILCOM_SEND_DIRECT=0`（当前代理链路仍可能卡死，需另修）。

---

## 7. 已做代码改动

1. **`scripts/worker-mail-send.ts`**  
   改回调用 `sendMailcomMail`（CATS），不再调 SMTP

2. **`server/domain/mailcom-send-service.ts`**  
   - `sendMailcomViaPool` 改为 `mailSendWorkerRunner.run(...)`  
   - 日志从 `mail.com SMTP` 改为 `mail.com CATS`  
   - 默认直连浏览器发信（`MAILCOM_SEND_DIRECT`，默认 `1`）  
   - 直连模式下跳过会误杀流程的出口 TCP 预检

3. **`src/mail/mailcom.ts`**  
   - 拆出 `sendMailcomMailOnce`  
   - 代理失败时可降级直连  
   - 去掉会卡死事件循环的浏览器代理 TCP 预检

4. **构建**  
   workers 对 `playwright` / `pg` 做 external，避免错误打包

主进程仍禁止起本地 socks relay（`CODEX_HTTP=1` + `assertRelayAllowed`），CATS 必须在 worker 子进程跑——这点设计是对的。

---

## 8. 当时运行状态

- 后端：`http://localhost:3100`，`ready: true`
- 启动参数含：`MAILCOM_HEADLESS=1`、`MAIL_JOBS_PAUSED=1`、`SKIP_STARTUP_RECOVERY=1`、`MAILCOM_SEND_DIRECT=1`
- 前端 Vite：`http://localhost:5173`（若仍在跑）

建议在 163 邮箱确认是否收到主题类似：

- `CATS直连测通 ...`
- `API-CATS最终测通 ...`

---

## 9. 风险与后续建议

### 已解决

- 充值/测试发信协议错误（SMTP → CATS）
- 该账号「能收不能发」的误解
- API 层 CATS 发信实测成功

### 未彻底解决

- **住宅代理 + Playwright 本地转发环** 仍不稳定（高 RSS / 卡死）
- SMTP 对本账号仍 535；若业务上还要 SMTP，需另查 mail.com 是否禁用客户端 SMTP，或是否要用别的客户端密码（与网页密码不是一回事）

### 建议下一步

1. 充值批量测试发信再跑几封，确认控制台路径同样 202  
2. 单独排期修「账密 socks → 本机无账密转发 → Chrome」卡死问题，再关 `MAILCOM_SEND_DIRECT`  
3. 预览接口增加更明确的 `via: cats` 说明，避免再误以为是 SMTP  
4. 不要再用 SMTP 535 判断 mail.com 号是否可用

---

## 10. 证据索引

| 证据 | 内容 |
|------|------|
| HAR | `webmail-cats-live.mail.com/.../mailsubmission` → 202 |
| DB | mailbox `3006` 有密码；`pw_status` 仅表示网页改密验证 |
| SMTP 实测 | 535 Authentication credentials invalid |
| 收信实测 | inbox 17 封，200 |
| CATS 实测 | worker 直连 202；`/api/mailcom/send` 202 |
| 旧实现 | `sendMailcomViaPool` → `sendMailcomSmtp` |
| 新实现 | `sendMailcomViaPool` → `mailSendWorkerRunner` → `sendMailcomMail` |

---

## 11. 总评

问题本质是 **发信协议选错**。按官网 CATS 发信后，该号可正常发出；SMTP 535 是另一条失败路径，不能代表网页发信能力。
