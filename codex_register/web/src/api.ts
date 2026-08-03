// 后端 REST + SSE 封装
export interface Account {
    id: number;
    email: string;
    password: string;
    status: "pending" | "running" | "success" | "failed";
    plan: string;
    token: string;
    auth_file: string;
    rt_file?: string;
    phone?: string;
    card?: string;
    at_status?: string;
    rt_status?: string;
    chat_status?: string;
    dead_at?: number;
    sold_at?: number;
    pw_status?: string; // 邮箱改密状态:''=未改过 / ✅已改 / ❌失败原因
    batch?: string; // 导入批次名
    error: string;
    started_at: number | null;
    finished_at: number | null;
    created_at: number;
}

// 邮箱资源(架构 v2:usage 归属隔离核心)
export interface Mailbox {
    id: number;
    email: string;
    password: string;
    provider: string;
    usage: "free" | "hold" | "gpt" | "claude"; // free=待分配 hold=独立(永不被业务分配)
    grp?: string;
    pw_status?: string;
    note?: string;
    created_at: number;
}

export interface Stats {
    pending: number;
    running: number;
    success: number;
    failed: number;
    total: number;
}

// Claude 业务账号(架构 v2:占位,凭证字段随注册机制定稿再扩)
export interface ClaudeAccount {
    id: number;
    mailbox_id: number;
    email: string;
    password: string;
    status: "pending" | "running" | "success" | "failed";
    session_key?: string;
    org_id?: string;
    plan?: string;
    claude_code?: string; // Claude Code 权限状态(available/blocked_by_org_tier/…)
    engine?: string;
    batch?: string;
    error?: string;
    pw_status?: string;
    dead_at?: number;
    sold_at?: number;
    started_at?: number | null;
    finished_at?: number | null;
    created_at: number;
}

export interface RechargeCard {
    id: number;
    code: string;
    plan_type: string;
    plan_name: string;
    product: string;
    category: string;
    auth_mode: string;
    status: "unused" | "paired" | "submitting" | "submitted" | "done" | "error";
    account_id: number;
    account_email: string;
    task_no: string;
    task_status: string;
    task_message: string;
    error: string;
    batch: string;
    created_at: number;
    updated_at: number;
}

export interface RechargeConfig {
    baseUrl: string;
    appId: string;
    apiKey: string;
    forwardIp: string;
    concurrency: number;
    interval: number;
    rtProxy: string;
    rtConcurrency: number;
}

export interface RechargeCardStats {
    unused: number;
    paired: number;
    submitting: number;
    submitted: number;
    done: number;
    error: number;
    total: number;
}

export interface RechargeQueueItem {
    id: number;
    account_id: number;
    email: string;
    auth_file: string;
    plan: string;
    batch: string;
    card_id: number;
    card_code: string;
    status: "pending" | "paired" | "submitting" | "submitted" | "done" | "error";
    task_no: string;
    task_status: string;
    task_message: string;
    error: string;
    plan_type: string;
    created_at: number;
    submitted_at: number;
}

export interface RechargeQueueStats {
    pending: number;
    paired: number;
    submitting: number;
    submitted: number;
    done: number;
    error: number;
    total: number;
}

export interface XrayStatus {
    running: boolean;
    port: number;
    node: string;
    vless: string;
    pid: number;
    error: string;
}

export interface Daily {
    enabled: boolean;
    hour: number;
    items: {chat: boolean; rt: boolean; at: boolean};
    lastRunAt: number;
    runCount: number;
    chatTotal: number;
    rtTotal: number;
    atTotal: number;
    lastResult: string;
    running: boolean;
}

async function j<T>(url: string, opts?: RequestInit): Promise<T> {
    const res = await fetch(url, {
        headers: {"Content-Type": "application/json"},
        ...opts,
    });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `HTTP ${res.status}`);
    return res.json();
}

export const api = {
    importAccounts: (text: string, defaultPassword?: string, batch?: string) =>
        j<{inserted: number; skipped: number; total: number}>("/api/accounts/import", {
            method: "POST",
            body: JSON.stringify({text, defaultPassword, batch}),
        }),
    batches: () => j<{name: string; count: number}[]>("/api/batches"),
    setBatch: (ids: number[], batch: string) => j<{ok: boolean; count: number}>("/api/accounts/set-batch", {method: "POST", body: JSON.stringify({ids, batch})}),
    batchDelete: (ids: number[]) => j<{ok: boolean; count: number; skipped: number}>("/api/accounts/batch-delete", {method: "POST", body: JSON.stringify({ids})}),
    // 批量设置售出状态:sold=false 把已售出改回未售出(误标/退回重新上架)
    setSold: (ids: number[], sold: boolean) => j<{ok: boolean; count: number; sold: boolean}>("/api/accounts/set-sold", {method: "POST", body: JSON.stringify({ids, sold})}),
    listAccounts: () => j<Account[]>("/api/accounts"),
    getAccount: (id: number) => j<Account>(`/api/accounts/${id}`), // 拉单个账号(点行刷新用,避免整表全量拉)
    logs: (id: number) => j<{id: number; ts: number; line: string}[]>(`/api/accounts/${id}/logs`),
    retry: (id: number) => j(`/api/accounts/${id}/retry`, {method: "POST"}),
    remove: (id: number) => j(`/api/accounts/${id}`, {method: "DELETE"}),
    updatePassword: (id: number, password: string) => j(`/api/accounts/${id}`, {method: "PATCH", body: JSON.stringify({password})}),
    // 编辑账号记录(多字段,改本地库),fields 可含 email/password/status/plan/phone/card/at_status/rt_status/chat_status/error/dead/sold
    updateAccount: (id: number, fields: Record<string, any>) => j<{ok: boolean; account: Account}>(`/api/accounts/${id}`, {method: "PATCH", body: JSON.stringify(fields)}),
    // 注入 at 打开已登录 chatgpt 的真浏览器(人工操作)
    openBrowser: (id: number) => j<{ok: boolean}>(`/api/accounts/${id}/open-browser`, {method: "POST"}),
    // 单号 session json(账号详情复制用,与导出 format=session 行内的 json 一致)
    getSession: (id: number) => j<{session: unknown}>(`/api/accounts/${id}/session`),
    // 批量改密停止(GPT/邮箱域共用一套后台串行引擎)
    stopBatchPasswd: () => j<{ok: boolean; msg?: string}>("/api/control/batch-passwd/stop", {method: "POST"}),
    setPwConcurrency: (n: number) => j<{ok: boolean; pwConcurrency: number}>("/api/control/pw-concurrency", {method: "POST", body: JSON.stringify({pwConcurrency: n})}),
    // 独立小工具:批量校验邮箱密码(可选验证后改密)
    mailCheck: (items: {email: string; password: string}[], changePassword: boolean) =>
        j<{results: {email: string; ok: boolean; reason?: string; changed?: boolean; newPassword?: string}[]; changePassword: boolean}>(
            "/api/tools/mail-check", {method: "POST", body: JSON.stringify({items, changePassword})}),
    start: (concurrency: number) => j("/api/control/start", {method: "POST", body: JSON.stringify({concurrency})}),
    pause: () => j("/api/control/pause", {method: "POST"}),
    stop: () => j("/api/control/stop", {method: "POST"}),
    setConcurrency: (concurrency: number) => j("/api/control/concurrency", {method: "POST", body: JSON.stringify({concurrency})}),
    setOtp: (single: boolean) => j("/api/control/otp", {method: "POST", body: JSON.stringify({single})}),
    setChat: (simulate: boolean) => j("/api/control/chat", {method: "POST", body: JSON.stringify({simulate})}),
    setProxy: (regProxy: string, mailProxy: string, mailProxyEnabled?: boolean) => j("/api/control/proxy", {method: "POST", body: JSON.stringify({regProxy, mailProxy, mailProxyEnabled})}),
    setXrayBin: (binPath: string) => j<{xrayBinPath: string}>("/api/control/xray-bin", {method: "POST", body: JSON.stringify({binPath})}),
    startXray: (vlessUrl: string) => j<{xray: XrayStatus; regProxy: string}>("/api/control/xray", {method: "POST", body: JSON.stringify({vlessUrl})}),
    stopXray: () => j<{xray: XrayStatus}>("/api/control/xray/stop", {method: "POST"}),
    xrayProbe: () => j<{ok: boolean; ip?: string; chatgpt?: string; pass?: boolean; reason?: string}>("/api/control/xray/probe"),
    setSms: (enabled: boolean) => j("/api/control/sms", {method: "POST", body: JSON.stringify({enabled})}),
    setRt: (enabled: boolean) => j<{rtEnabled: boolean}>("/api/control/rt", {method: "POST", body: JSON.stringify({enabled})}),
    setBit: (enabled: boolean) => j<{bitBrowser: boolean}>("/api/control/bit", {method: "POST", body: JSON.stringify({enabled})}),
    setEngine: (engine: "http" | "browser") => j<{regEngine: string}>("/api/control/engine", {method: "POST", body: JSON.stringify({engine})}),
    setDaily: (cfg: Partial<{enabled: boolean; hour: number; items: {chat: boolean; rt: boolean; at: boolean}}>) => j<{daily: Daily}>("/api/control/daily", {method: "POST", body: JSON.stringify(cfg)}),
    runDaily: () => j<{started: boolean; accounts: number}>("/api/control/daily/run", {method: "POST", body: JSON.stringify({})}),
    setMailSeparator: (separator: string) => j<{mailSeparator: string}>("/api/control/mail-separator", {method: "POST", body: JSON.stringify({separator})}),
    saveSmsTemplate: (linkTemplate: string) => j<{smsLinkTemplate: string}>("/api/control/sms", {method: "POST", body: JSON.stringify({linkTemplate})}),
    setSmsMaxBind: (maxBind: number) => j<{smsMaxBind: number}>("/api/control/sms", {method: "POST", body: JSON.stringify({maxBind})}),
    importSms: (text: string) => j<{inserted: number; skipped: number; total: number; invalid?: {phone: string; reason: string}[]; verified?: boolean}>("/api/sms/import", {method: "POST", body: JSON.stringify({text})}),
    listSms: () => j<{list: any[]; stats: {free: number; used: number; bad: number; claimed: number; total: number}}>("/api/sms"),
    deleteSms: (id: number) => j(`/api/sms/${id}`, {method: "DELETE"}),
    peekSms: (id: number) => j<{text: string}>(`/api/sms/${id}/peek`),
    batchRefreshAt: (lines: string) => j<{ok: boolean; count: number}>("/api/tools/batch-refresh-at", {method: "POST", body: JSON.stringify({lines})}),
    batchAcquireRt: (lines: string) => j<{ok: boolean; count: number}>("/api/tools/batch-acquire-rt", {method: "POST", body: JSON.stringify({lines})}),
    stopBatchAcquireRt: () => j<{ok: boolean}>("/api/tools/batch-acquire-rt/stop", {method: "POST"}),
    stopBatchRefreshAt: () => j<{ok: boolean}>("/api/tools/batch-refresh-at/stop", {method: "POST"}),
    testAt: (id: number) => j(`/api/accounts/${id}/test-at`, {method: "POST"}),
    testRt: (id: number) => j(`/api/accounts/${id}/test-rt`, {method: "POST"}),
    testChat: (id: number) => j(`/api/accounts/${id}/test-chat`, {method: "POST"}),
    batchTestAt: (ids: number[], relogin = false) => j<{count: number}>("/api/control/test-at", {method: "POST", body: JSON.stringify({ids, relogin})}),
    stopBatchAt: () => j<{ok: boolean; msg?: string}>("/api/control/test-at/stop", {method: "POST"}),
    // acquire=true:过期/无rt 的号重登获取 rt(走 codex OAuth+接码,有成本);false:只刷新有效 rt、标记失效
    batchTestRt: (ids: number[], acquire = false) => j<{count: number}>("/api/control/test-rt", {method: "POST", body: JSON.stringify({ids, acquire})}),
    batchTestChat: (ids: number[]) => j<{count: number}>("/api/control/test-chat", {method: "POST", body: JSON.stringify({ids})}),
    retryFailed: () => j("/api/control/retry-failed", {method: "POST"}),
    state: () => j<{state: {paused: boolean; pausedClaude?: boolean; claudeProxy?: string; claudeXrayVless?: string; claudeXray?: XrayStatus; regProxyPort?: number; claudeProxyPort?: number; runningClaude?: number[]; concurrency: number; otpSingle: boolean; simulateChat: boolean; smsEnabled: boolean; rtEnabled: boolean; bitBrowser?: boolean; smsMaxBind: number; regEngine: string; daily: Daily; xray: XrayStatus; smsLinkTemplate: string; regProxy: string; mailProxy: string; mailProxyEnabled?: boolean; mailSeparator?: string; xrayBinPath?: string; xrayVless?: string; pwConcurrency?: number; running: number[]; batchPw?: {running: boolean; done: number; total: number}}; stats: Stats}>("/api/state"),
    // ★统一导出(合并原下载菜单+批量导出)。范围×scope×格式×标记已售出一站式;POST 返回纯文本供 blob 下载。
    //   范围:ids(选中/当前筛选) 或 batch(按批次) 或都不传(全部成功号)。
    exportFull: async (opts: {format: "full" | "at" | "session" | "jsonl" | "csv"; scope?: "all" | "hasRt" | "atOnly"; batch?: string; ids?: number[]; markSold?: boolean}): Promise<string> => {
        const res = await fetch("/api/export/full", {method: "POST", headers: {"Content-Type": "application/json"}, body: JSON.stringify(opts)});
        if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `HTTP ${res.status}`);
        return res.text();
    },
    // ---- 邮箱域:资源池(free/gpt/claude 隔离) ----
    listMailboxes: (usage?: string) =>
        j<{list: Mailbox[]; stats: {free: number; hold: number; gpt: number; claude: number; total: number}; groups: {grp: string; n: number}[]}>(`/api/mailboxes${usage ? `?usage=${usage}` : ""}`),
    // autoChangePw:导入后自动改随机20位;hold:导入即独立(进 hold,永不被业务分配)
    importFreeMailboxes: (text: string, defaultPassword?: string, grp?: string, autoChangePw?: boolean, hold?: boolean, provider?: string) =>
        j<{inserted: number; skipped: number; total: number; autoChangePw?: number}>("/api/mailboxes/import", {method: "POST", body: JSON.stringify({text, defaultPassword, grp, autoChangePw, hold, provider})}),
    // 切换邮箱状态 free(待分配) ↔ hold(独立);单个 / 批量
    setMailboxUsage: (id: number, usage: "free" | "hold") => j<{ok: boolean; usage: string}>(`/api/mailboxes/${id}/usage`, {method: "POST", body: JSON.stringify({usage})}),
    setMailboxesUsage: (ids: number[], usage: "free" | "hold") => j<{ok: boolean; count: number}>("/api/mailboxes/usage", {method: "POST", body: JSON.stringify({ids, usage})}),
    // 邮箱域批量改密(操作 mailboxes 表,覆盖 free/gpt/claude)。ids=选中的 mailbox id
    batchChangeMailboxPasswd: (ids: number[]) => j<{ok: boolean; count: number; msg?: string}>("/api/mailboxes/batch-change-passwd", {method: "POST", body: JSON.stringify({ids})}),
    // 邮箱域:收件箱/正文/操作日志(覆盖所有邮箱)
    mailboxInbox: (id: number) => j<{email: string; mails: {id: string; from: string; subject: string; date: string}[]}>(`/api/mailboxes/${id}/inbox`),
    mailboxMailBody: (id: number, mailId: string) => j<{body: string}>(`/api/mailboxes/${id}/mail/${mailId}/body`),
    mailboxLogs: (id: number) => j<{id: number; ts: number; line: string}[]>(`/api/mailboxes/${id}/logs`),
    // fromGrp:限定只从该分组的独立邮箱分配(避免误分想保留的);不传=全池,""=无分组桶。batch=业务号标签。
    allocateMailboxes: (usage: "gpt" | "claude", count: number, batch?: string, fromGrp?: string) =>
        j<{allocated: number; error?: string}>("/api/mailboxes/allocate", {method: "POST", body: JSON.stringify({usage, count, batch, ...(fromGrp !== undefined ? {fromGrp} : {})})}),
    // 按指定邮箱 id 分配给业务域(GPT「从邮箱选号」用)。changePwFirst=先串行改密再分配(改完不论成败都分配)。
    // 返回:直接分配→{allocated,skipped};先改密→{ok,changePwFirst,willChange}(改密+分配在后台跑,进度走 batchPw 事件)。
    allocateMailboxIds: (usage: "gpt" | "claude", ids: number[], batch?: string, changePwFirst?: boolean) =>
        j<{allocated?: number; skipped?: number; changePwFirst?: boolean; willChange?: number; error?: string}>(
            "/api/mailboxes/allocate", {method: "POST", body: JSON.stringify({usage, ids, batch: batch || "", changePwFirst: !!changePwFirst})}),
    deleteMailbox: (id: number) => j<{ok: boolean; reason?: string}>(`/api/mailboxes/${id}`, {method: "DELETE"}),
    batchDeleteMailbox: (ids: number[]) => j<{ok: boolean; count: number; skipped: number}>("/api/mailboxes/batch-delete", {method: "POST", body: JSON.stringify({ids})}),
    changeMailboxPasswd: (id: number, newPassword?: string) =>
        j<{ok: boolean; newPassword: string; detail?: string}>(`/api/mailboxes/${id}/change-passwd`, {method: "POST", body: JSON.stringify({newPassword: newPassword || ""})}),
    // ---- Claude 域(架构 v2:与 GPT 对称命名空间 /api/claude/*)。magic-link 注册,比特浏览器+代理过 CF ----
    listClaudeAccounts: () => j<{list: ClaudeAccount[]; stats: Stats}>("/api/claude/accounts"),
    registerClaude: () => j<{ok: boolean}>("/api/claude/register", {method: "POST"}), // 开始(解除 Claude 暂停+tick)
    pauseClaude: () => j<{ok: boolean}>("/api/claude/pause", {method: "POST"}),
    stopClaude: () => j<{ok: boolean}>("/api/claude/stop", {method: "POST"}),
    deleteClaudeAccount: (id: number) => j<{ok: boolean}>(`/api/claude/accounts/${id}`, {method: "DELETE"}),
    retryClaude: (id: number) => j<{ok: boolean}>(`/api/claude/accounts/${id}/retry`, {method: "POST"}), // 重跑 failed/异常号(重置pending进队列)
    // Claude 独立代理/vless
    setClaudeProxy: (proxy: string) => j<{claudeProxy: string}>("/api/control/claude-proxy", {method: "POST", body: JSON.stringify({proxy})}),
    startClaudeXray: (vlessUrl: string) => j<{xray: XrayStatus; claudeProxy: string}>("/api/control/claude-xray", {method: "POST", body: JSON.stringify({vlessUrl})}),
    stopClaudeXray: () => j<{xray: XrayStatus}>("/api/control/claude-xray/stop", {method: "POST"}),
    // 配置独立 xray 本地端口(持久化):用专属端口隔离,避免与系统 v2rayN/其他服务冲突及清理误杀
    setProxyPorts: (regPort: number, claudePort: number) => j<{regProxyPort: number; claudeProxyPort: number; regProxy: string; claudeProxy: string}>("/api/control/proxy-ports", {method: "POST", body: JSON.stringify({regPort, claudePort})}),
    // 查存活+订阅/套餐(比特浏览器过 CF,后台跑,结果走 SSE claude 事件的 result 字段)
    queryClaude: (ids: number[]) => j<{ok: boolean; count: number; msg?: string}>("/api/claude/query", {method: "POST", body: JSON.stringify({ids})}),
    chatClaude: (ids: number[], message?: string) => j<{ok: boolean; count: number}>("/api/claude/chat", {method: "POST", body: JSON.stringify({ids, message})}),
    // 扫邮箱检测禁用(双重:先扫邮箱找禁用通知,未命中再 API 探测存活)。后台跑,结果走 SSE claude.result + claudeScan 进度
    scanClaudeDisabled: (id: number) => j<{ok: boolean}>(`/api/claude/accounts/${id}/scan-disabled`, {method: "POST"}),
    batchScanClaudeDisabled: (ids: number[]) => j<{ok: boolean; count: number; msg?: string}>("/api/claude/scan-disabled", {method: "POST", body: JSON.stringify({ids})}),
    stopScanClaudeDisabled: () => j<{ok: boolean}>("/api/claude/scan-disabled/stop", {method: "POST"}),
    // Claude 域操作日志(独立表,注册/查订阅/养号)
    claudeLogs: (id: number) => j<{id: number; ts: number; line: string}[]>(`/api/claude/accounts/${id}/logs`),
    // Claude 批次/批量删除/导出(选中,可标记已售出)
    claudeBatches: () => j<{name: string; n: number}[]>("/api/claude/batches"),
    batchDeleteClaude: (ids: number[]) => j<{ok: boolean; count: number; skipped: number}>("/api/claude/batch-delete", {method: "POST", body: JSON.stringify({ids})}),
    exportSelectedClaude: async (ids: number[], markSold: boolean): Promise<string> => {
        const res = await fetch("/api/claude/export/selected", {method: "POST", headers: {"Content-Type": "application/json"}, body: JSON.stringify({ids, markSold})});
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.text();
    },
    // ---- 充值提交域 ----
    rechargeConfig: () => j<RechargeConfig & {hasKey: boolean}>("/api/recharge/config"),
    setRechargeConfig: (cfg: Partial<RechargeConfig>) => j<{ok: boolean}>("/api/recharge/config", {method: "POST", body: JSON.stringify(cfg)}),
    // 卡密池
    rechargeCards: () => j<{list: RechargeCard[]; stats: RechargeCardStats}>("/api/recharge/cards"),
    importRechargeCards: (text: string, batch?: string) =>
        j<{inserted: number; skipped: number; total: number}>("/api/recharge/cards/import", {method: "POST", body: JSON.stringify({text, batch})}),
    deleteRechargeCards: (ids: number[]) =>
        j<{ok: boolean; count: number}>("/api/recharge/cards/delete", {method: "POST", body: JSON.stringify({ids})}),
    validateRechargeCards: (ids: number[]) =>
        j<{ok: boolean; count: number}>("/api/recharge/cards/validate", {method: "POST", body: JSON.stringify({ids})}),
    unpairRechargeCards: (ids: number[]) =>
        j<{ok: boolean}>("/api/recharge/cards/unpair", {method: "POST", body: JSON.stringify({ids})}),
    // 充值队列
    rechargeQueue: () => j<{list: RechargeQueueItem[]; stats: RechargeQueueStats}>("/api/recharge/queue"),
    rechargeQueueBatches: () => j<{name: string; n: number}[]>("/api/recharge/queue/batches"),
    rechargeableAccounts: () => j<Account[]>("/api/recharge/accounts"),
    addToRechargeQueue: (accountIds: number[], batch?: string) =>
        j<{ok: boolean; added: number}>("/api/recharge/queue/add", {method: "POST", body: JSON.stringify({accountIds, batch})}),
    removeFromRechargeQueue: (ids: number[]) =>
        j<{ok: boolean; count: number}>("/api/recharge/queue/remove", {method: "POST", body: JSON.stringify({ids})}),
    setRechargeQueueBatch: (ids: number[], batch: string) =>
        j<{ok: boolean}>("/api/recharge/queue/set-batch", {method: "POST", body: JSON.stringify({ids, batch})}),
    resetRechargeQueue: (ids: number[]) =>
        j<{ok: boolean}>("/api/recharge/queue/reset", {method: "POST", body: JSON.stringify({ids})}),
    // 提交 / 控制
    submitRecharge: (queueIds: number[]) =>
        j<{ok: boolean; paired: number}>("/api/recharge/submit", {method: "POST", body: JSON.stringify({queueIds})}),
    stopRecharge: () => j<{ok: boolean}>("/api/recharge/stop", {method: "POST"}),
    pollRecharge: (ids?: number[]) => j<{ok: boolean; updated: number}>("/api/recharge/poll", {method: "POST", body: JSON.stringify({ids})}),
    // 导出 / RT 获取
    exportRechargeQueue: async (opts: {ids?: number[]; batch?: string; format: "account" | "full"}): Promise<{text?: string; async?: boolean; needRt?: number}> => {
        const res = await fetch("/api/recharge/queue/export", {method: "POST", headers: {"Content-Type": "application/json"}, body: JSON.stringify(opts)});
        if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `HTTP ${res.status}`);
        const ct = res.headers.get("content-type") || "";
        if (ct.includes("text/plain")) return {text: await res.text()};
        return res.json();
    },
    probePlan: (ids?: number[], batch?: string) =>
        j<{ok: boolean; count: number}>("/api/recharge/queue/probe-plan", {method: "POST", body: JSON.stringify({ids, batch})}),
};

export type StreamHandler = (event: string, data: any) => void;

export function connectStream(onEvent: StreamHandler): () => void {
    const es = new EventSource("/api/stream");
    for (const name of ["hello", "log", "status", "stats", "snapshot", "sms", "daily", "mailboxes", "mbLog", "claude", "claudeLog", "claudeScan", "batchAt", "batchPw", "refreshAt", "batchRtAcquire", "recharge", "rechargeLog", "rechargeQueue"]) {
        es.addEventListener(name, (e: MessageEvent) => {
            try { onEvent(name, JSON.parse(e.data)); } catch { /* ignore */ }
        });
    }
    return () => es.close();
}
