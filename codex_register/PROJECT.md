# codex_register 项目说明(以当前代码为准, 2026-07-01 重整)

ChatGPT批量注册 + 管理控制台。用成品mailcom邮箱批量注册ChatGPT账号, 带Web控制台(注册/收信/接码/token测试/聊天养号)。

> 本文档以实际代码为准, 之前 memory 里的描述可能过时, 优先看这里。

## 运行

```bash
cd codex_register
./start-console.sh          # 或 npm run console (= tsx server/index.ts)
# → http://localhost:3100   首次自动 build 前端(web/)
```
- 端口 env `PORT`(默认3100)。前端改动: `cd web && npm run build`, 浏览器强刷(Cmd+Shift+R)。
- 后端改 `server/*.ts`: 需重启server。改 `src/worker-*.ts`/`src/simulate-chat.ts`/接码/token模块: worker每次新子进程读最新代码, **不用重启**。
- 纯CLI单跑: `npm run start` (= tsx src/index.ts --at --email xxx)。

## 技术栈 / 架构

- **后端** `server/`: Express + SSE, better-sqlite3。`index.ts`(REST+SSE+静态托管) / `scheduler.ts`(worker池调度) / `db.ts`(SQLite)。
- **前端** `web/`: React + Vite + Tailwind。`web/src/App.tsx`(控制台) + `web/src/api.ts`(REST+SSE封装)。
- **worker子进程**: 每个账号一个 `tsx src/worker-register.ts` 子进程, env传参, stdout `@@EVENT@@{json}` 回传结构化结果(result/progress)。聊天用 `src/worker-chat.ts`。
- **数据流**: 前端 → REST → scheduler spawn worker → worker跑注册/聊天 → @@EVENT@@ → scheduler/server 写db + SSE广播 → 前端表格实时更新。

## 数据库 (server/data/register.db, WAL)

**accounts**: id, email(UNIQUE), password, status(`pending/running/success/failed`), plan, token, auth_file, error, started_at, finished_at, created_at
  + 追加列: `phone`(绑定接码手机号), `card`(绑定接码卡密,导出用), `at_status`, `rt_status`, `chat_status`(token测试结果文本)
**logs**: id, account_id, ts, line
**sms_pool**(接码池): id, phone(UNIQUE), link(接码链接,不导出), status(`free/claimed/used/bad`), bound_email, created_at + `card`(卡密)
  - 启动时: `running→pending`(账号断点续跑), `claimed→free`(接码号崩溃回收)

## API 路由 (server/index.ts)

**账号**: `GET /api/accounts` · `POST /api/accounts/import` · `PATCH /api/accounts/:id`(改密) · `DELETE /api/accounts/:id` · `POST /api/accounts/:id/retry` · `GET /api/accounts/:id/logs` · `GET /api/accounts/:id/inbox`(收件箱) · `GET /api/accounts/:id/mail/:mailId/body`
**token测试**: `POST /api/accounts/:id/test-at|test-rt|test-chat`(单个) · `POST /api/control/test-at|test-rt|test-chat`(批量, body可传ids/concurrency)
**控制**: `POST /api/control/start|pause|stop|concurrency|otp|chat|sms|proxy|retry-failed`
**接码池**: `POST /api/sms/import` · `GET /api/sms` · `DELETE /api/sms/:id` · `GET /api/sms/:id/peek`(测收码)
**其它**: `GET /api/state` · `GET /api/stats` · `GET /api/export?format=jsonl|csv` · `GET /api/stream`(SSE)
**SSE事件**: hello, log, status, stats, snapshot, sms, test-done

## 核心功能

### 1. 注册 (src/openai.ts, src/worker-register.ts)
- 邮箱provider抽象(`src/mailbox.ts` switch), 用mailcom成品邮箱取验证码。
- `authRegisterHTTP`: bootstrap → signup → registerPassword → 邮箱OTP(emailOtpValidate) → 可选add-phone(接码) → completeAboutYou → finish → 拿access_token, 存 `auth/at/<date>-<email>.json`。
- **sentinel反爬**(`src/sentinel.ts` + pow/turnstile/vm): 纯HTTP模拟过POW+turnstile, 无需浏览器。注册各步都要。
- ChatGPT密码用 `config.defaultPassword`(≥12位), 不是邮箱密码。
- 单封/双封OTP可配(`otpSingle`, 默认单封)。

### 2. 收信 (src/mail/mailcom.ts)
- Playwright(channel=chrome, headless)登录mailcom, 拦截截获maillist的Bearer token绕过脱敏密码, `context.request`拉收件箱; 正文走 `mailcom.mailbody-ui.de`。
- 会话缓存5分钟(inboxSessions), 前端每行「收件箱」按钮弹窗看邮件, 兼作登录有效性验证。

### 3. 接码/手机验证 (src/sms/, src/sms-broker.ts) —— 接码收费, 核心是零浪费
- **按需触发**: 只有注册走到 `continueURL===/add-phone`(OpenAI要手机)才接码; `authRegisterHTTP`里 `resolveAddPhone` 双守卫。不要手机的账号零消费。
- **导入格式(新)**: 每行 `卡密----手机号----链接`, 如 `SM-X12NG-AD3KE----14109084692----https://k8sms.com/sms/xxx`。智能识别不依赖顺序(link=http段, phone=纯数字段, card=剩余)。兼容老格式(纯手机号/手机号----链接)。
- **链接模板**(可选): 接码链接做成全局模板`smsLinkTemplate`(含`{phone}`占位或`phone=`参数自动替换), 导入只填手机号也行。eccaptcha的key/project通用。
- **号状态机(一号一次, 计费安全)**: `free →claim借出→ claimed(不算消耗) →提交成功→ used / →提交被拒4xx→ bad / →提交临时失败429·5xx→ free(释放回池)`。
  - claim只借出不算消耗; 只有 `sendPhoneOtp` 提交OpenAI成功才 markAsUsed。
  - **提交成功后号已消耗, 收码超时也不换号**(换号=再消耗=浪费)。提交失败才换号。
  - **提交前预检**(`lease.precheck`): peek一次, 号未注册/无效则换号(未消耗)。
- **收码解析**(`extractSmsCode`/`classifySms`): 兼容eccaptcha JSON(取`data.yzm`)和k8sms纯文本; "未注册/网络错误/欠费"=fatal立即停不傻等, "暂无短信"=waiting继续。
- **导出关联**: 成功后卡密(card)/手机号回写account, 导出含card/phone, **不含接码链接**。前端接码池显示 卡密/手机号/状态(可用/使用中/已用/坏号)。

### 4. token测试 (src/token-check.ts) —— 表格里每行「测」+ 顶部批量
- **测at**: 用auth文件的`session.accessToken`调 `chatgpt.com/backend-api/wham/usage`, 200有效/401失效。⚠**走chatgpt.com必须科学上网代理过CF**(见坑)。
- **测rt**: 用`refresh_token`走 `auth.openai.com/oauth/token`(grant_type=refresh_token)刷新, 成功=有效; **默认把新at/rt写回auth文件续期**。当前多数账号无rt(注册没走手机验证)→标"无rt"。
- **批量**: server端并发(测at/rt并发6; 测聊天并发=前端「并发」数, 上限8)。多选复选框(不选=当前列表全部)。
- **反馈**: 表格测试列(at/rt/聊天)显示状态——进行中蓝色脉冲⏳/成功绿✅/失败红❌; 聊天有实时步骤进度(打开→过欢迎页→输入→等回复); 整批完成广播`test-done`, 前端toast+批量栏常驻汇总(共X 成功Y 失败Z)。

### 5. 聊天养号 (src/simulate-chat.ts, src/worker-chat.ts)
- 注册后/手动 用真Chrome发一条消息、等AI回复, 降"注册即封"。
- **session注入**: 用auth文件的`session.sessionToken`注入 `__Secure-next-auth.session-token` cookie(超3900字符分片, 参考gpt_auto_cdk), 让chatgpt.com登录态生效, 不依赖完整cookie。
- **必须headed**: headless被chatgpt的Cloudflare "Just a moment"拦; 无头服务器需装xvfb。`CHAT_HEADLESS=1`强制无头(大概率过不了)。
- 输入框: `#prompt-textarea`(contenteditable ProseMirror), 首次登录有 "You're all set→Continue" 延迟弹框挡住, 每轮重试都点掉; 输入用`keyboard.insertText`(fill对ProseMirror无效)并校验非空; 等回复轮询assistant实际文本非空且流结束。
- **纯HTTP发消息不可行**: 已实测。`/backend-api/conversation`强制turnstile, 其字节码要WebGL`getExtension`等浏览器API, Node VM造不出→只能真浏览器。(测at的GET不需turnstile所以HTTP可行。)

## 代理 (关键坑)

- **注册代理** `regProxy`(env`PROXY_URL`, 默认`config.defaultProxyUrl`=`socks5://127.0.0.1:10808`): 注册/测at/发聊天都用。
- **邮箱代理** `mailProxy`(env`MAILCOM_PROXY`, 默认空=直连): mailcom登录用。Playwright socks5不支持账密认证, 带认证用http代理。
- **★chatgpt.com拦Node/undici的TLS指纹(JA3)**: curl直连通、Node直连ECONNRESET。auth.openai.com不拦。所以**测at/发聊天/拿token这些走chatgpt.com的必须用"科学上网工具"(Clash/V2ray, 如socks5://127.0.0.1:10808), 普通socks5/http住宅代理不行**(它们是TCP转发, TLS指纹照样被拦)。想用住宅IP降封号: Clash里挂住宅为出站节点, 程序仍连10808。
- 诊断口诀: `curl直连` vs `Node直连` chatgpt.com 对比, 不一致就是TLS指纹问题, 跟代理无关。
- undici的ProxyAgent支持socks5(实验性, Node高版本), 所以token-check测at走10808能过CF。

## refresh_token(rt) 说明
拿rt必须"邮箱OTP+手机OTP(接码)"双重验证, 纯邮箱拿不到。rt来自codex OAuth(client_id`app_EMoamEEZ73f0CkXaXp7hrann` + offline_access + PKCE), auth文件`type:"codex"`含refresh_token。控制台注册默认产出网页token(`session.accessToken`, ~10天, 无rt); `REG_TRY_RT`默认0。要rt=配接码走add-phone链。详见 CODEX_RT_FLOW.md。

## worker env (scheduler spawn 传)
REG_EMAIL, REG_PASSWORD, MAILCOM_TOKENS_FILE, MAILCOM_HEADLESS, MAILCOM_PROXY, REG_OTP_SINGLE, REG_SIMULATE_CHAT, REG_TRY_RT(默认0), REG_SMS, SMS_LINK_TEMPLATE, REG_DB_PATH, PROXY_URL

## src 模块清单
- `openai.ts` — OpenAIClient: 注册/登录/授权/OTP/add-phone/sentinel(大文件)
- `sentinel.ts`/`sentinel-browser.ts` — 反爬token(POW+turnstile), 纯HTTP/浏览器两版
- `mailbox.ts` + `mail/mailcom.ts` — 邮箱provider抽象 + mailcom收信
- `sms-broker.ts` — buildSmsLink/extractSmsCode/classifySms/fetchSmsCode/peekSms
- `sms/activation-broker.ts`(接口) `sms/pool-db.ts`(worker无副作用DAO) `sms/pool-broker.ts`(createPoolBroker)
- `token-check.ts` — probeAt/refreshRt/buildProxyDispatcher/decodeJwt
- `simulate-chat.ts` — simulateChat(session注入发消息)
- `worker-register.ts`(注册worker) `worker-chat.ts`(聊天worker)
- `config.ts`(读config.json→appConfig) `constants.ts` `device-profile.ts` `utils.ts`
- 其它单跑工具: `index.ts`(CLI入口) `check-auth-quota.ts`(CLI批量查token) `batch-register.ts` `cpa-codex.ts` 等

## 配置 config.json
provider(mailcom), defaultProxyUrl(注册代理), mailProxyUrl(邮箱代理), defaultPassword(ChatGPT注册密码≥12位), defaultClientId(codex OAuth), smsLinkTemplate(接码链接模板), provider_config

## 开发注意(工具坑)
- 改大文件(`src/openai.ts`, `web/src/App.tsx`, `src/check-auth-quota.ts`)时 **Bash的grep/python/cat stdout会"相似行折叠幻觉"**(同行回显几百遍)。可靠手段: **小窗口Read(≤~14行)** + **`npm run build`/`tsx`加载** 验证。定位用 `python输出纯行号` 或 `写文件再小窗口Read`。
- 起server别用 `nohup &`(挂起工具), 用后台参数; 多进程残留会导致POST/GET命中不同实例, `pkill -9 -f tsx` 清干净再起。
- 输出中文与英文/数字之间不加空格(用户偏好)。
