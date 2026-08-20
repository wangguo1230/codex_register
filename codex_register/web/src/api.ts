// 后端 REST + SSE 封装
export interface Account {
    id: number;
    email: string;
    password: string;
    status: "pending" | "running" | "success" | "failed";
    plan: string;
    /** 列表接口不再下发 JWT；详情/导出才有。用 has_token 判断是否有 AT */
    token?: string;
    has_token?: boolean;
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
    gpt_password?: string;
    totp_secret?: string;
    mailbox_totp?: string; // 邮箱侧 TOTP(谷歌 2FA)
    provider?: string;
    mfa_status?: string;
    batch?: string; // 导入批次名
    deleted_at?: number; // >0=已删除(GPT 记录软删或邮箱软删联动),仅搜索时带出
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
    password_prev?: string;
    provider: string;
    usage: "free" | "hold" | "gpt" | "claude" | "deleted"; // free=待分配 hold=独立 gpt/claude=已归属 deleted=已删除
    grp?: string;
    pw_status?: string;
    note?: string;
    recovery_email?: string;
    totp_secret?: string;
    totp_secret_orig?: string;
    imap_password?: string;
    deleted_at?: number;
    sold_at?: number;
    proxy_ip?: string;
    proxy_fail?: number;
    proxy_session?: string;
    has_proxy?: boolean;
    google_stage?: string;
    google_state?: {
        stage?: string;
        login?: string;
        login_error?: string;
        phone?: string;
        recovery?: string;
        totp?: string;
        password?: string;
        devices?: string;
        imap?: string;
        gpt?: string;
        totp_rotated?: boolean;
        last_error?: string;
        imap_gen_fail?: number;
        imap_next_try?: number;
        updated_at?: number;
    };
    created_at: number;
}

export interface MailSendLog {
    id: number;
    mailbox_id: number;
    email: string;
    to_email: string;
    subject: string;
    status: "pending" | "sent" | "fail" | string;
    http_status?: number;
    location?: string;
    error?: string;
    proxy_url?: string;
    proxy_session?: string;
    proxy_ip?: string;
    jump_url?: string;
    reused?: number;
    created_at: number;
}

export interface MailboxJobWindow {
    id: string;
    name: string;
    remark: string;
    status: number;
    createdTime?: string;
}
export interface MailboxJobCurrent {
    id: number;
    email: string;
    lastLine: string;
    instanceId?: string;
    kind?: string;
    claimedAt?: number;
    elapsedMs?: number;
}
export interface MailJobHourStat {
    at: number;
    done: number;
    ok: number;
    fail: number;
}
export interface MailFarmInstance {
    instanceId: string;
    stopClaim: boolean;
    proxySlots: number;
    proxyLeased: number;
    runningJobs: number;
    lastSeen: number;
    free: number;
}
export interface MailJobKindStat {
    pending: number;
    running: number;
    done: number;
    error: number;
    ok: number;
}
export interface MailboxJob {
    running: boolean;
    kind?: string;
    done: number;
    total: number;
    ok: number;
    fail?: number;
    runningCount?: number;
    queued?: number;
    rate?: number;
    stopped?: boolean;
    lastLine?: string;
    current?: MailboxJobCurrent[];
    windows?: MailboxJobWindow[];
    byKind?: Record<string, MailJobKindStat>;
    instances?: MailFarmInstance[];
    instanceId?: string;
    source?: string;
    startedAt?: number;
    endedAt?: number;
    elapsedMs?: number;
    avgMs?: number;
    etaMs?: number;
    hourly?: MailJobHourStat[];
    hourNow?: MailJobHourStat | null;
    failEmails?: string[];
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
    rebindConcurrency: number;
    interval: number;
    rtProxy: string;
    rtConcurrency: number;
    instanceId?: string;
    rebindGmailAfterPaid?: boolean;
    rebindAfterPaid?: "off" | "gmail" | "mailcom";
    rebindGmailProbeLogin?: boolean;
    gmailFreeImap?: number;
    mailcomFree?: number;
    jobs?: RechargeJobs;
}

export interface RechargeJobs {
    submit?: boolean;
    reloginSubmit?: boolean;
    relogin?: boolean;
    exportRt?: boolean;
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
    /** 充值队列分组；batch 是兼容旧接口的同值字段 */
    recharge_group?: string;
    /** GPT 账号来源批次 */
    source_batch?: string;
    /** 邮箱管理分组，仅用于展示核对，不参与充值分组筛选 */
    mailbox_group?: string;
    card_id: number;
    card_code: string;
    status: "pending" | "paired" | "submitting" | "submitted" | "done" | "error";
    task_no: string;
    task_status: string;
    task_message: string;
    error: string;
    plan_type: string;
    /** ok=已换绑；pending=换绑中；fail=失败；unknown=官方是否已改未知，等对账 */
    rebind_status?: "" | "ok" | "pending" | "fail" | "unknown" | "skipped" | string;
    rebind_email?: string;
    rebind_error?: string;
    rebind_target?: string;
    /** 换绑前原始邮箱（首次换绑写入后保留） */
    rebind_from?: string;
    /** 待核对时正在尝试换到的目标邮箱 */
    rebind_attempt_email?: string;
    /** 官方 24h 换绑上限的解禁时间戳；>now 时点换绑只会白打一次官方接口 */
    rebind_blocked_until?: number;
    /** undelivered=作业中；delivered=已交付（移出队列） */
    delivery_status?: "undelivered" | "delivered" | string;
    delivered_at?: number;
    created_at: number;
    submitted_at: number;
    finished_at?: number;
    instance_id?: string;
    rebind_instance?: string;
    rebind_attempt_stage?: string;
}

export interface RechargeQueueStats {
    pending: number;
    paired: number;
    submitting: number;
    submitted: number;
    done: number;
    error: number;
    total: number;
    undelivered?: number;
    delivered?: number;
    failed?: number;
    working?: number;
    ready?: number;
}

/** Gmail 验证池 / 换绑池 一行（含账密） */
export interface RebindGmailPoolItem {
    id: number;
    email: string;
    grp: string;
    password?: string;
    totp_secret?: string;
    imap_password?: string;
    google_stage?: string;
}

export interface RebindGmailPoolResponse {
    ok: boolean;
    poolGrp: string;
    list: RebindGmailPoolItem[];
    groups: {grp: string; n: number}[];
    count: number;
    staging: RebindGmailPoolItem[];
    stagingCount: number;
    ready: RebindGmailPoolItem[];
    readyCount: number;
}

export interface XrayStatus {
    running: boolean;
    port: number;
    node: string;
    vless: string;
    pid: number;
    error: string;
}

export interface JumpPoolItem {
    url: string;
    masked: string;
    leased: number;
    cap: number;
    owners: string[];
    ok: boolean | null;
    ip: string;
    reason: string;
    ms: number;
    node?: string;
    port?: number;
    xray?: boolean | null;
    source?: string;
    xrayError?: string;
}

export interface JumpPoolSnap {
    ok: boolean;
    total: number;
    maxPerJump: number;
    lines?: string[];
    items: JumpPoolItem[];
}

export interface SharedProxyPoolSnap {
    ok: boolean;
    urls: string[];
    lines: string[];
    total: number;
    slots: number;
    leased: number;
    free: number;
    items: {url: string; masked: string; leased: boolean; owner: string}[];
    useForMail: boolean;
    useForGpt: boolean;
    jump: JumpPoolSnap & {lines: string[]; useForMail: boolean; useForGpt: boolean};
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
    sharedProxyPool: () => j<SharedProxyPoolSnap>("/api/proxy-pool"),
    setSharedProxyPool: (text: string, opts?: {append?: boolean; copies?: number; useForMail?: boolean; useForGpt?: boolean}) =>
        j<SharedProxyPoolSnap & {inserted?: number; skipped?: number}>("/api/proxy-pool", {method: "POST", body: JSON.stringify({text, append: !!opts?.append, copies: opts?.copies || 1, ...(opts?.useForMail !== undefined ? {useForMail: opts.useForMail} : {}), ...(opts?.useForGpt !== undefined ? {useForGpt: opts.useForGpt} : {})})}),
    setSharedProxyScopes: (scopes: {mail?: boolean; gpt?: boolean}) =>
        j<SharedProxyPoolSnap>("/api/proxy-pool/scopes", {method: "POST", body: JSON.stringify(scopes)}),
    setSharedJumpPool: (text: string, opts?: {check?: boolean; useForMail?: boolean; useForGpt?: boolean}) =>
        j<SharedProxyPoolSnap>("/api/proxy-jump-pool", {method: "POST", body: JSON.stringify({text, check: !!opts?.check, ...(opts?.useForMail !== undefined ? {useForMail: opts.useForMail} : {}), ...(opts?.useForGpt !== undefined ? {useForGpt: opts.useForGpt} : {})})}),
    setSharedJumpScopes: (scopes: {mail?: boolean; gpt?: boolean}) =>
        j<SharedProxyPoolSnap>("/api/proxy-jump-pool/scopes", {method: "POST", body: JSON.stringify(scopes)}),
    checkSharedJumpPool: () => j<SharedProxyPoolSnap>("/api/proxy-jump-pool/check", {method: "POST", body: JSON.stringify({})}),
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
    listAccounts: (deleted?: boolean) => j<Account[]>(`/api/accounts${deleted ? '?deleted=1' : ''}`),
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
    setMfa: (enabled: boolean) => j<{mfaEnabled: boolean}>("/api/control/mfa", {method: "POST", body: JSON.stringify({enabled})}),
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
    refreshTokens: (items: {email: string; password: string; rt: string}[]) =>
        j<{results: {email: string; password?: string; ok: boolean; reason?: string; tokens?: {access_token: string; refresh_token: string; id_token?: string; account_id?: string}}[]}>("/api/tools/refresh-tokens", {method: "POST", body: JSON.stringify({items})}),
    stopBatchRefreshAt: () => j<{ok: boolean}>("/api/tools/batch-refresh-at/stop", {method: "POST"}),
    testAt: (id: number) => j(`/api/accounts/${id}/test-at`, {method: "POST"}),
    testRt: (id: number) => j(`/api/accounts/${id}/test-rt`, {method: "POST"}),
    testChat: (id: number) => j(`/api/accounts/${id}/test-chat`, {method: "POST"}),
    enrollMfa: (ids: number[]) => j<{ok: boolean; count: number}>("/api/control/enroll-mfa", {method: "POST", body: JSON.stringify({ids})}),
    batchTestAt: (ids: number[], relogin = false) => j<{count: number}>("/api/control/test-at", {method: "POST", body: JSON.stringify({ids, relogin})}),
    batchAtStatus: () => j<{ok: boolean; running: boolean; done: number; total: number; lock?: string}>("/api/control/test-at/status"),
    stopBatchAt: (force = false) => j<{ok: boolean; msg?: string; forced?: boolean; running?: boolean}>("/api/control/test-at/stop", {method: "POST", body: JSON.stringify({force: !!force})}),
    // acquire=true:过期/无rt 的号重登获取 rt(走 codex OAuth+接码,有成本);false:只刷新有效 rt、标记失效
    batchTestRt: (ids: number[], acquire = false) => j<{count: number}>("/api/control/test-rt", {method: "POST", body: JSON.stringify({ids, acquire})}),
    batchTestChat: (ids: number[]) => j<{count: number}>("/api/control/test-chat", {method: "POST", body: JSON.stringify({ids})}),
    retryFailed: () => j("/api/control/retry-failed", {method: "POST"}),
    state: () => j<{state: {instanceId?: string; paused: boolean; pausedClaude?: boolean; claudeProxy?: string; claudeXrayVless?: string; claudeXray?: XrayStatus; regProxyPort?: number; claudeProxyPort?: number; runningClaude?: number[]; concurrency: number; otpSingle: boolean; simulateChat: boolean; smsEnabled: boolean; rtEnabled: boolean; mfaEnabled?: boolean; bitBrowser?: boolean; smsMaxBind: number; regEngine: string; daily: Daily; xray: XrayStatus; smsLinkTemplate: string; regProxy: string; mailProxy: string; mailProxyEnabled?: boolean; mailSeparator?: string; xrayBinPath?: string; xrayVless?: string; pwConcurrency?: number; defaultPassword?: string; running: number[]; batchPw?: {running: boolean; done: number; total: number}}; stats: Stats}>("/api/state"),
    // ★统一导出(合并原下载菜单+批量导出)。范围×scope×格式×标记已售出一站式;POST 返回纯文本供 blob 下载。
    //   范围:ids(选中/当前筛选) 或 batch(按批次) 或都不传(全部成功号)。
    exportFull: async (opts: {format: "full" | "at" | "session" | "jsonl" | "csv"; scope?: "all" | "hasRt" | "atOnly"; batch?: string; ids?: number[]; markSold?: boolean}): Promise<string> => {
        const res = await fetch("/api/export/full", {method: "POST", headers: {"Content-Type": "application/json"}, body: JSON.stringify(opts)});
        if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `HTTP ${res.status}`);
        return res.text();
    },
    // ---- 邮箱域:资源池(free/gpt/claude 隔离) ----
    listMailboxes: (usage?: string) =>
        j<{list: Mailbox[]; stats: {free: number; hold: number; gpt: number; claude: number; total: number; deleted: number}; groups: {grp: string; n: number}[]}>(`/api/mailboxes${usage ? `?usage=${usage}` : ""}`),
    // autoChangePw:导入后自动改随机20位;hold:导入即独立;autoHarden:Gmail 导入后立刻批量整备
    importFreeMailboxes: (text: string, defaultPassword?: string, grp?: string, autoChangePw?: boolean, hold?: boolean, provider?: string, autoHarden?: boolean) =>
        j<{inserted: number; skipped: number; total: number; ids?: number[]; emails?: string[]; autoChangePw?: number; autoHarden?: number; hardenError?: string; hardenConcurrency?: number}>(
            "/api/mailboxes/import", {method: "POST", body: JSON.stringify({text, defaultPassword, grp, autoChangePw, hold, provider, autoHarden: !!autoHarden})}),
    lookupMailboxes: (emails: string[] | string) =>
        j<{list: Mailbox[]; queried: string[]; found: string[]; missing: string[]}>(
            "/api/mailboxes/lookup", {method: "POST", body: JSON.stringify(Array.isArray(emails) ? {emails} : {text: emails})}),
    // 切换邮箱状态 free(待分配) ↔ hold(独立);单个 / 批量
    setMailboxUsage: (id: number, usage: "free" | "hold") => j<{ok: boolean; usage: string}>(`/api/mailboxes/${id}/usage`, {method: "POST", body: JSON.stringify({usage})}),
    setMailboxesUsage: (ids: number[], usage: "free" | "hold") => j<{ok: boolean; count: number}>("/api/mailboxes/usage", {method: "POST", body: JSON.stringify({ids, usage})}),
    setMailboxesGrp: (ids: number[], grp: string) => j<{ok: boolean; count: number; grp: string}>("/api/mailboxes/grp", {method: "POST", body: JSON.stringify({ids, grp})}),
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
        j<{allocated?: number; skipped?: number; skippedImap?: number; skippedHarden?: number; skippedSold?: number; skippedBusy?: number; changePwFirst?: boolean; willChange?: number; error?: string}>(
            "/api/mailboxes/allocate", {method: "POST", body: JSON.stringify({usage, ids, batch: batch || "", changePwFirst: !!changePwFirst})}),
    deleteMailbox: (id: number) => j<{ok: boolean; reason?: string}>(`/api/mailboxes/${id}`, {method: "DELETE"}),
    batchDeleteMailbox: (ids: number[]) => j<{ok: boolean; count: number; skipped: number}>("/api/mailboxes/batch-delete", {method: "POST", body: JSON.stringify({ids})}),
    changeMailboxPasswd: (id: number, newPassword?: string) =>
        j<{ok: boolean; queued?: boolean; newPassword: string; detail?: string; count?: number}>(`/api/mailboxes/${id}/change-passwd`, {method: "POST", body: JSON.stringify({newPassword: newPassword || ""})}),
    changeMailboxGoogle2fa: (id: number) =>
        j<{ok: boolean; queued?: boolean; totpSecret?: string; error?: string; count?: number}>(`/api/mailboxes/${id}/google-2fa`, {method: "POST"}),
    hardenMailboxGoogle: (id: number) =>
        j<{ok: boolean; queued?: boolean; count?: number; concurrency?: number; proxies?: number; password?: string; totpSecret?: string; imap?: boolean; recoveryCleared?: boolean; errors?: string[]; error?: string}>(
            `/api/mailboxes/${id}/google-harden`, {method: "POST"}),
    batchHardenMailboxGoogle: (ids: number[]) =>
        j<{ok: boolean; count: number; concurrency: number; proxies: number}>("/api/mailboxes/batch-google-harden", {method: "POST", body: JSON.stringify({ids})}),
    stopBatchHardenMailboxGoogle: () => j<{ok: boolean; closed?: number}>("/api/mailboxes/batch-google-harden/stop", {method: "POST"}),
    resumeHardenMailboxGoogle: (ids?: number[]) =>
        j<{ok: boolean; count: number; recovered?: number; skipped?: number; skippedDone?: number; msg?: string}>("/api/mailboxes/batch-google-harden/resume", {method: "POST", body: JSON.stringify(ids?.length ? {ids} : {})}),
    retryFailedMailboxJobs: (ids?: number[]) =>
        j<{ok: boolean; count: number; skippedDone?: number; msg?: string}>("/api/mailboxes/jobs/retry-failed", {method: "POST", body: JSON.stringify(ids?.length ? {ids} : {})}),
    latestJobErrors: () =>
        j<{ok: boolean; emails: string[]; count: number}>("/api/mailboxes/jobs/latest-errors"),
    mailboxJob: () => j<{ok: boolean; batchHarden: MailboxJob; batchPw: MailboxJob; job: MailboxJob; instances?: MailFarmInstance[]}>("/api/mailboxes/job"),
    mailProxyPool: () => j<{ok: boolean; urls: string[]; lines?: string[]; jump?: string; total: number; slots: number; leased: number; free: number; items: {url: string; masked: string; leased: boolean; owner: string}[]}>("/api/mailboxes/proxy-pool"),
    setMailProxyPool: (text: string, opts?: {append?: boolean; copies?: number}) =>
        j<{ok: boolean; urls: string[]; lines?: string[]; jump?: string; total: number; slots: number; leased: number; free: number; inserted?: number; skipped?: number}>(
            "/api/mailboxes/proxy-pool", {method: "POST", body: JSON.stringify({text, append: !!opts?.append, copies: opts?.copies || 1})}),
    setMailProxyJump: (jump: string) => j<{ok: boolean; jump: string}>("/api/mailboxes/proxy-jump", {method: "POST", body: JSON.stringify({jump})}),
    mailJumpPool: () => j<JumpPoolSnap>("/api/mailboxes/jump-pool"),
    setMailJumpPool: (text: string, check?: boolean) =>
        j<JumpPoolSnap>("/api/mailboxes/jump-pool", {method: "POST", body: JSON.stringify({text, check: !!check})}),
    checkMailJumpPool: () =>
        j<JumpPoolSnap>("/api/mailboxes/jump-pool/check", {method: "POST", body: JSON.stringify({})}),
    testMailProxyJump: (jump?: string) =>
        j<{ok: boolean; jump?: string; sample?: string; ip?: string; google?: number; ms?: number; reason?: string; error?: string}>(
            "/api/mailboxes/proxy-jump/test", {method: "POST", body: JSON.stringify({jump: jump || ""})}),
    sendMailcom: (body: {email?: string; mailboxId?: number; to: string | string[]; subject?: string; html?: string; text?: string; fromName?: string}) =>
        j<{ok: boolean; status?: number; location?: string; from?: string; proxySession?: string; proxyIp?: string; proxyMasked?: string; jumpMasked?: string; reused?: boolean; error?: string}>(
            "/api/mailcom/send", {method: "POST", body: JSON.stringify(body)}),
    sendMailbox: (body: {email?: string; mailboxId?: number; to: string | string[]; subject: string; html?: string; text?: string; fromName?: string}) =>
        j<{ok: boolean; status?: number; from?: string; to?: string[]; via?: string; proxySession?: string; proxyIp?: string; proxyMasked?: string; jumpMasked?: string; reused?: boolean; error?: string}>(
            "/api/mail/send", {method: "POST", body: JSON.stringify(body)}),
    sendMailcomBatch: (items: any[], concurrency?: number) =>
        j<{ok: boolean; total: number; sent: number; failed: number; items: any[]}>("/api/mailcom/send-batch", {method: "POST", body: JSON.stringify({items, concurrency})}),
    mailSendLogs: (email?: string, limit = 50) =>
        j<{ok: boolean; items: MailSendLog[]}>(`/api/mail/send-logs?email=${encodeURIComponent(email || "")}&limit=${limit}`),
    rechargeSendPreview: (ids: number[], to?: string) =>
        j<{ok: boolean; to: string; items: {id: number; queueEmail: string; from: string; rebound: boolean; to: string; subject: string; text: string; html: string; canSend: boolean; reason: string; group: string}[]}>(
            "/api/recharge/queue/send-preview", {method: "POST", body: JSON.stringify({ids, to: to || ""})}),
    rechargeTestSend: (ids: number[], to: string, opts?: {subject?: string; html?: string; text?: string}) =>
        j<{ok: boolean; async?: boolean; queued?: number; skipped?: number; to: string; sent?: number; failed?: number; error?: string; preview?: any[]}>(
            "/api/recharge/queue/test-send", {method: "POST", body: JSON.stringify({ids, to, ...opts})}),
    rechargeTestSendStatus: () =>
        j<{ok: boolean; running: boolean; stop?: boolean; to: string; queued: number; sent: number; failed: number; skipped: number; error: string; startedAt: number; finishedAt: number}>(
            "/api/recharge/queue/test-send"),
    stopTestSend: () =>
        j<{ok: boolean; running?: boolean}>("/api/recharge/queue/test-send/stop", {method: "POST"}),
    gptProxyPool: () => j<{ok: boolean; urls: string[]; lines?: string[]; jump?: string; total: number; slots: number; leased: number; free: number; items: {url: string; masked: string; leased: boolean; owner: string}[]}>("/api/gpt/proxy-pool"),
    setGptProxyPool: (text: string, opts?: {append?: boolean; copies?: number}) =>
        j<{ok: boolean; urls: string[]; lines?: string[]; jump?: string; total: number; slots: number; leased: number; free: number; inserted?: number; skipped?: number}>(
            "/api/gpt/proxy-pool", {method: "POST", body: JSON.stringify({text, append: !!opts?.append, copies: opts?.copies || 1})}),
    setGptProxyJump: (jump: string) => j<{ok: boolean; jump: string}>("/api/gpt/proxy-jump", {method: "POST", body: JSON.stringify({jump})}),
    gptJumpPool: () => j<JumpPoolSnap>("/api/gpt/jump-pool"),
    setGptJumpPool: (text: string, check?: boolean) =>
        j<JumpPoolSnap>("/api/gpt/jump-pool", {method: "POST", body: JSON.stringify({text, check: !!check})}),
    checkGptJumpPool: () =>
        j<JumpPoolSnap>("/api/gpt/jump-pool/check", {method: "POST", body: JSON.stringify({})}),
    testGptProxyJump: (jump?: string) =>
        j<{ok: boolean; jump?: string; sample?: string; ip?: string; google?: number; ms?: number; reason?: string; error?: string}>(
            "/api/gpt/proxy-jump/test", {method: "POST", body: JSON.stringify({jump: jump || ""})}),
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
    startJumpXray: (vlessUrl: string) => j<{ok: boolean; xray: XrayStatus; jump: string; jumpPool?: JumpPoolSnap}>("/api/control/jump-xray", {method: "POST", body: JSON.stringify({vlessUrl})}),
    stopJumpXray: () => j<{ok: boolean; xray: XrayStatus}>("/api/control/jump-xray/stop", {method: "POST"}),
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
    rechargeConfig: () => j<RechargeConfig & {hasKey: boolean; instanceId?: string}>("/api/recharge/config"),
    rechargeJobs: () => j<RechargeJobs>("/api/recharge/jobs"),
    setRechargeConfig: (cfg: Partial<RechargeConfig>) => j<{ok: boolean; rebindGmailAfterPaid?: boolean; rebindAfterPaid?: "off" | "gmail" | "mailcom"; rebindGmailProbeLogin?: boolean; gmailFreeImap?: number; mailcomFree?: number}>("/api/recharge/config", {method: "POST", body: JSON.stringify(cfg)}),
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
    resetRechargeCards: (ids: number[]) =>
        j<{ok: boolean; count: number}>("/api/recharge/cards/reset", {method: "POST", body: JSON.stringify({ids})}),
    // 充值队列（delivery: undelivered 作业中 | error 失败页 | delivered 已交付 | all）
    rechargeQueue: (delivery: "undelivered" | "ready" | "delivered" | "error" | "all" = "undelivered") =>
        j<{list: RechargeQueueItem[]; stats: RechargeQueueStats; delivery?: string}>(`/api/recharge/queue?delivery=${encodeURIComponent(delivery)}`),
    rechargeQueueBatches: (delivery?: "undelivered" | "ready" | "delivered" | "error" | "all") =>
        j<{name: string; n: number}[]>(`/api/recharge/queue/batches${delivery ? `?delivery=${encodeURIComponent(delivery)}` : ""}`),
    rechargeableAccounts: () => j<Account[]>("/api/recharge/accounts"),
    addToRechargeQueue: (accountIds: number[], batch?: string) =>
        j<{ok: boolean; added: number}>("/api/recharge/queue/add", {method: "POST", body: JSON.stringify({accountIds, batch})}),
    /** 标记已交付（原「移出队列」）：进已交付 tab，保留换绑记录，不删号 */
    removeFromRechargeQueue: (ids: number[]) =>
        j<{ok: boolean; count: number}>("/api/recharge/queue/remove", {method: "POST", body: JSON.stringify({ids})}),
    /** cardsRemoved：交付时顺带从卡密池删掉的已用卡数量 */
    deliverRechargeQueue: (ids: number[]) =>
        j<{ok: boolean; count: number; skipped?: number; cardsRemoved?: number}>("/api/recharge/queue/deliver", {method: "POST", body: JSON.stringify({ids})}),
    /** 已交付 → 退回未交付（误点恢复） */
    undeliverRechargeQueue: (ids: number[]) =>
        j<{ok: boolean; count: number}>("/api/recharge/queue/undeliver", {method: "POST", body: JSON.stringify({ids})}),
    setRechargeQueueBatch: (ids: number[], batch: string) =>
        j<{ok: boolean}>("/api/recharge/queue/set-batch", {method: "POST", body: JSON.stringify({ids, batch})}),
    resetRechargeQueue: (ids: number[]) =>
        j<{ok: boolean; reset: number; reclaimed: number; kept: number; skipped: number}>("/api/recharge/queue/reset", {method: "POST", body: JSON.stringify({ids})}),
    markRechargeQueueError: (ids: number[], reason?: string) =>
        j<{ok: boolean; count: number; reclaimed?: number; skipped?: number}>("/api/recharge/queue/mark-error", {method: "POST", body: JSON.stringify({ids, error: reason || ""})}),
    rechargeQueueRelogin: (ids: number[]) =>
        j<{ok: boolean; count: number; claimed?: number; skipped?: number; instanceId?: string}>("/api/recharge/queue/relogin", {method: "POST", body: JSON.stringify({ids})}),
    // 一条龙:浏览器重登刷新 session → 验卡 → 重置任务 → 用同一张卡密重提(卡密非 unused 则跳过)
    rechargeQueueReloginSubmit: (ids: number[]) =>
        j<{ok: boolean; count: number; queued?: number; claimed?: number; skipped?: number; instanceId?: string}>("/api/recharge/queue/relogin-submit", {method: "POST", body: JSON.stringify({ids})}),
    stopRechargeQueueRelogin: () => j<{ok: boolean}>("/api/recharge/queue/relogin/stop", {method: "POST"}),
    reclaimCards: (ids: number[]) =>
        j<{ok: boolean; reclaimed: number; used: number; failed: number}>("/api/recharge/queue/reclaim-cards", {method: "POST", body: JSON.stringify({ids})}),
    // 提交 / 控制
    submitRecharge: (queueIds: number[]) =>
        j<{ok: boolean; paired: number}>("/api/recharge/submit", {method: "POST", body: JSON.stringify({queueIds})}),
    stopRecharge: () => j<{ok: boolean}>("/api/recharge/stop", {method: "POST"}),
    recoverRecharge: (ids: number[]) => j<{
        ok: boolean;
        selected: number;
        notFound: number;
        rechargeLeases: number;
        pairedReset: number;
        preserved: number;
        review: number;
        rebindLeases: number;
        rebindUnknown: number;
        rebindMailboxes: number;
        activeSkipped: number;
    }>("/api/recharge/recover", {method: "POST", body: JSON.stringify({ids})}),
    pollRecharge: (ids?: number[]) => j<{ok: boolean; updated: number}>("/api/recharge/poll", {method: "POST", body: JSON.stringify({ids})}),
    rebindGmailPool: () => j<RebindGmailPoolResponse>("/api/recharge/rebind-gmail/pool"),
    markRebindGmailUnavailable: (ids: number[], reason?: string) =>
        j<{ok: boolean; count: number; gmailFreeImap?: number; mailcomFree?: number}>(
            "/api/recharge/rebind-gmail/mark-unavailable",
            {method: "POST", body: JSON.stringify({ids, reason: reason || "登录不可用"})},
        ),
    migrateToRebindGmailPool: (ids: number[], opts?: {concurrency?: number}) =>
        j<{ok: boolean; count: number; skipped?: {id: number; email: string; reason: string}[]; poolGrp?: string; gmailFreeImap?: number; mailcomFree?: number}>(
            "/api/recharge/rebind-gmail/migrate",
            {method: "POST", body: JSON.stringify({ids, ...(opts || {})})},
        ),
    demoteFromRebindGmailPool: (ids: number[], grp?: string) =>
        j<{ok: boolean; count: number; gmailFreeImap?: number; mailcomFree?: number}>(
            "/api/recharge/rebind-gmail/demote",
            {method: "POST", body: JSON.stringify({ids, grp: grp ?? ""})},
        ),
    rebindGmail: (ids: number[], target?: "gmail" | "mailcom", opts?: {emails?: string[]; grp?: string; text?: string; allowDelivered?: boolean}) =>
        j<{ok: boolean; queued: number; skipped: {email: string; reason: string}[]; gmailFreeImap?: number; mailcomFree?: number}>("/api/recharge/rebind-gmail", {method: "POST", body: JSON.stringify({ids, target, ...(opts || {})})}),
    cancelRebindGmail: (ids: number[]) =>
        j<{ok: boolean; count: number}>("/api/recharge/rebind-gmail/cancel", {method: "POST", body: JSON.stringify({ids})}),
    /** 换绑状态待核对：去官方读当前登录邮箱，自动收敛成 ok / fail */
    reconcileRebind: (ids?: number[]) =>
        j<{ok: boolean; done?: number; pending?: number; message?: string; skipped?: {email: string; reason: string}[]}>(
            "/api/recharge/rebind-gmail/reconcile",
            {method: "POST", body: JSON.stringify({ids})},
        ),
    rechargeLogs: () => j<{ts: number; line: string}[]>("/api/recharge/logs"),
    clearRechargeLogs: () => j<{ok: boolean}>("/api/recharge/logs/clear", {method: "POST"}),
    // 导出 / RT 获取
    exportRechargeQueue: async (opts: {ids?: number[]; batch?: string; format: "account" | "full" | "card" | "session" | "sub2json"; relogin?: boolean}): Promise<{text?: string; async?: boolean; needRt?: number; total?: number; withRt?: number; missingRt?: number; ok?: boolean; relogin?: boolean}> => {
        const res = await fetch("/api/recharge/queue/export", {method: "POST", headers: {"Content-Type": "application/json"}, body: JSON.stringify(opts)});
        if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `HTTP ${res.status}`);
        const ct = res.headers.get("content-type") || "";
        if (ct.includes("text/plain")) return {text: await res.text()};
        return res.json();
    },
    exportRechargeSub2json: (opts: {ids: number[]; concurrency?: number}) =>
        j<{ok: boolean; async?: boolean; total?: number; needRt?: number; concurrency?: number; error?: string}>(
            "/api/recharge/queue/export-sub2json",
            {method: "POST", body: JSON.stringify(opts)},
        ),
    stopExportRt: () => j<{ok: boolean; running?: boolean}>("/api/recharge/queue/export/stop", {method: "POST"}),
    probePlan: (ids?: number[], batch?: string) =>
        j<{ok: boolean; count: number}>("/api/recharge/queue/probe-plan", {method: "POST", body: JSON.stringify({ids, batch})}),
};

export type StreamHandler = (event: string, data: any) => void;
export type StreamStateHandler = (connected: boolean) => void;

export function connectStream(onEvent: StreamHandler, onState?: StreamStateHandler): () => void {
    const es = new EventSource("/api/stream");
    es.onopen = () => onState?.(true);
    es.onerror = () => onState?.(false);
    for (const name of ["hello", "log", "status", "stats", "snapshot", "sms", "daily", "mailboxes", "mbLog", "claude", "claudeLog", "claudeScan", "batchAt", "batchPw", "batchHarden", "refreshAt", "batchRtAcquire", "recharge", "rechargeLog", "rechargeQueue", "rechargeExportReady", "rechargeSendDone", "rechargeJobs"]) {
        es.addEventListener(name, (e: MessageEvent) => {
            try { onEvent(name, JSON.parse(e.data)); } catch { /* ignore */ }
        });
    }
    return () => {
        onState?.(false);
        es.close();
    };
}
