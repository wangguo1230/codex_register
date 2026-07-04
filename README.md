# custom-mail —— 用 mail.com 成品号自动注册 ChatGPT

把现成的 mail.com 邮箱（成品号）批量注册成 ChatGPT 账号：自动登录邮箱收 OpenAI 验证码、过反爬、拿 access_token。

## 目录结构

```
custom-mail/
├── codex_register/            # 注册主项目(TypeScript, 实际运行的就是它)
│   ├── src/
│   │   ├── openai.ts          #   ChatGPT 注册主流程(authRegisterHTTP)
│   │   ├── sentinel.ts        #   OpenAI 反爬 token(POW + turnstile VM, 复用上游)
│   │   ├── mail/mailcom.ts    #   ★ mail.com 邮箱 provider(本项目新增)
│   │   ├── mailbox.ts         #   邮箱 provider 路由(已接 mailcom)
│   │   └── config.ts          #   配置加载(已支持 provider=mailcom)
│   ├── config.json            #   运行配置(provider/代理/默认密码)
│   ├── mailcom/tokens.txt     #   ★ 邮箱池: 每行 `邮箱----密码`(填成品号)
│   ├── auth/at/*.json         #   注册产出(含 access_token)
│   └── probe_mailcom.ts       #   provider 收信链路自测脚本
└── mailcom_调研记录.md         # mail.com 登录/收信接口调研(文档留档)
```

> 早期的 mail.com 收信 Python 脚本已删除——其登录/截获Bearer/收信/取正文逻辑已完整移植到
> `codex_register/src/mail/mailcom.ts`(TS+playwright-core)，注册流程自包含、不依赖 Python。

## 运行

```bash
cd codex_register

# 1. 把成品号填进 mailcom/tokens.txt，每行: 邮箱----密码
# 2. 单个注册(自动从池取下一个邮箱)
npx tsx src/index.ts --at
#    或指定邮箱: npx tsx src/index.ts --at --email someone@mail.com

# 自测 mail.com 收信链路(不注册, 仅验证能登录收信)
npx tsx probe_mailcom.ts <邮箱>
```

可调环境变量：`MAILCOM_HEADLESS=1`(无头) `MAILCOM_POLL_ATTEMPTS` `MAILCOM_POLL_INTERVAL_MS` `MAILCOM_TOKENS_FILE`。

## Web 控制台（推荐）

可视化批量注册：导入成品邮箱 → 并发注册 → 实时日志 → 暂停/重跑 → 导出 token。
```bash
cd codex_register && ./start-console.sh    # 打开 http://localhost:3100
```
React+Vite+Tailwind / Express+SSE / SQLite / worker 子进程池。详见 `codex_register/CONSOLE.md`。

## 流程(authRegisterHTTP)

```
初始化会话 → 打开注册页 → 提交邮箱(过 sentinel 反爬)
→ [mailcom provider 登录邮箱、收 OpenAI 验证码] → 提交验证码 → 完成 → 存 auth/at/<日期>-<邮箱>.json
```

## 已知约束(来自上游)

- 纯邮箱注册产出**网页端 token**(`app_X8zY6vW2...`, 无 refresh_token, 约 10 天过期)；长期可续期需 `--phone` 链路。
- 能否成功还取决于 OpenAI 当时是否对出口 IP 强制手机验证(服务端风控)。

## 安全

`mailcom/tokens.txt` 与 `config.json` 含账密/密钥，**勿提交 git**。
