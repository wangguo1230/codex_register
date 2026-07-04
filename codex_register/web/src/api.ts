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
    usage: "free" | "gpt" | "claude";
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
    // 批量串行改密(ids 不传=所有注册成功且未改过密码的号),后台跑、SSE 推进度
    batchChangePasswd: (ids?: number[]) => j<{ok: boolean; count: number; msg?: string}>("/api/accounts/batch-change-passwd", {method: "POST", body: JSON.stringify(ids ? {ids} : {})}),
    stopBatchPasswd: () => j<{ok: boolean; msg?: string}>("/api/control/batch-passwd/stop", {method: "POST"}),
    // 人工确认改密成功(采用 pw_status 里试过的新密码,或指定 password),状态转已改
    confirmChanged: (id: number, password?: string) => j<{ok: boolean; password: string}>(`/api/accounts/${id}/confirm-changed`, {method: "POST", body: JSON.stringify(password ? {password} : {})}),
    // 独立小工具:批量校验邮箱密码(可选验证后改密)
    mailCheck: (items: {email: string; password: string}[], changePassword: boolean) =>
        j<{results: {email: string; ok: boolean; reason?: string; changed?: boolean; newPassword?: string}[]; changePassword: boolean}>(
            "/api/tools/mail-check", {method: "POST", body: JSON.stringify({items, changePassword})}),
    // 真·改邮箱密码(操作 mail.com 改密页),newPassword 留空后端随机生成 20 位
    changePasswd: (id: number, newPassword?: string) => j<{ok: boolean; newPassword: string}>(`/api/accounts/${id}/change-passwd`, {method: "POST", body: JSON.stringify({newPassword: newPassword || ""})}),
    start: (concurrency: number) => j("/api/control/start", {method: "POST", body: JSON.stringify({concurrency})}),
    pause: () => j("/api/control/pause", {method: "POST"}),
    stop: () => j("/api/control/stop", {method: "POST"}),
    setConcurrency: (concurrency: number) => j("/api/control/concurrency", {method: "POST", body: JSON.stringify({concurrency})}),
    setOtp: (single: boolean) => j("/api/control/otp", {method: "POST", body: JSON.stringify({single})}),
    setChat: (simulate: boolean) => j("/api/control/chat", {method: "POST", body: JSON.stringify({simulate})}),
    setProxy: (regProxy: string, mailProxy: string) => j("/api/control/proxy", {method: "POST", body: JSON.stringify({regProxy, mailProxy})}),
    startXray: (vlessUrl: string) => j<{xray: XrayStatus; regProxy: string}>("/api/control/xray", {method: "POST", body: JSON.stringify({vlessUrl})}),
    stopXray: () => j<{xray: XrayStatus}>("/api/control/xray/stop", {method: "POST"}),
    xrayProbe: () => j<{ok: boolean; ip?: string; chatgpt?: string; pass?: boolean; reason?: string}>("/api/control/xray/probe"),
    setSms: (enabled: boolean) => j("/api/control/sms", {method: "POST", body: JSON.stringify({enabled})}),
    setRt: (enabled: boolean) => j<{rtEnabled: boolean}>("/api/control/rt", {method: "POST", body: JSON.stringify({enabled})}),
    setAutoPasswd: (enabled: boolean) => j<{autoChangePasswd: boolean}>("/api/control/auto-passwd", {method: "POST", body: JSON.stringify({enabled})}),
    setBit: (enabled: boolean) => j<{bitBrowser: boolean}>("/api/control/bit", {method: "POST", body: JSON.stringify({enabled})}),
    setEngine: (engine: "http" | "browser") => j<{regEngine: string}>("/api/control/engine", {method: "POST", body: JSON.stringify({engine})}),
    setDaily: (cfg: Partial<{enabled: boolean; hour: number; items: {chat: boolean; rt: boolean; at: boolean}}>) => j<{daily: Daily}>("/api/control/daily", {method: "POST", body: JSON.stringify(cfg)}),
    runDaily: () => j<{started: boolean; accounts: number}>("/api/control/daily/run", {method: "POST", body: JSON.stringify({})}),
    saveSmsTemplate: (linkTemplate: string) => j<{smsLinkTemplate: string}>("/api/control/sms", {method: "POST", body: JSON.stringify({linkTemplate})}),
    setSmsMaxBind: (maxBind: number) => j<{smsMaxBind: number}>("/api/control/sms", {method: "POST", body: JSON.stringify({maxBind})}),
    importSms: (text: string) => j<{inserted: number; skipped: number; total: number; invalid?: {phone: string; reason: string}[]; verified?: boolean}>("/api/sms/import", {method: "POST", body: JSON.stringify({text})}),
    listSms: () => j<{list: any[]; stats: {free: number; used: number; bad: number; claimed: number; total: number}}>("/api/sms"),
    deleteSms: (id: number) => j(`/api/sms/${id}`, {method: "DELETE"}),
    peekSms: (id: number) => j<{text: string}>(`/api/sms/${id}/peek`),
    testAt: (id: number) => j(`/api/accounts/${id}/test-at`, {method: "POST"}),
    testRt: (id: number) => j(`/api/accounts/${id}/test-rt`, {method: "POST"}),
    testChat: (id: number) => j(`/api/accounts/${id}/test-chat`, {method: "POST"}),
    batchTestAt: (ids: number[], relogin = false) => j<{count: number}>("/api/control/test-at", {method: "POST", body: JSON.stringify({ids, relogin})}),
    stopBatchAt: () => j<{ok: boolean; msg?: string}>("/api/control/test-at/stop", {method: "POST"}),
    batchTestRt: (ids: number[]) => j<{count: number}>("/api/control/test-rt", {method: "POST", body: JSON.stringify({ids})}),
    batchTestChat: (ids: number[]) => j<{count: number}>("/api/control/test-chat", {method: "POST", body: JSON.stringify({ids})}),
    retryFailed: () => j("/api/control/retry-failed", {method: "POST"}),
    state: () => j<{state: {paused: boolean; concurrency: number; otpSingle: boolean; simulateChat: boolean; smsEnabled: boolean; rtEnabled: boolean; autoChangePasswd: boolean; bitBrowser?: boolean; smsMaxBind: number; regEngine: string; daily: Daily; xray: XrayStatus; smsLinkTemplate: string; regProxy: string; mailProxy: string; running: number[]; batchPw?: {running: boolean; done: number; total: number}}; stats: Stats}>("/api/state"),
    inbox: (id: number) => j<{email: string; mails: {id: string; from: string; subject: string; date: string}[]}>(`/api/accounts/${id}/inbox`),
    mailBody: (id: number, mailId: string) => j<{body: string}>(`/api/accounts/${id}/mail/${mailId}/body`),
    exportUrl: (format: "jsonl" | "csv" | "txt") => `/api/export?format=${format}`,
    // 新导出:格式区分带rt/只有at,可按批次(batch)/范围(scope)/选中(ids)
    exportFullUrl: (opts: {format: "txt" | "csv"; scope?: "all" | "hasRt" | "atOnly"; batch?: string; ids?: number[]; markSold?: boolean}) => {
        const p = new URLSearchParams({format: opts.format, scope: opts.scope || "all"});
        if (opts.batch != null) p.set("batch", opts.batch);
        if (opts.ids?.length) p.set("ids", opts.ids.join(","));
        if (opts.markSold) p.set("markSold", "1");
        return `/api/export/full?${p.toString()}`;
    },
    // 选中导出(邮箱----密码----rt----at 文本) + 可选标记已售出;返回纯文本供前端 blob 下载
    exportSelected: async (ids: number[], markSold: boolean): Promise<string> => {
        const res = await fetch("/api/export/selected", {method: "POST", headers: {"Content-Type": "application/json"}, body: JSON.stringify({ids, markSold})});
        if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `HTTP ${res.status}`);
        return res.text();
    },
    // ---- 邮箱域:资源池(free/gpt/claude 隔离) ----
    listMailboxes: (usage?: string) =>
        j<{list: Mailbox[]; stats: {free: number; gpt: number; claude: number; total: number}; groups: {grp: string; n: number}[]}>(`/api/mailboxes${usage ? `?usage=${usage}` : ""}`),
    // autoChangePw:导入后对新邮箱自动改随机20位(后台串行,SSE 推 batchPw 进度)
    importFreeMailboxes: (text: string, defaultPassword?: string, grp?: string, autoChangePw?: boolean) =>
        j<{inserted: number; skipped: number; total: number; autoChangePw?: number}>("/api/mailboxes/import", {method: "POST", body: JSON.stringify({text, defaultPassword, grp, autoChangePw})}),
    // 邮箱域批量改密(操作 mailboxes 表,覆盖 free/gpt/claude)。ids=选中的 mailbox id
    batchChangeMailboxPasswd: (ids: number[]) => j<{ok: boolean; count: number; msg?: string}>("/api/mailboxes/batch-change-passwd", {method: "POST", body: JSON.stringify({ids})}),
    // fromGrp:限定只从该分组的独立邮箱分配(避免误分想保留的);不传=全池,""=无分组桶。batch=业务号标签。
    allocateMailboxes: (usage: "gpt" | "claude", count: number, batch?: string, fromGrp?: string) =>
        j<{allocated: number; error?: string}>("/api/mailboxes/allocate", {method: "POST", body: JSON.stringify({usage, count, batch, ...(fromGrp !== undefined ? {fromGrp} : {})})}),
    deleteMailbox: (id: number) => j<{ok: boolean; reason?: string}>(`/api/mailboxes/${id}`, {method: "DELETE"}),
    changeMailboxPasswd: (id: number, newPassword?: string) =>
        j<{ok: boolean; newPassword: string; detail?: string}>(`/api/mailboxes/${id}/change-passwd`, {method: "POST", body: JSON.stringify({newPassword: newPassword || ""})}),
    // ---- Claude 域(架构 v2:与 GPT 对称命名空间 /api/claude/*)。注册机制待逆向,当前仅列表/分配可用 ----
    listClaudeAccounts: () => j<{list: ClaudeAccount[]; stats: Stats}>("/api/claude/accounts"),
};

export type StreamHandler = (event: string, data: any) => void;

export function connectStream(onEvent: StreamHandler): () => void {
    const es = new EventSource("/api/stream");
    for (const name of ["hello", "log", "status", "stats", "snapshot", "sms", "daily", "mailboxes"]) {
        es.addEventListener(name, (e: MessageEvent) => {
            try { onEvent(name, JSON.parse(e.data)); } catch { /* ignore */ }
        });
    }
    return () => es.close();
}
