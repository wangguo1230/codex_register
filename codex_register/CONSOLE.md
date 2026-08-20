# GPT 批量注册 Web 控制台

可视化批量注册：导入成品 mail.com 邮箱 → 并发注册 ChatGPT → 实时日志 → 暂停/重跑 → 导出 token。

## 启动

```bash
cd codex_register
./start-console.sh                 # 首次会自动 build 前端，然后起服务
# 打开 http://localhost:3100
```

开发模式（前端热更新）：
```bash
# 终端1: 后端（使用生产 bundle，避免 tsx 在大依赖图启动阶段写缓存）
npm run build:server && npm run server
# 终端2: 前端(vite dev, 代理 /api 到 3100)
cd web && npm run dev               # 打开 http://localhost:5173
```

## 功能

| 功能 | 说明 |
|---|---|
| 批量导入 | 粘贴 `邮箱----密码`(也支持 `邮箱:密码` / `邮箱 密码`)，去重入库 |
| 并发注册 | 顶部设并发数(1~16)，点「开始」，每个邮箱一个 worker 子进程 |
| 暂停/恢复 | 「暂停」=不再取新任务(运行中的跑完)；「开始」恢复 |
| 停止 | 「停止」kill 所有运行中 worker |
| 实时日志 | 点账号行，右侧看该号带时间戳的注册全过程(SSE 推送) |
| 重跑 | 单行「重跑」或顶部「重试失败」(把 failed 重置为 pending) |
| 状态筛选 | 点顶部统计徽章按 等待/运行/成功/失败 过滤 |
| 批量下载 | JSONL / CSV / 仅Token 三种格式导出成功账号 |
| 断点续跑 | 状态存 SQLite，服务重启后进度不丢(运行中→重置为等待) |

## 架构

```
React(web/dist) ──SSE/REST──► Express(server/index.ts)
                                  │  调度器(server/scheduler.ts): worker 子进程池
                                  │  每邮箱 spawn  tsx src/worker-register.ts
                                  └─ SQLite(server/db.ts): accounts + logs
```

- **worker 子进程**：日志隔离、崩溃隔离、sentinel(CPU)真并行、Playwright 会话不跨任务污染
- **密码注入**：调度器给每个 worker 写临时单行池文件，经 `MAILCOM_TOKENS_FILE` 注入(并发隔离)
- **数据**：`server/data/register.db`(SQLite)；token 同时落 `auth/at/<日期>-<邮箱>.json`

## 配置

- 注册密码 / 代理：`config.json`(`defaultPassword` / `defaultProxyUrl`)
- 端口：环境变量 `PORT`(默认 3100)
- 收码浏览器无头：worker 默认 `MAILCOM_HEADLESS=1`

## REST API(供集成)

`POST /api/accounts/import` · `GET /api/accounts` · `GET /api/accounts/:id/logs` ·
`POST /api/accounts/:id/retry` · `DELETE /api/accounts/:id` ·
`POST /api/control/{start,pause,stop,concurrency,retry-failed}` ·
`GET /api/export?format=jsonl|csv|tokens` · `GET /api/stream`(SSE)
