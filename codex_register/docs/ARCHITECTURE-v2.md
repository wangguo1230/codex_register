# 多域账号系统 架构设计 v2

> 目标:从"单业务(GPT)的注册控制台"演进为"邮箱管理 + GPT 注册 + Claude Code 注册"的多域系统。
> 三域独立、邮箱资源隔离(不能串)、共享基础设施。

## 0. 设计原则

1. **邮箱是资源,账号是业务**:邮箱进系统先是"资源",被某业务占用才成为该业务的"账号"。
2. **单一归属隔离**:一个邮箱同一时刻只属于一个域(free/gpt/claude),物理隔离,不可串。
3. **共享基础设施,独立业务引擎**:邮箱能力/浏览器/接码/存储共享;GPT 与 Claude 的注册流程各自独立实现。
4. **渐进迁移不停服**:新表与旧表并行,代码逐步切换,每步可回滚。

---

## 1. 领域划分

```
┌────────────────────────────────────────────────┐
│  邮箱域 Mailbox (共享资源池,横切)                 │
│  登录验证 · 收信/取OTP · 改密 · 分组 · 分配归属    │
└────────────────────────────────────────────────┘
        ↑ 分配(CAS 锁定 usage)        ↑
 ┌───────────────┐            ┌────────────────┐
 │ GPT 账号域     │            │ Claude 账号域   │
 │ 注册/at/rt/接码 │            │ 注册/凭证/...    │
 │ /养号/改密同步  │            │                │
 └───────────────┘            └────────────────┘
```

- **邮箱域**:不关心业务,只管邮箱本身。所有邮箱在这里统一管理(含未使用的)。
- **GPT 域 / Claude 域**:独立业务,从邮箱池"借"邮箱,产生各自的业务账号。

---

## 2. 数据模型(职责归一化)

### 2.1 `mailboxes` — 邮箱资源池(核心)
```sql
CREATE TABLE mailboxes (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  email       TEXT UNIQUE NOT NULL,
  password    TEXT NOT NULL,           -- 邮箱登录密码(可被改密更新)
  provider    TEXT NOT NULL DEFAULT 'mailcom',
  usage       TEXT NOT NULL DEFAULT 'free',   -- 'free' | 'gpt' | 'claude'  ★隔离核心
  grp         TEXT DEFAULT '',         -- 分组/批次(邮箱层面)
  pw_status   TEXT DEFAULT '',         -- 邮箱改密状态
  note        TEXT DEFAULT '',
  created_at  INTEGER NOT NULL
);
CREATE INDEX idx_mailboxes_usage ON mailboxes(usage);
```
- `usage` 是隔离核心。默认 `free`(纯管理)。分配给业务后变 `gpt`/`claude`,该域外查询/分配都看不到。

### 2.2 `gpt_accounts` — GPT 业务账号
```sql
CREATE TABLE gpt_accounts (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  mailbox_id  INTEGER NOT NULL UNIQUE REFERENCES mailboxes(id),
  status      TEXT NOT NULL DEFAULT 'pending',  -- pending/running/success/failed
  token       TEXT DEFAULT '',        -- access_token(网页 at)
  auth_file   TEXT DEFAULT '',        -- 网页 session auth 文件路径
  rt_file     TEXT DEFAULT '',        -- codex rt 文件路径
  plan        TEXT DEFAULT '',
  phone       TEXT DEFAULT '',        -- 绑定接码号
  card        TEXT DEFAULT '',
  engine      TEXT DEFAULT 'browser', -- http/browser/bit
  batch       TEXT DEFAULT '',
  at_status   TEXT DEFAULT '',
  rt_status   TEXT DEFAULT '',
  chat_status TEXT DEFAULT '',
  error       TEXT DEFAULT '',
  dead_at     INTEGER DEFAULT 0,
  sold_at     INTEGER DEFAULT 0,
  started_at  INTEGER, finished_at INTEGER, created_at INTEGER NOT NULL
);
```

### 2.3 `claude_accounts` — Claude 业务账号(字段待注册机制确定)
```sql
CREATE TABLE claude_accounts (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  mailbox_id  INTEGER NOT NULL UNIQUE REFERENCES mailboxes(id),
  status      TEXT NOT NULL DEFAULT 'pending',
  -- Claude/Anthropic 特有凭证:session key / oauth token / org id / api key ...
  -- 待"3. Claude 注册机制"确定后补全
  engine      TEXT DEFAULT 'browser',
  batch       TEXT DEFAULT '',
  error       TEXT DEFAULT '',
  dead_at     INTEGER DEFAULT 0, sold_at INTEGER DEFAULT 0,
  started_at  INTEGER, finished_at INTEGER, created_at INTEGER NOT NULL
);
```

### 2.4 `sms_pool` — 接码池(共享基础设施,GPT/Claude 谁需手机验证谁用)
保持现状(phone/card/link/status/bind_count/bind_emails),不变。

---

## 3. 隔离机制:"不能串"如何保证

**分配是唯一入口 + CAS 原子性**:
```sql
-- 分配一个 free 邮箱给 GPT(并发安全:影响行数=0 说明被别人抢了,换下一个)
UPDATE mailboxes SET usage='gpt' WHERE id=? AND usage='free';
```
- 邮箱一旦 `usage='gpt'`,Claude 域的查询(`WHERE usage='claude'`)和分配(`WHERE usage='free'`)都碰不到它。
- 反向亦然。**物理隔离,无法串**。
- 回收:业务账号删除时,可选把邮箱 `usage` 退回 `free`(或保持,视策略)。

**查询边界**:
| 场景 | 条件 |
|---|---|
| 邮箱管理(看全部) | 无过滤 |
| 待分配池 | `usage='free'` |
| GPT 域 | `usage='gpt'` + join gpt_accounts |
| Claude 域 | `usage='claude'` + join claude_accounts |

---

## 4. 接口契约(可插拔)

```ts
// 邮箱能力(已有 EmailCodeProvider 的超集)
interface MailProvider {
  login(email, password): Promise<Session>
  getOtp(email, opts?): Promise<string>      // 支持 excludeCode
  changePassword(email, oldPw, newPw): Promise<{ok, verified}>
  fetchInbox(email): Promise<Mail[]>
}

// 注册引擎:GPT/Claude 各实现,编排层不感知差异。
// 引擎收敛两类业务知识 —— 如何"跑"(buildSpawn) + 如何"读懂产出"(onResult/onAbnormalExit)。
// 调度器(job runner)只做进程/并发/事件循环,对 GPT/Claude 完全对称。
interface RegisterEngine {
  domain: "gpt" | "claude"
  buildSpawn(acc, runner, tmpFile): { script, env }        // 选 worker 脚本 + 环境变量
  onResult(runner, id, ev): void                           // 解释 result 事件 → 写库/标记状态
  onAbnormalExit(runner, id, code): void                   // worker 无结果退出 → 判失败
}

// 浏览器供给:比特/Playwright/HTTP 各实现
interface BrowserSupplier {
  acquire(proxy?): Promise<{ cdpEndpoint?, browser, release: () => Promise<void> }>
}

// 接码
interface SmsService {
  getActivation(email, opts): Promise<Lease>
}
```
业务差异收敛在 `GptRegisterEngine` / `ClaudeRegisterEngine` 里;编排层只调 `engine.register(mailbox)`。

---

## 5. 分层架构

```
前端(统一控制台)   邮箱管理 | GPT | Claude  三模块 + 共享组件(表格/筛选/批次/导出)
────────────────────────────────────────────────────────
应用层(编排/API)   MailboxService · GptService · ClaudeService · 调度器(按域)
────────────────────────────────────────────────────────
领域层             Mailbox(资源+usage) · GptAccount · ClaudeAccount · SmsPool
────────────────────────────────────────────────────────
基础设施           MailProvider(mailcom+) · BrowserSupplier(bit/pw) · Sms · SQLite · SSE
```

---

## 6. 迁移方案(accounts → mailboxes + gpt_accounts)

**安全渐进,不停服**:
1. **备份** `data/register.db`。
2. **建新表** mailboxes / gpt_accounts(旧 accounts 保留)。
3. **一次性迁移脚本**:每行 accounts →
   - mailboxes:{email, password, provider='mailcom', usage='gpt', grp=batch, pw_status}
   - gpt_accounts:{mailbox_id=新id, status, token, auth_file, rt_file, plan, phone, card, batch, *_status, dead_at, sold_at, ...}
4. **代码切换**:db 层新增 mailboxes/gpt_accounts DAO,server/scheduler 逐步改引用;旧 accounts 只读兜底一段时间。
5. **验证无误后**下线旧 accounts。

回滚:任何一步失败,恢复备份 db + 保留旧 accounts 代码路径。

---

## 7. 分阶段实施计划

| 阶段 | 内容 | 风险 | 依赖 |
|---|---|---|---|
| P1 | 数据模型:建 mailboxes+gpt_accounts + 迁移脚本 + DAO | 中(数据) | 备份 |
| P2 | 邮箱域抽取:MailboxService(登录/收信/改密/分配 CAS) | 低 | P1 |
| P3 | 引擎接口:RegisterEngine/BrowserSupplier 抽象,GPT 现流程包成 GptRegisterEngine | 低 | P2 |
| P4 | free 池 + 分配隔离:导入进 mailboxes(free),GPT 注册时分配 | 低 | P2 |
| P5 | 前端:三模块(邮箱/GPT/Claude tab)+ 共享组件 | 中 | P1-P4 |
| P6 | Claude 域:ClaudeRegisterEngine + claude_accounts(需注册机制) | 高 | **Claude 机制** |

---

## 8. 待确认/风险(决策点)

- **D1 Claude Code 注册机制(硬阻塞)**:Claude/Anthropic 账号如何注册?(claude.ai 邮箱注册?是否手机验证?反爬?产出什么凭证——session key / API key / oauth?)。没有它 P6 无法实现,claude_accounts 字段也无法定稿。**需逆向/录制,如当初 GPT。**
- **D2 迁移策略**:停服迁移(简单) vs 并行不停服(稳)。本地工具建议:备份 + 短暂停服迁移最简单可靠。
- **D3 邮箱回收策略**:删 GPT 账号时,邮箱 usage 退回 free(可再分配)还是保留 gpt(避免复用已注册号)。建议保留 gpt(mail.com 已注册过 ChatGPT 的邮箱复用会走登录路径)。
- **D4 范围优先级**:先把 GPT 地基重构做扎实(P1-P5),Claude(P6)待机制明确再上。
