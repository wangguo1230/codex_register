import React, {useEffect, useMemo, useRef, useState} from "react";
import {api, connectStream, type Account, type Stats, type Daily, type XrayStatus, type Mailbox} from "./api";
import {MailboxPanel} from "./MailboxPanel";
import {ClaudePanel} from "./ClaudePanel";
import {RechargePanel} from "./RechargePanel";
import {generateTotp, totpRemain} from "./totp";

const STATUS_STYLE: Record<string, string> = {
    pending: "bg-gray-200 text-gray-700",
    running: "bg-blue-100 text-blue-700 animate-pulse",
    success: "bg-green-100 text-green-700",
    failed: "bg-red-100 text-red-700",
};
const STATUS_LABEL: Record<string, string> = {
    pending: "等待", running: "运行中", success: "成功", failed: "失败",
};
// 时间戳 → "MM-DD HH:mm"；存活天数 = 距注册完成的整天数
const pad = (n: number) => String(n).padStart(2, "0");
function fmtDateTime(ts?: number | null): string {
    if (!ts) return "—";
    const d = new Date(ts);
    return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
// 存活天数：账号确认死亡(deadAt)后定格 = 死亡时间 - 注册时间；否则 = 现在 - 注册时间。ts=finished_at 优先,无则回退 createdAt
function aliveDays(ts?: number | null, deadAt?: number | null, createdAt?: number | null): string {
    const start = ts || createdAt;
    if (!start) return "—";
    const end = deadAt ? deadAt : Date.now();
    return Math.max(0, Math.floor((end - start) / 86400000)) + "天";
}
// 数字版存活天数(用于过期/正常筛选)。ts=finished_at 优先,无则回退 createdAt
function aliveDaysNum(ts?: number | null, deadAt?: number | null, createdAt?: number | null): number {
    const start = ts || createdAt;
    if (!start) return 0;
    const end = deadAt ? deadAt : Date.now();
    return Math.max(0, Math.floor((end - start) / 86400000));
}
// 注册耗时:完成 - 开始(started_at→finished_at),显示 X分X秒
function fmtDuration(startAt?: number | null, endAt?: number | null): string {
    if (!startAt || !endAt || endAt < startAt) return "—";
    const s = Math.round((endAt - startAt) / 1000);
    return s < 60 ? `${s}秒` : `${Math.floor(s / 60)}分${pad(s % 60)}秒`;
}
function accountGptPw(a: {gpt_password?: string}, fallback = "") {
    return String(a.gpt_password || fallback || "").trim();
}
function isGoogleMailbox(a: {provider?: string; email?: string}) {
    return a.provider === "google" || /@(gmail|googlemail)\.com$/i.test(a.email || "");
}
function exportableAccount(a: Account) {
    if (isGoogleMailbox(a) && String(a.gpt_password || "").trim()) return true;
    return a.status === "success" && !a.dead_at;
}

function TotpLive({secret}: {secret: string}) {
    const [code, setCode] = useState("");
    const [left, setLeft] = useState(30);
    useEffect(() => {
        let stop = false;
        const tick = async () => {
            if (stop) return;
            setCode(await generateTotp(secret));
            setLeft(totpRemain());
        };
        tick();
        const t = setInterval(tick, 1000);
        return () => { stop = true; clearInterval(t); };
    }, [secret]);
    if (!code) return null;
    return (
        <span className="inline-flex items-center gap-1.5">
            <span className="font-mono text-base tracking-widest text-emerald-700 select-all">{code}</span>
            <span className="text-[11px] text-gray-400">{left}s</span>
            <button type="button" className="text-[11px] text-indigo-600 hover:underline" onClick={() => navigator.clipboard?.writeText(code)}>复制码</button>
        </span>
    );
}

export default function App() {
    const [accounts, setAccounts] = useState<Account[]>([]);
    const [stats, setStats] = useState<Stats>({pending: 0, running: 0, success: 0, failed: 0, total: 0});
    const [paused, setPaused] = useState(true);
    const [instanceId, setInstanceId] = useState("");
    const [concurrency, setConcurrency] = useState(2);
    const [regEngine, setRegEngine] = useState<string>("http");
    const [expDays, setExpDays] = useState(10); // 过期阈值:注册满 N 天视为过期(网页 token 约 10 天)
    const [otpSingle, setOtpSingle] = useState(true);
    const [chatSim, setChatSim] = useState(true);
    const [regProxy, setRegProxy] = useState("");
    const [mailProxy, setMailProxy] = useState("");
    const [mailProxyEnabled, setMailProxyEnabled] = useState(true);
    const [showProxy, setShowProxy] = useState(false);
    const [showSms, setShowSms] = useState(false);
    const [smsText, setSmsText] = useState("");
    const [smsData, setSmsData] = useState<{list: any[]; stats: {free: number; used: number; bad: number; claimed: number; total: number}}>({list: [], stats: {free: 0, used: 0, bad: 0, claimed: 0, total: 0}});
    const [smsEnabled, setSmsEnabled] = useState(true);
    const [rtEnabled, setRtEnabled] = useState(false);
    const [mfaEnabled, setMfaEnabled] = useState(true);
    const [bitBrowser, setBitBrowser] = useState(false); // 比特浏览器:每号独立指纹窗口
    const [daily, setDaily] = useState<Daily | null>(null);
    const [showDaily, setShowDaily] = useState(false);
    const [xray, setXray] = useState<XrayStatus | null>(null);
    const [regPortInput, setRegPortInput] = useState("10809");   // 独立 xray 本地端口(可配置持久化)
    const [claudePortInput, setClaudePortInput] = useState("10810");
    const [showXray, setShowXray] = useState(false);
    const [xrayBinPath, setXrayBinPath] = useState("");
    const [vlessInput, setVlessInput] = useState("");
    const [smsLinkTemplate, setSmsLinkTemplate] = useState("");
    const [smsMaxBind, setSmsMaxBind] = useState(3);
    const [batchFilter, setBatchFilter] = useState(""); // 按批次筛选("" =全部)
    const [batches, setBatches] = useState<{name: string; count: number}[]>([]);
    const [showExport, setShowExport] = useState(false); // 统一导出弹窗
    const [exportRange, setExportRange] = useState<"all" | "filtered" | "selected" | "batch">("all"); // 导出范围
    const [exportScope, setExportScope] = useState<"all" | "hasRt" | "atOnly">("all");
    const [exportFormat, setExportFormat] = useState<"full" | "at" | "session" | "jsonl" | "csv">("full");
    const [exportBatch, setExportBatch] = useState(""); // 范围=按批次时选的批次
    const [batchAssign, setBatchAssign] = useState(""); // 批量设置批次的输入
    const [quickSelN, setQuickSelN] = useState(100);
    const [exportMarkSold, setExportMarkSold] = useState(false); // 导出时是否标记已售出
    // 批量刷新 AT 弹窗
    const [showRefreshAt, setShowRefreshAt] = useState(false);
    const [refreshAtInput, setRefreshAtInput] = useState("");
    const [refreshAtResults, setRefreshAtResults] = useState<{email: string; password?: string; accessToken?: string; sessionJson?: any; ok: boolean; reason?: string; status: "pending"|"done"}[]>([]);
    const [refreshAtRunning, setRefreshAtRunning] = useState(false);
    // 批量获取 RT 弹窗
    const [showAcquireRt, setShowAcquireRt] = useState(false);
    const [acquireRtInput, setAcquireRtInput] = useState("");
    const [acquireRtResults, setAcquireRtResults] = useState<{email: string; password?: string; rt?: string; accessToken?: string; ok: boolean; reason?: string; status: "pending"|"running"|"done"}[]>([]);
    const [acquireRtRunning, setAcquireRtRunning] = useState(false);
    // 「从邮箱选号」弹窗:从待分配(free)邮箱勾选 → 设批次 → 可选先改密 → 分配进 GPT 注册队列
    const [showPicker, setShowPicker] = useState(false);
    const [pickerList, setPickerList] = useState<Mailbox[]>([]);   // free 邮箱列表
    const [pickerGrps, setPickerGrps] = useState<{grp: string; n: number}[]>([]); // free 邮箱分组分布
    const [pickerGrp, setPickerGrp] = useState("");               // 分组筛选(""=全部)
    const [pickerSel, setPickerSel] = useState<Set<number>>(new Set()); // 勾选的邮箱 id
    const [pickerBatch, setPickerBatch] = useState("");           // 分配批次名
    const [pickerChangePw, setPickerChangePw] = useState(false);  // 先改密开关(默认关)
    const [pickerPw, setPickerPw] = useState("");                // 改密状态筛选(""=全部, "yes"=已改密, "no"=未改密, "fail"=失败)
    const [pickerLoading, setPickerLoading] = useState(false);
    // 邮箱密码校验工具已迁至邮箱管理域(web/src/MailCheckTool.tsx,由 MailboxPanel 挂载)
    // 筛选三层:①注册状态(互斥单选) ②质量facet(多选,跨组AND、组内OR) ③售出(独立三态)
    const [statusFilter, setStatusFilter] = useState<"all" | "pending" | "running" | "success" | "failed">("all");
    const [facets, setFacets] = useState<Set<string>>(new Set()); // 选中的 facet key 集合,空=不额外收窄
    const [soldFilter, setSoldFilter] = useState<"all" | "sold" | "unsold">("all"); // 第三层:售出(全部/未售/已售)
    const [showDeleted, setShowDeleted] = useState(false); // 查看已删除邮箱的GPT账号
    const [delAccounts, setDelAccounts] = useState<Account[]>([]); // 已删除账号:搜索时惰性加载,让按邮箱回查能命中软删数据
    const toggleFacet = (k: string) => setFacets((prev) => { const s = new Set(prev); s.has(k) ? s.delete(k) : s.add(k); return s; });
    const [search, setSearch] = useState(""); // 邮箱名搜索
    const [selectedId, setSelectedId] = useState<number | null>(null);
    const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
    const toggleSel = (id: number) => setSelectedIds((prev) => { const s = new Set(prev); s.has(id) ? s.delete(id) : s.add(id); return s; });
    const [logs, setLogs] = useState<{ts: number; line: string}[]>([]);
    const [allLogs, setAllLogs] = useState<{id: number; email: string; ts: number; line: string}[]>([]);
    const [logMode, setLogMode] = useState<"all" | "single">("all");
    const [panelOpen, setPanelOpen] = useState(true); // 右侧抽屉是否展开(收起则表格占满)
    const [domain, setDomain] = useState<"gpt" | "mailbox" | "claude" | "recharge">("gpt"); // 顶层业务域:GPT注册 / 邮箱管理 / Claude注册 / 充值提交
    const [mailJobOn, setMailJobOn] = useState(false);
    const [dark, setDark] = useState<boolean>(() => (localStorage.getItem("theme") ?? "dark") === "dark"); // 默认暗色
    useEffect(() => { document.documentElement.classList.toggle("dark", dark); localStorage.setItem("theme", dark ? "dark" : "light"); }, [dark]);
    const [editMode, setEditMode] = useState(false); // 详情抽屉是否处于编辑记录态
    const [editForm, setEditForm] = useState<Record<string, any>>({});
    const [infoOpen, setInfoOpen] = useState(true); // 详情抽屉的账户信息区是否展开(收起给日志/收件箱更多空间)
    const [batchAt, setBatchAt] = useState<{running: boolean; done: number; total: number}>({running: false, done: 0, total: 0});
    const [defaultGptPw, setDefaultGptPw] = useState("");
    // 虚拟滚动:大数据量只渲染可视区行(固定行高),避免几千行 DOM 卡顿
    const scrollRef = useRef<HTMLDivElement>(null);
    const [scrollTop, setScrollTop] = useState(0);
    const [viewH, setViewH] = useState(600);
    const [toast, setToast] = useState("");
    const logEndRef = useRef<HTMLDivElement>(null);
    const selectedIdRef = useRef<number | null>(null);
    selectedIdRef.current = selectedId;
    const accountsRef = useRef<Account[]>([]);
    accountsRef.current = accounts;
    const showDeletedRef = useRef(false);
    showDeletedRef.current = showDeleted;
    const delLoadedRef = useRef(false); // 已删除列表是否已加载(删号后置回 false 触发重取)

    const toastTimer = useRef<any>(null);
    const notify = (m: string, ms = 2600) => { if (toastTimer.current) clearTimeout(toastTimer.current); setToast(m); toastTimer.current = setTimeout(() => setToast(""), ms); };

    // 初次加载 + SSE
    useEffect(() => {
        api.state().then((s) => { setPaused(s.state.paused); setInstanceId(s.state.instanceId || ""); setConcurrency(s.state.concurrency); setOtpSingle(s.state.otpSingle); setChatSim(s.state.simulateChat); setSmsEnabled(s.state.smsEnabled); setRtEnabled(s.state.rtEnabled); setMfaEnabled(s.state.mfaEnabled !== false); setDaily(s.state.daily); setXray(s.state.xray); setRegEngine(s.state.regEngine || "http"); setBitBrowser(!!s.state.bitBrowser); setSmsLinkTemplate(s.state.smsLinkTemplate || ""); setSmsMaxBind(s.state.smsMaxBind ?? 3); setRegProxy(s.state.regProxy || ""); setMailProxy(s.state.mailProxy || ""); setMailProxyEnabled(s.state.mailProxyEnabled !== false); setRegPortInput(String(s.state.regProxyPort ?? 10809)); setClaudePortInput(String(s.state.claudeProxyPort ?? 10810)); setXrayBinPath(s.state.xrayBinPath || ""); if (s.state.xrayVless) setVlessInput(s.state.xrayVless); if (s.state.defaultPassword) setDefaultGptPw(s.state.defaultPassword); setStats(s.stats); }).catch(() => {});
        api.listAccounts().then(setAccounts).catch(() => {});
        // 批次数据来自数据库(筛选/导出用;导入已迁至邮箱管理)
        api.batches().then(setBatches).catch(() => {});
        api.listSms().then(setSmsData).catch(() => {});

        const disconnect = connectStream((event, data) => {
            if (event === "sms") { api.listSms().then(setSmsData).catch(() => {}); return; }
            if (event === "daily") { setDaily(data); return; }
            if (event === "batchAt") { setBatchAt(data); if (!data.running && !showDeletedRef.current) api.listAccounts().then(setAccounts).catch(() => {}); return; }
            if (event === "refreshAt") { setRefreshAtResults(data.results.map((r: any) => ({...r, status: r.status || "done"}))); if (data.done) setRefreshAtRunning(false); return; }
            if (event === "batchRtAcquire") { setAcquireRtResults(data.results.map((r: any) => ({...r, status: r.status || "done"}))); if (data.done) setAcquireRtRunning(false); return; }
            if (event === "batchPw") {
                setMailJobOn((on) => !!data?.running || on);
                if (!showDeletedRef.current) api.listAccounts().then(setAccounts).catch(() => {});
                return;
            }
            if (event === "batchHarden") {
                const open = (data?.windows || []).some((w: any) => w.status === 1);
                setMailJobOn(!!data?.running || open);
                return;
            }
            if (event === "stats") setStats(data);
            else if (event === "snapshot") { if (!showDeletedRef.current) setAccounts(data); }
            else if (event === "hello") {
                setStats(data.stats); setPaused(data.state.paused); setConcurrency(data.state.concurrency); setOtpSingle(data.state.otpSingle); setChatSim(data.state.simulateChat); setRegProxy(data.state.regProxy || ""); setMailProxy(data.state.mailProxy || ""); setMailProxyEnabled(data.state.mailProxyEnabled !== false);
                if (data.state?.mfaEnabled !== undefined) setMfaEnabled(data.state.mfaEnabled !== false);
                if (data.state?.defaultPassword) setDefaultGptPw(data.state.defaultPassword);
                const bh = data.state?.batchHarden;
                const open = (bh?.windows || []).some((w: any) => w.status === 1);
                setMailJobOn(!!bh?.running || !!data.state?.batchPw?.running || open);
                if (!showDeletedRef.current) api.listAccounts().then(setAccounts).catch(() => {});
            }
            else if (event === "status") {
                setAccounts((prev) => {
                    const exists = prev.some((a) => a.id === data.id);
                    if (exists) return prev.map((a) => (a.id === data.id ? {...a, ...data, status: data.status} : a));
                    return [...prev, data];
                });
            } else if (event === "log") {
                const email = accountsRef.current.find((a) => a.id === data.id)?.email || `#${data.id}`;
                setAllLogs((prev) => [...prev.slice(-1200), {id: data.id, email, ts: data.ts, line: data.line}]);
                if (data.id === selectedIdRef.current) {
                    setLogs((prev) => [...prev.slice(-800), {ts: data.ts, line: data.line}]);
                }
            }
        });
        return disconnect;
    }, []);

    // 切换「已删除」视图时重新拉取账号列表
    useEffect(() => { api.listAccounts(showDeleted).then(setAccounts).catch(() => {}); }, [showDeleted]);

    // 默认视图下一旦开始搜索,顺带拉一次已删除账号并入候选:删号是软删,邮箱仍能搜出历史数据
    useEffect(() => {
        if (showDeleted || !search.trim() || delLoadedRef.current) return;
        delLoadedRef.current = true;
        api.listAccounts(true).then(setDelAccounts).catch(() => { delLoadedRef.current = false; });
    }, [search, showDeleted]);
    // 删号后作废缓存:下次搜索重新拉,新删的号才搜得到
    const invalidateDeleted = () => { delLoadedRef.current = false; setDelAccounts([]); };

    // 选中账号 → 拉历史日志
    useEffect(() => {
        if (selectedId == null) { setLogs([]); return; }
        api.logs(selectedId).then((rows) => setLogs(rows.map((r) => ({ts: r.ts, line: r.line})))).catch(() => setLogs([]));
    }, [selectedId]);

    useEffect(() => { logEndRef.current?.scrollIntoView({behavior: "smooth"}); }, [logs, allLogs, logMode]);
    // 测量表格滚动容器高度(用于虚拟滚动可视区计算)
    useEffect(() => {
        const el = scrollRef.current; if (!el) return;
        const measure = () => { const h = el.clientHeight; if (h > 0) setViewH(h); };
        requestAnimationFrame(measure); // 等首帧 layout 完成再测,避免挂载瞬间 clientHeight 读到过渡/0 值致列表半截
        const ro = new ResizeObserver(measure); ro.observe(el);
        return () => ro.disconnect();
    }, []);

    // 过期判定:成功注册且【注册满 expDays 天】(存活天数≥阈值,dead_at 优先定格)。正常=成功且未到阈值。
    const isExpired = (a: Account) => a.status === "success" && aliveDaysNum(a.finished_at, a.dead_at, a.created_at) >= expDays;
    const succ = (a: Account) => a.status === "success"; // facet 一律限定成功号,口径统一
    // 质量 facet 定义:key→谓词。分组用于「组内 OR、跨组 AND」。expDays 变则时效组谓词跟着变,故用 useMemo。
    const FACET_DEFS = useMemo(() => ({
        hasRt: {group: "token", label: "带rt", pred: (a: Account) => succ(a) && !!a.rt_file},
        atOnly: {group: "token", label: "只有at", pred: (a: Account) => succ(a) && !a.rt_file},
        atOk: {group: "at", label: "at有效", pred: (a: Account) => succ(a) && /✅/.test(a.at_status || "")},
        atFail: {group: "at", label: "at失效", pred: (a: Account) => succ(a) && /❌/.test(a.at_status || "")},
        normal: {group: "age", label: "正常", pred: (a: Account) => succ(a) && !isExpired(a)},
        expired: {group: "age", label: "过期", pred: (a: Account) => isExpired(a)},
        noPw: {group: "pw", label: "未改密", pred: (a: Account) => succ(a) && !String(a.pw_status || "").includes("✅")},
        pwFail: {group: "pw", label: "改密失败", pred: (a: Account) => succ(a) && String(a.pw_status || "").includes("❌")},
        mfaOk: {group: "2fa", label: "已绑2FA", pred: (a: Account) => succ(a) && /✅/.test(a.mfa_status || "")},
        mfaNo: {group: "2fa", label: "未绑2FA", pred: (a: Account) => succ(a) && !/✅/.test(a.mfa_status || "")},
        deactivated: {group: "misc", label: "已停用", pred: (a: Account) => /account_deactivated/i.test(a.error || "")},
    }), [expDays]);
    type FacetKey = keyof typeof FACET_DEFS;
    // facet 按组归并:同组多个选中=OR;不同组之间=AND(如 令牌组选带rt + at组选有效 → 带rt且at有效)
    const applyFacets = (list: Account[], active: Set<string>) => {
        if (!active.size) return list;
        const byGroup = new Map<string, ((a: Account) => boolean)[]>();
        for (const k of active) {
            const d = FACET_DEFS[k as FacetKey]; if (!d) continue;
            if (!byGroup.has(d.group)) byGroup.set(d.group, []);
            byGroup.get(d.group)!.push(d.pred);
        }
        return list.filter((a) => [...byGroup.values()].every((preds) => preds.some((p) => p(a))));
    };
    const filtered = useMemo(() => {
        const qs = search.trim().toLowerCase().split(/[\s,;|]+/).filter(Boolean);
        // 搜索时把已删除账号并入候选(默认视图本身不含它们),其余筛选口径与正常号一致,已删除的排在末尾
        const base = qs.length && !showDeleted ? [...accounts, ...delAccounts] : accounts;
        let list = statusFilter === "all" ? base : base.filter((a) => a.status === statusFilter); // ①注册状态
        list = applyFacets(list, facets); // ②质量 facet(跨组 AND、组内 OR)
        if (qs.length) list = list.filter((a) => { const e = a.email.toLowerCase(); return qs.some((q) => e.includes(q)); });
        if (batchFilter) list = list.filter((a) => (a.batch || "") === batchFilter); // 批次筛选
        if (soldFilter === "sold") list = list.filter((a) => a.sold_at);        // ③售出:仅已售
        else if (soldFilter === "unsold") list = list.filter((a) => !a.sold_at); // ③售出:仅未售
        return list;
    }, [accounts, delAccounts, showDeleted, statusFilter, facets, FACET_DEFS, expDays, search, batchFilter, soldFilter]);
    // 批量操作/导出的作用域:剔除搜索带出的已删除号,避免误跑/误导出
    const actionable = useMemo(() => (showDeleted ? filtered : filtered.filter((a) => !a.deleted_at)), [filtered, showDeleted]);
    const delHits = filtered.length - actionable.length;
    // facet 计数:在【当前注册状态】的基数上算(不受其他 facet 影响,数字稳定可预测)。售出单列。
    const statusBase = useMemo(() => statusFilter === "all" ? accounts : accounts.filter((a) => a.status === statusFilter), [accounts, statusFilter]);
    const facetCnt = useMemo(() => {
        const out: Record<string, number> = {sold: accounts.filter((a) => a.sold_at).length, unsold: accounts.filter((a) => !a.sold_at).length};
        for (const [k, d] of Object.entries(FACET_DEFS)) out[k] = statusBase.filter(d.pred).length;
        return out;
    }, [accounts, statusBase, FACET_DEFS]);
    // 选中批次时,统计该批的成功率(成功/失败/进行中 + 已完成里的成功占比)
    const batchStats = useMemo(() => {
        if (!batchFilter) return null;
        const list = accounts.filter((a) => (a.batch || "") === batchFilter);
        const success = list.filter((a) => a.status === "success").length;
        const failed = list.filter((a) => a.status === "failed").length;
        const busy = list.filter((a) => a.status === "running" || a.status === "pending").length;
        const dead = list.filter((a) => /account_deactivated/i.test(a.error || "")).length;
        const done = success + failed;
        return {total: list.length, success, failed, busy, dead, rate: done ? Math.round((success / done) * 100) : 0};
    }, [accounts, batchFilter]);
    const selected = accounts.find((a) => a.id === selectedId) || delAccounts.find((a) => a.id === selectedId) || null;
    // 虚拟滚动可视区:只渲染 [vStart, vEnd) 行,上下用占位撑起总高度
    const ROW_H = 41;
    const vTotal = filtered.length;
    const vStart = Math.max(0, Math.floor(scrollTop / ROW_H) - 8);
    // 兜底:viewH 万一测偏小也按视口高渲染,保证充满可视区(数据量小,多渲染一屏无性能压力),杜绝下半屏空白
    const effViewH = Math.max(viewH, typeof window !== "undefined" ? window.innerHeight : 800);
    const vEnd = Math.min(vTotal, Math.ceil((scrollTop + effViewH) / ROW_H) + 8);
    const vRows = filtered.slice(vStart, vEnd);
    const vTopPad = vStart * ROW_H;
    const vBotPad = Math.max(0, (vTotal - vEnd) * ROW_H);

    // 收件箱已迁至邮箱管理(在「📮 邮箱管理」点邮箱「详情」查看收件箱/正文,覆盖所有邮箱)

    // 进入编辑记录态:把当前号字段拷进表单
    function startEdit(a: Account) {
        setEditForm({
            email: a.email, password: a.password, status: a.status, plan: a.plan || "",
            phone: a.phone || "", card: a.card || "", at_status: a.at_status || "",
            rt_status: a.rt_status || "", chat_status: a.chat_status || "", error: a.error || "",
            batch: a.batch || "", dead: !!a.dead_at, sold: !!a.sold_at,
            gpt_password: a.gpt_password || "", totp_secret: a.totp_secret || "", mfa_status: a.mfa_status || "",
        });
        setEditMode(true); setInfoOpen(true);
    }
    async function saveEdit(id: number) {
        try {
            await api.updateAccount(id, editForm);
            await api.listAccounts().then(setAccounts);
            setEditMode(false);
            notify("已保存");
        } catch (e: any) { notify("保存失败：" + e.message); }
    }
    const ef = (k: string) => (e: any) => setEditForm((p) => ({...p, [k]: e.target.value}));

    // 解析「邮箱----密码」多行(兼容 ---- / : / 空白分隔),第一个分隔符切两段

    // 注入 at 打开已登录 chatgpt 真浏览器(人工操作)
    async function doOpenBrowser(a: Account) {
        notify("正在打开浏览器并注入登录态…（约 10~20s）");
        try { await api.openBrowser(a.id); notify("已打开浏览器（如落到登录页则 at 已过期，可重跑取新 at）"); }
        catch (e: any) { notify("打开失败：" + e.message); }
    }

    // 邮箱改密/收件箱均已迁至邮箱管理域,GPT 只做注册

    const refreshSms = () => api.listSms().then(setSmsData).catch(() => {});
    async function doImportSms() {
        notify("验证收码链接中…（逐个校验，稍候）");
        try {
            const r = await api.importSms(smsText);
            const inv = r.invalid || [];
            let msg = `接码导入 ${r.inserted} 个，跳过重复 ${r.skipped}`;
            if (inv.length) msg += `；⚠️无效跳过 ${inv.length}：` + inv.slice(0, 5).map((x) => `${x.phone}(${x.reason})`).join("；") + (inv.length > 5 ? " …" : "");
            notify(msg);
            if (!inv.length) setSmsText(""); // 有无效则保留输入,方便修正后重导
            refreshSms();
        } catch (e: any) { notify("接码导入失败: " + e.message); }
    }

    // 打开「从邮箱选号」弹窗:拉 free 邮箱列表 + 分组,重置勾选。批次默认沿用当前批次筛选。
    async function openPicker() {
        setShowPicker(true); setPickerLoading(true); setPickerSel(new Set()); setPickerGrp(""); setPickerPw(""); setPickerBatch(batchFilter || "");
        try { const r = await api.listMailboxes("free"); setPickerList(r.list); setPickerGrps(r.groups); }
        catch (e: any) { notify("拉取待分配邮箱失败: " + e.message); }
        finally { setPickerLoading(false); }
    }
    const pickerVisible = useMemo(() => {
        const pwState = (m: Mailbox) => { const s = m.pw_status || ""; return s.startsWith("✅") ? "yes" : s.startsWith("❌") ? "fail" : "no"; };
        return pickerList.filter((m) => {
            if (pickerGrp === "__NONE__") { if (m.grp) return false; } else if (pickerGrp && (m.grp || "") !== pickerGrp) return false;
            if (pickerPw && pwState(m) !== pickerPw) return false;
            return true;
        });
    }, [pickerList, pickerGrp, pickerPw]);
    async function doPickAllocate() {
        const ids = [...pickerSel];
        if (!ids.length) { notify("未勾选邮箱"); return; }
        const tip = pickerChangePw
            ? `对选中的 ${ids.length} 个邮箱【先改密】(真实修改 mail.com 密码,串行·较慢),改完再分配进 GPT 注册队列?`
            : `把选中的 ${ids.length} 个邮箱分配给 GPT 注册${pickerBatch ? `(批次「${pickerBatch}」)` : ""}?`;
        if (!window.confirm(tip)) return;
        try {
            const r = await api.allocateMailboxIds("gpt", ids, pickerBatch.trim(), pickerChangePw);
            if (r.changePwFirst) notify(`已启动 ${r.willChange} 个邮箱改密,改完自动分配进注册队列(进度见邮箱改密提示)`);
            else notify(`已分配 ${r.allocated ?? 0} 个进 GPT 注册队列${r.skipped ? `(跳过 ${r.skipped} 个非待分配)` : ""}`);
            setShowPicker(false);
            await api.listAccounts().then(setAccounts);
            api.batches().then(setBatches).catch(() => {});
        } catch (e: any) { notify("分配失败: " + e.message); }
    }

    // 导出弹窗实时条数预估(与服务端口径一致:success 未失效 + 有 GPT 密码的谷歌号全部导出)
    const {exportCount, exportSkipped} = useMemo(() => {
        let list = exportRange === "selected" ? accounts.filter((a) => selectedIds.has(a.id))
            : exportRange === "filtered" ? actionable
            : exportRange === "batch" ? accounts.filter((a) => !!exportBatch && (a.batch || "") === exportBatch)
            : accounts;
        if (exportScope === "hasRt") list = list.filter((a) => a.rt_file);
        else if (exportScope === "atOnly") list = list.filter((a) => !a.rt_file);
        const usable = list.filter(exportableAccount);
        return {exportCount: usable.length, exportSkipped: list.length - usable.length};
    }, [accounts, actionable, selectedIds, exportRange, exportBatch, exportScope]);
    async function doExportFull() {
        // 范围 → ids/batch:选中/当前筛选传 ids;按批次传 batch;全部都不传。ids/batch 显式范围服务端不限状态全导。
        let ids: number[] | undefined, batch: string | undefined;
        if (exportRange === "selected") { ids = [...selectedIds]; if (!ids.length) { notify("未选中任何账号"); return; } }
        else if (exportRange === "filtered") { ids = actionable.map((a) => a.id); if (!ids.length) { notify("当前筛选无账号"); return; } }
        else if (exportRange === "batch") { if (!exportBatch) { notify("请选择批次"); return; } batch = exportBatch; }
        if (!exportCount) { notify("该范围没有可导出的账号"); return; }
        if (exportMarkSold && !window.confirm(`导出并把这 ${exportCount} 个号标记为【已售出】？`)) return;
        try {
            const text = await api.exportFull({format: exportFormat, scope: exportScope, batch, ids, markSold: exportMarkSold});
            const ext = exportFormat === "csv" ? "csv" : exportFormat === "jsonl" ? "jsonl" : "txt";
            const blob = new Blob([text], {type: exportFormat === "csv" ? "text/csv;charset=utf-8" : "text/plain;charset=utf-8"});
            const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = `export-${exportFormat}.${ext}`; a.click(); URL.revokeObjectURL(a.href);
            if (exportMarkSold) await api.listAccounts().then(setAccounts);
            notify(`已导出 ${exportCount} 条${exportMarkSold ? "并标记已售出" : ""}`);
            setShowExport(false);
        } catch (e: any) { notify("导出失败: " + e.message); }
    }
    async function setBatchForSelected() {
        const ids = selectedIds.size ? [...selectedIds] : actionable.map((a) => a.id);
        if (!ids.length) { notify("无可设置的账号"); return; }
        const b = batchAssign.trim();
        if (!window.confirm(`给 ${selectedIds.size ? "选中" : "当前列表"} ${ids.length} 个号设置批次「${b || "(清空批次)"}」？`)) return;
        try {
            await api.setBatch(ids, b);
            await api.listAccounts().then(setAccounts);
            api.batches().then(setBatches).catch(() => {});
            notify(`已给 ${ids.length} 个号设置批次${b ? `「${b}」` : "(清空)"}`);
        } catch (e: any) { notify(e.message); }
    }
    // GPT 邮箱导入已移除:邮箱来源唯一走「邮箱管理导入独立邮箱 → 分配给 GPT」
    const ctrl = (fn: () => Promise<any>, msg: string) => async () => {
        try { await fn(); notify(msg); } catch (e: any) { notify("操作失败: " + e.message); }
    };
    async function start() { try { await api.start(concurrency); setPaused(false); notify("已开始/恢复"); } catch (e: any) { notify(e.message); } }
    async function pause() { try { await api.pause(); setPaused(true); notify("已暂停(运行中的会跑完)"); } catch (e: any) { notify(e.message); } }

    // ①注册状态:互斥单选。中性底,只有 成功=绿/失败=红 带语义色,选中填实。
    const StatusTab = ({label, n, tone, active, onClick}: {label: string; n: number; tone?: "ok" | "bad"; active: boolean; onClick: () => void}) => {
        const base = tone === "ok" ? "text-green-700" : tone === "bad" ? "text-red-600" : "text-gray-600";
        const on = tone === "ok" ? "bg-green-600 text-white border-green-600" : tone === "bad" ? "bg-red-500 text-white border-red-500" : "bg-gray-800 text-white border-gray-800";
        return (
            <button onClick={onClick} className={`px-3 py-1 rounded-md text-sm border transition ${active ? on : `bg-white ${base} border-gray-200 hover:bg-gray-50`}`}>
                {label} <span className="font-bold">{n}</span>
            </button>
        );
    };
    // ②质量 facet:多选开关。统一中性描边,选中才填靛蓝;计数为 0 时置灰但不消失(位置稳定)。
    const FacetChip = ({fkey, label}: {fkey: string; label: string}) => {
        const n = facetCnt[fkey] ?? 0;
        const active = facets.has(fkey);
        return (
            <button onClick={() => toggleFacet(fkey)} title={active ? "点击取消该条件" : "点击叠加该条件(跨组 AND)"}
                    className={`px-2 py-0.5 rounded-md text-xs border transition ${active ? "bg-indigo-600 text-white border-indigo-600" : n ? "bg-white text-gray-600 border-gray-200 hover:bg-gray-50" : "bg-white text-gray-300 border-gray-100"}`}>
                {label} <span className="font-semibold">{n}</span>
            </button>
        );
    };
    // facet 分组容器:左侧组名 + 一排 chip
    const FacetGroup = ({name, children}: {name: string; children: React.ReactNode}) => (
        <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md bg-gray-50 border border-gray-100">
            <span className="text-[11px] text-gray-400 mr-0.5">{name}</span>{children}
        </span>
    );

    // 顶层三域导航 tab(架构 v2:GPT注册 / 邮箱管理 / Claude注册,三域隔离)
    const DomainTab = ({active, onClick, children}: any) => (
        <button onClick={onClick}
                className={`px-4 py-1.5 rounded-lg text-sm font-medium border transition ${active ? "bg-gray-800 text-white border-gray-800" : "bg-white text-gray-600 border-gray-200 hover:bg-gray-100"}`}>
            {children}
        </button>
    );

    return (
        <div className="h-full flex flex-col bg-gray-50 text-gray-800">
            {/* 顶层三域导航(架构 v2:GPT注册 / 邮箱管理 / Claude注册,三域邮箱物理隔离不可串) */}
            <nav className="bg-white border-b px-6 py-2 flex items-center gap-2 shadow-sm">
                <span className="text-sm font-bold text-gray-700 mr-3">🗂 多域账号系统</span>
                <DomainTab active={domain === "gpt"} onClick={() => setDomain("gpt")}>⚡ GPT 注册</DomainTab>
                <DomainTab active={domain === "mailbox"} onClick={() => setDomain("mailbox")}>📮 邮箱管理{mailJobOn ? <span className="ml-1 text-amber-500">●</span> : null}</DomainTab>
                <DomainTab active={domain === "claude"} onClick={() => setDomain("claude")}>🧠 Claude 注册</DomainTab>
                <DomainTab active={domain === "recharge"} onClick={() => setDomain("recharge")}>💳 充值提交</DomainTab>
            </nav>
            {domain === "mailbox" && <MailboxPanel notify={notify}/>}
            {domain === "claude" && <ClaudePanel notify={notify}/>}
            {domain === "recharge" && <RechargePanel notify={notify}/>}
            {domain === "gpt" && (<>
            {/* 顶栏 */}
            <header className="bg-white border-b px-6 py-3 flex items-center gap-4 flex-wrap shadow-sm">
                <h1 className="text-lg font-bold">⚡ GPT 批量注册控制台</h1>
                {instanceId && <span className="text-xs text-gray-400 font-mono" title="本机实例。多机可共跑同一队列；停止/关本机只退回本机任务">本机 {instanceId}</span>}
                <div className="flex flex-col gap-1.5">
                    {/* 第①层:注册状态(互斥单选)。右侧「清除筛选」在选了 facet/售出时出现 */}
                    <div className="flex items-center gap-1.5 flex-wrap">
                        <StatusTab label="全部" n={stats.total} active={statusFilter === "all" && !showDeleted} onClick={() => { setShowDeleted(false); setStatusFilter("all"); }}/>
                        <StatusTab label="等待" n={stats.pending} active={statusFilter === "pending" && !showDeleted} onClick={() => { setShowDeleted(false); setStatusFilter("pending"); }}/>
                        <StatusTab label="运行" n={stats.running} active={statusFilter === "running" && !showDeleted} onClick={() => { setShowDeleted(false); setStatusFilter("running"); }}/>
                        <StatusTab label="成功" n={stats.success} tone="ok" active={statusFilter === "success" && !showDeleted} onClick={() => { setShowDeleted(false); setStatusFilter("success"); }}/>
                        <StatusTab label="失败" n={stats.failed} tone="bad" active={statusFilter === "failed" && !showDeleted} onClick={() => { setShowDeleted(false); setStatusFilter("failed"); }}/>
                        <span className="text-gray-300 mx-0.5">|</span>
                        <button onClick={() => { const next = !showDeleted; setShowDeleted(next); if (next) { setStatusFilter("all"); setFacets(new Set()); setSoldFilter("all"); } }}
                            className={`px-3 py-1 rounded-md text-sm border transition ${showDeleted ? 'bg-gray-500 text-white border-gray-500' : 'bg-white text-gray-400 border-gray-200 hover:bg-gray-50'}`}>
                            已删除
                        </button>
                        <div className="relative ml-1">
                            <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="🔍 搜索邮箱(空格分隔多个)"
                                   className="w-52 pl-2 pr-6 py-1 border rounded-lg text-sm"/>
                            {search && <button onClick={() => setSearch("")} title="清除" className="absolute right-1.5 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600 text-sm">✕</button>}
                        </div>
                        {batches.length > 0 &&
                            <select value={batchFilter} onChange={(e) => setBatchFilter(e.target.value)} title="按批次筛选" className="px-2 py-1 border rounded-lg text-sm">
                                <option value="">全部批次</option>
                                {batches.map((b) => <option key={b.name} value={b.name}>{b.name} ({b.count})</option>)}
                            </select>}
                        {(facets.size > 0 || soldFilter !== "all") &&
                            <button onClick={() => { setFacets(new Set()); setSoldFilter("all"); }} className="text-xs text-gray-400 hover:text-gray-600 underline">清除筛选</button>}
                        {batchStats &&
                            <span className="text-xs px-2 py-1 rounded bg-slate-100 text-slate-700 whitespace-nowrap" title="该批次:成功/失败/进行中 + 成功率(成功占已完成的比例)">
                                共{batchStats.total} · <b className="text-green-600">成{batchStats.success}</b> <b className="text-red-500">败{batchStats.failed}</b>{batchStats.busy > 0 ? ` ⏳${batchStats.busy}` : ""}{batchStats.dead > 0 ? ` 停用${batchStats.dead}` : ""} · 成功率<b>{batchStats.rate}%</b>
                            </span>}
                    </div>
                    {/* 第②层:质量 facet(多选,组内 OR、跨组 AND)+ 第③层:售出(独立三段)。基数随①层状态变化 */}
                    <div className="flex items-center gap-1.5 flex-wrap">
                        <FacetGroup name="令牌"><FacetChip fkey="hasRt" label="带rt"/><FacetChip fkey="atOnly" label="只有at"/></FacetGroup>
                        <FacetGroup name="at"><FacetChip fkey="atOk" label="有效"/><FacetChip fkey="atFail" label="失效"/></FacetGroup>
                        <FacetGroup name="时效">
                            <FacetChip fkey="normal" label="正常"/><FacetChip fkey="expired" label="过期"/>
                            <span className="inline-flex items-center gap-0.5 text-[11px] text-gray-400 ml-0.5" title="注册满 N 天视为过期(网页 token 约 10 天;有 rt 的可续期)">
                                满<input type="number" min={1} value={expDays} onChange={(e) => { setExpDays(Math.max(1, Number(e.target.value) || 1)); setFacets((prev) => { const s = new Set(prev); s.add("expired"); s.delete("normal"); return s; }); }} className="w-10 px-1 py-0.5 border rounded"/>天
                            </span>
                        </FacetGroup>
                        <FacetGroup name="改密"><FacetChip fkey="noPw" label="未改"/><FacetChip fkey="pwFail" label="失败"/></FacetGroup>
                        <FacetGroup name="2FA"><FacetChip fkey="mfaOk" label="已绑"/><FacetChip fkey="mfaNo" label="未绑"/></FacetGroup>
                        <FacetGroup name="停用"><FacetChip fkey="deactivated" label="已停用"/></FacetGroup>
                        <span className="inline-flex items-center rounded-md border border-gray-200 overflow-hidden text-xs ml-0.5">
                            <span className="px-1.5 text-gray-400">售出</span>
                            {([["all", "全部", 0], ["unsold", "未售", facetCnt.unsold], ["sold", "已售", facetCnt.sold]] as const).map(([v, l, n]) => (
                                <button key={v} onClick={() => setSoldFilter(v)}
                                        className={`px-2 py-0.5 border-l border-gray-200 ${soldFilter === v ? "bg-amber-500 text-white" : "bg-white text-gray-600 hover:bg-gray-50"}`}>
                                    {l}{v !== "all" ? <span className="font-semibold ml-0.5">{n}</span> : null}
                                </button>
                            ))}
                        </span>
                    </div>
                </div>
                <div className="flex-1"/>
                <div className="flex items-center gap-2">
                    <label className="text-sm text-gray-500">引擎</label>
                    <button onClick={() => { const v = regEngine === "http" ? "browser" : "http"; setRegEngine(v); api.setEngine(v).then(() => notify(v === "browser" ? "注册引擎:浏览器(真Chrome过CF,headed,并发≤2)" : "注册引擎:HTTP(sentinel模拟)")).catch((e: any) => notify(e.message)); }}
                            title="http=HTTP模拟(sentinel)；browser=真Chrome过CF(headed,需能过CF的注册代理,自动限并发≤2)"
                            className={`px-2.5 py-1.5 rounded-lg text-sm border ${regEngine === "browser" ? "bg-cyan-50 text-cyan-700 border-cyan-200" : "bg-gray-100 text-gray-600 border-gray-200"}`}>
                        {regEngine === "browser" ? "🌐 浏览器" : "⚡ HTTP"}
                    </button>
                    {regEngine === "browser" &&
                        <button onClick={() => { const v = !bitBrowser; api.setBit(v).then((r) => { setBitBrowser(r.bitBrowser); notify(r.bitBrowser ? "已开启比特浏览器:每号独立指纹窗口" : "已关闭比特浏览器(用临时Chrome)"); }).catch((e: any) => notify(e.message)); }}
                                title="开启后:浏览器注册用比特浏览器,每个号动态创建独立指纹窗口(需比特客户端开着 Local API 54345)"
                                className={`px-2.5 py-1.5 rounded-lg text-sm border ${bitBrowser ? "bg-violet-50 text-violet-700 border-violet-200" : "bg-gray-100 text-gray-600 border-gray-200"}`}>
                            {bitBrowser ? "🫆 比特指纹" : "指纹:关"}
                        </button>}
                    <label className="text-sm text-gray-500 ml-1">并发</label>
                    <input type="number" min={1} max={16} value={concurrency}
                           onChange={(e) => setConcurrency(Math.max(1, Math.min(16, Number(e.target.value) || 1)))}
                           onBlur={() => api.setConcurrency(concurrency).catch(() => {})}
                           className="w-16 px-2 py-1.5 border rounded-lg text-sm"/>
                    <label className="text-sm text-gray-500 ml-1">验证码</label>
                    <button onClick={() => { const v = !otpSingle; setOtpSingle(v); api.setOtp(v).then(() => notify(v ? "已设为发一封" : "已设为发两封(更稳)")).catch(() => {}); }}
                            title="一封=只用创建账号自动发的那封(默认)；两封=额外主动再发一封更稳"
                            className={`px-2.5 py-1.5 rounded-lg text-sm border ${otpSingle ? "bg-green-50 text-green-700 border-green-200" : "bg-gray-100 text-gray-600 border-gray-200"}`}>
                        {otpSingle ? "发一封" : "发两封"}
                    </button>
                    <label className="text-sm text-gray-500 ml-1">养号</label>
                    <button onClick={() => { const v = !chatSim; setChatSim(v); api.setChat(v).then(() => notify(v ? "已开启:注册后自动发消息养号" : "已关闭养号")).catch(() => {}); }}
                            title="注册成功后自动发一条消息给 ChatGPT(留使用痕迹降风控)；需图形界面，无头服务器要装 xvfb"
                            className={`px-2.5 py-1.5 rounded-lg text-sm border ${chatSim ? "bg-green-50 text-green-700 border-green-200" : "bg-gray-100 text-gray-600 border-gray-200"}`}>
                        {chatSim ? "开" : "关"}
                    </button>
                    <label className="text-sm text-gray-500 ml-1">2FA</label>
                    <button onClick={() => { const v = !mfaEnabled; setMfaEnabled(v); api.setMfa(v).then(() => notify(v ? "已开启:注册成功后自动绑 TOTP" : "已关闭注册后自动绑 2FA")).catch((e) => { setMfaEnabled(!v); notify(e.message); }); }}
                            title="开=注册拿到 AT 后立刻绑 TOTP 并入库密钥；关=注册不绑，老号仍可用「批量绑2FA」"
                            className={`px-2.5 py-1.5 rounded-lg text-sm border ${mfaEnabled ? "bg-green-50 text-green-700 border-green-200" : "bg-gray-100 text-gray-600 border-gray-200"}`}>
                        {mfaEnabled ? "开" : "关"}
                    </button>
                    {paused
                        ? <button onClick={start} className="px-4 py-1.5 bg-green-600 text-white rounded-lg text-sm font-medium hover:bg-green-700">▶ 开始</button>
                        : <button onClick={pause} className="px-4 py-1.5 bg-amber-500 text-white rounded-lg text-sm font-medium hover:bg-amber-600">⏸ 暂停</button>}
                    <button onClick={ctrl(api.stop, "已停止本实例注册，未完成任务退回队列（其他实例可接着跑）")} className="px-3 py-1.5 bg-red-500 text-white rounded-lg text-sm hover:bg-red-600" title="只停本机。正在跑的号退回等待，其他实例会认领">⏹ 停止</button>
                    <button onClick={ctrl(api.retryFailed, "已把失败项重置为等待")} className="px-3 py-1.5 bg-gray-200 rounded-lg text-sm hover:bg-gray-300">↻ 重试失败</button>
                    <button onClick={() => { setShowProxy(true); notify("代理设置已在下方展开"); }} className="px-3 py-1.5 bg-gray-200 rounded-lg text-sm hover:bg-gray-300">⚙ 代理</button>
                    {/* 从待分配邮箱选号 → 设批次 → 可选先改密 → 进注册队列(补邮箱管理按数量盲分、无法设批次的缺口) */}
                    <button onClick={openPicker} title="从待分配(free)邮箱里勾选具体账号,设批次、可选先改密后分配进 GPT 注册队列" className="px-3 py-1.5 bg-emerald-600 text-white rounded-lg text-sm hover:bg-emerald-700">📥 从邮箱选号</button>
                    {/* ★唯一导出入口:范围×格式×标记已售出全在弹窗里。打开时按 选中>批次筛选>全部 智能预选范围 */}
                    <button onClick={() => { setExportRange(selectedIds.size ? "selected" : batchFilter ? "batch" : "all"); setExportBatch(batchFilter); setShowExport(true); }} className="px-3 py-1.5 bg-indigo-600 text-white rounded-lg text-sm hover:bg-indigo-700">⬇ 导出…</button>
                    <button onClick={() => setShowRefreshAt(true)} className="px-3 py-1.5 bg-cyan-600 text-white rounded-lg text-sm hover:bg-cyan-700" title="粘贴邮箱列表,走浏览器登录重新获取 accessToken">🔄 批量刷新AT</button>
                    <button onClick={() => setShowAcquireRt(true)} className="px-3 py-1.5 bg-amber-600 text-white rounded-lg text-sm hover:bg-amber-700" title="粘贴邮箱----密码,走 OAuth 获取全新 refresh_token(Pro号无需接码)">🔑 批量获取RT</button>
                </div>
            </header>

            {/* 导入区 */}
            <div className="bg-white border-b px-6 py-2">
                <button onClick={() => setShowProxy((v) => !v)} className="text-sm text-indigo-600 font-medium mr-4">
                    {showProxy ? "▾ 收起代理设置" : "⚙ 代理设置"}
                </button>
                <button onClick={() => { setShowSms((v) => !v); refreshSms(); }} className="text-sm text-indigo-600 font-medium mr-4">
                    {showSms ? "▾ 收起接码池" : `📱 接码池(可用 ${smsData.stats.free})`}
                </button>
                <button onClick={() => setShowDaily((v) => !v)} className="text-sm text-indigo-600 font-medium mr-4">
                    {showDaily ? "▾ 收起定时任务" : `⏰ 定时任务${daily?.enabled ? "(已开)" : ""}`}
                </button>
                <button onClick={() => setShowXray((v) => !v)} className="text-sm text-indigo-600 font-medium mr-4">
                    {showXray ? "▾ 收起独立代理" : `🌐 独立代理${xray?.running ? "(运行中)" : ""}`}
                </button>
                <button onClick={() => { setShowProxy(false); setShowSms(false); setShowDaily(false); setShowXray(false); }}
                        className="text-sm text-gray-400 hover:text-gray-600 font-medium" title="收起上方所有展开的面板">⊟ 全部收起</button>
                {showXray && (
                    <div className="mt-2 flex flex-col gap-2 bg-cyan-50 p-3 rounded-lg text-sm">
                        <div className="text-xs text-gray-600">粘贴 <span className="font-mono">vless://…</span> 链接，一键起独立 xray 进程做注册代理（独立端口，不影响你自己的 v2rayN/其它代理）。注册代理会自动指向它。</div>
                        <div className="flex gap-2 items-center flex-wrap text-xs bg-white/70 px-2 py-1.5 rounded border border-cyan-200">
                            <span className="text-gray-600 font-medium">本地端口(专属，避免与系统 v2rayN 等冲突/清理误杀):</span>
                            <label className="flex items-center gap-1">GPT/reg <input value={regPortInput} onChange={(e) => setRegPortInput(e.target.value)} className="w-20 px-1 py-0.5 border rounded font-mono"/></label>
                            <label className="flex items-center gap-1">Claude <input value={claudePortInput} onChange={(e) => setClaudePortInput(e.target.value)} className="w-20 px-1 py-0.5 border rounded font-mono"/></label>
                            <button onClick={() => { const rp = Number(regPortInput), cp = Number(claudePortInput); if (!(rp >= 1024 && rp <= 65535) || !(cp >= 1024 && cp <= 65535)) { notify("端口需为 1024-65535"); return; } if (rp === cp) { notify("两个端口不能相同"); return; } api.setProxyPorts(rp, cp).then((r) => { setRegProxy(r.regProxy || regProxy); notify(`端口已保存 reg=${r.regProxyPort} claude=${r.claudeProxyPort}${r.regProxy ? `，代理→${r.regProxy}` : "（重启或起 vless 后生效）"}`); }).catch((e: any) => notify(e.message)); }}
                                    className="px-2 py-1 bg-cyan-700 text-white rounded">保存端口</button>
                        </div>
                        <div className="flex gap-2 items-center flex-wrap text-xs bg-white/70 px-2 py-1.5 rounded border border-cyan-200">
                            <span className="text-gray-600 font-medium">xray 路径(空=自动探测):</span>
                            <input value={xrayBinPath} onChange={(e) => setXrayBinPath(e.target.value)}
                                   placeholder="D:\v2rayN-windows-64\bin\xray\xray.exe"
                                   className="flex-1 min-w-[320px] px-1 py-0.5 border rounded font-mono"/>
                            <button onClick={() => { api.setXrayBin(xrayBinPath.trim()).then(() => notify("xray 路径已保存")).catch((e: any) => notify(e.message)); }}
                                    className="px-2 py-1 bg-cyan-700 text-white rounded">保存路径</button>
                        </div>
                        <div className="flex gap-2 items-start flex-wrap">
                            <textarea value={vlessInput} onChange={(e) => setVlessInput(e.target.value)} placeholder="vless://uuid@host:port?security=reality&pbk=…&sid=…&sni=…&flow=…&type=tcp#name"
                                      className="flex-1 min-w-[360px] h-14 px-2 py-1 border rounded text-xs font-mono"/>
                            <button onClick={() => { const v = vlessInput.trim(); if (!v) { notify("请粘贴 vless 链接"); return; } api.startXray(v).then((r) => { setXray(r.xray); setRegProxy(r.regProxy); notify(`独立代理已启动: ${r.xray.node} @ 端口${r.xray.port}`); }).catch((err: any) => notify(err.message)); }}
                                    className="px-4 py-2 bg-cyan-600 text-white rounded text-sm font-medium">▶ 启动</button>
                            <button onClick={() => api.stopXray().then((r) => { setXray(r.xray); notify("独立代理已停止"); }).catch((err: any) => notify(err.message))}
                                    className="px-3 py-2 bg-gray-500 text-white rounded text-sm">■ 停止</button>
                            <button onClick={() => { notify("正在经代理测出口…", 30000); api.xrayProbe().then((r) => notify(r.ok ? `出口 ${r.ip} · chatgpt ${r.chatgpt} ${r.pass ? "✅可用" : "⚠️异常"}` : `❌${r.reason}`, 8000)).catch((err: any) => notify(err.message, 8000)); }}
                                    className="px-3 py-2 bg-indigo-600 text-white rounded text-sm">测出口</button>
                        </div>
                        <div className="text-xs">
                            {xray?.running
                                ? <span className="text-green-700">● 运行中：<span className="font-mono">{xray.node}</span> → 本地端口 <span className="font-mono">socks5://127.0.0.1:{xray.port}</span></span>
                                : <span className="text-gray-400">○ 未运行{xray?.error ? <span className="text-red-500 ml-2">（{xray.error}）</span> : null}</span>}
                        </div>
                    </div>
                )}
                {showDaily && daily && (
                    <div className="mt-2 flex flex-col gap-2 bg-amber-50 p-3 rounded-lg text-sm">
                        <div className="flex items-center gap-3 flex-wrap">
                            <label className="inline-flex items-center gap-1 cursor-pointer">
                                <input type="checkbox" checked={daily.enabled}
                                       onChange={(e) => api.setDaily({enabled: e.target.checked}).then((r) => { setDaily(r.daily); notify(e.target.checked ? "定时任务已开启" : "定时任务已关闭"); }).catch((err: any) => notify(err.message))} />
                                <span className="text-amber-800 font-medium">每天定时维护已成功账号</span>
                            </label>
                            <span className="text-gray-500">每天</span>
                            <select value={daily.hour} onChange={(e) => api.setDaily({hour: Number(e.target.value)}).then((r) => setDaily(r.daily)).catch((err: any) => notify(err.message))}
                                    className="px-2 py-1 border rounded">
                                {Array.from({length: 24}, (_, h) => <option key={h} value={h}>{pad(h)}:00</option>)}
                            </select>
                            {(["chat", "rt", "at"] as const).map((k) => (
                                <label key={k} className="inline-flex items-center gap-1 cursor-pointer">
                                    <input type="checkbox" checked={daily.items[k]}
                                           onChange={(e) => api.setDaily({items: {...daily.items, [k]: e.target.checked}}).then((r) => setDaily(r.daily)).catch((err: any) => notify(err.message))} />
                                    <span>{k === "chat" ? "养号" : k === "rt" ? "rt续期" : "at续期"}</span>
                                </label>
                            ))}
                            <button onClick={() => api.runDaily().then((r) => notify(`已手动触发维护:${r.accounts} 个号`)).catch((err: any) => notify(err.message))}
                                    disabled={daily.running}
                                    className={`px-3 py-1 rounded text-white text-xs ${daily.running ? "bg-gray-400" : "bg-amber-600 hover:bg-amber-700"}`}>
                                {daily.running ? "运行中…" : "▶ 立即运行一次"}
                            </button>
                        </div>
                        <div className="text-xs text-gray-600">
                            最后运行：<span className="font-medium">{daily.lastRunAt ? fmtDateTime(daily.lastRunAt) : "从未"}</span>
                            {" · "}共运行 <span className="font-medium text-amber-700">{daily.runCount}</span> 次
                            {" · "}累计养号 {daily.chatTotal} · rt续期 {daily.rtTotal} · at续期 {daily.atTotal}
                            {daily.lastResult && <span className="ml-2 text-gray-400">（{daily.lastResult}）</span>}
                        </div>
                        <div className="text-xs text-gray-400">rt 续期只刷新已有的有效 rt；过期/无rt 的号不会自动重取(避免定时批量烧接码)，如需重取请点该行 rt「测」。</div>
                    </div>
                )}
                {showProxy && (
                    <div className="mt-2 flex gap-3 items-end flex-wrap bg-indigo-50 p-3 rounded-lg">
                        <div className="flex flex-col">
                            <label className="text-xs text-gray-500 mb-1">注册 GPT 代理(建议住宅/池, 降低封号)</label>
                            <input value={regProxy} onChange={(e) => setRegProxy(e.target.value)}
                                   placeholder="socks5://user:pass@host:port / http://... / 留空=直连"
                                   className="w-96 px-2 py-1.5 border rounded text-sm font-mono"/>
                        </div>
                        <div className="flex flex-col">
                            <label className="text-xs text-gray-500 mb-1 flex items-center gap-1">
                                <input type="checkbox" checked={mailProxyEnabled} onChange={(e) => setMailProxyEnabled(e.target.checked)} />
                                邮箱登录代理{mailProxyEnabled ? "" : "(已关闭)"}
                            </label>
                            <input value={mailProxy} onChange={(e) => setMailProxy(e.target.value)}
                                   placeholder="留空=直连"
                                   disabled={!mailProxyEnabled}
                                   className={`w-72 px-2 py-1.5 border rounded text-sm font-mono ${!mailProxyEnabled ? "opacity-50" : ""}`}/>
                        </div>
                        <button onClick={() => api.setProxy(regProxy, mailProxy, mailProxyEnabled).then(() => notify("代理已保存(影响之后启动的任务)")).catch((e) => notify(e.message))}
                                className="px-4 py-2 bg-indigo-600 text-white rounded text-sm font-medium">保存代理</button>
                    </div>
                )}
                {showSms && (
                    <div className="mt-2 bg-amber-50 p-3 rounded-lg">
                        <div className="flex gap-3 items-end">
                            <div className="flex flex-col flex-1">
                                <label className="text-xs text-gray-500 mb-1">接码导入(每行 <span className="font-mono">卡密----手机号----链接</span>，如 SM-X12NG-AD3KE----14109084692----https://k8sms.com/sms/xxx；卡密导出时和账号绑定)</label>
                                <textarea value={smsText} onChange={(e) => setSmsText(e.target.value)}
                                          placeholder={"每行 卡密----手机号----链接：\nSM-X12NG-AD3KE----14109084692----https://k8sms.com/sms/xxxx"}
                                          className="w-full h-20 px-2 py-1.5 border rounded text-sm font-mono resize-y"/>
                            </div>
                            <button onClick={doImportSms} className="px-4 py-2 bg-amber-600 text-white rounded text-sm font-medium self-end">导入手机号</button>
                        </div>
                        <div className="mt-2 flex items-center gap-3 flex-wrap">
                            <label className="inline-flex items-center gap-1 cursor-pointer text-sm">
                                <input type="checkbox" checked={smsEnabled} onChange={(e) => { setSmsEnabled(e.target.checked); api.setSms(e.target.checked).catch((err: any) => notify(err.message)); }} />
                                <span className="text-indigo-700">注册需手机验证时启用接码</span>
                            </label>
                            <label className="inline-flex items-center gap-1 cursor-pointer text-sm" title="注册成功后额外走 codex OAuth 拿可续期 refresh_token，强制 add-phone 接码，每号消耗一个手机号">
                                <input type="checkbox" checked={rtEnabled} onChange={(e) => { setRtEnabled(e.target.checked); api.setRt(e.target.checked).then(() => notify(e.target.checked ? "已开启:注册后取 rt(每号消耗接码)" : "已关闭注册后取 rt")).catch((err: any) => notify(err.message)); }} />
                                <span className="text-purple-700">注册后取 rt(可续期·耗接码)</span>
                            </label>
                            <label className="inline-flex items-center gap-1 cursor-pointer text-sm" title="注册拿到 AT 后立刻绑 TOTP，密钥写入本号">
                                <input type="checkbox" checked={mfaEnabled} onChange={(e) => { setMfaEnabled(e.target.checked); api.setMfa(e.target.checked).then(() => notify(e.target.checked ? "已开启:注册后自动绑 2FA" : "已关闭注册后自动绑 2FA")).catch((err: any) => { setMfaEnabled(!e.target.checked); notify(err.message); }); }} />
                                <span className="text-emerald-700">注册后自动绑 2FA</span>
                            </label>
                            <input value={smsLinkTemplate} onChange={(e) => setSmsLinkTemplate(e.target.value)}
                                   placeholder="接码链接模板 https://eccaptcha.com/api/GetVerifyCode?key=你的KEY&phone={phone}&project=45"
                                   className="flex-1 min-w-[280px] px-2 py-1 border rounded text-xs font-mono"/>
                            <button onClick={() => api.saveSmsTemplate(smsLinkTemplate).then(() => notify("接码链接模板已保存")).catch((e: any) => notify(e.message))}
                                    className="px-3 py-1 bg-gray-600 text-white rounded text-xs whitespace-nowrap">保存模板</button>
                            <label className="inline-flex items-center gap-1 text-sm whitespace-nowrap" title="一个手机号最多给几个账号做手机验证；用满或被 OpenAI 拒后自动换下一个号。0=不限直到被拒">
                                <span className="text-indigo-700">每号绑定上限</span>
                                <input type="number" min={0} value={smsMaxBind}
                                       onChange={(e) => { const v = Math.max(0, Math.floor(Number(e.target.value) || 0)); setSmsMaxBind(v); api.setSmsMaxBind(v).then(() => notify(`每号绑定上限=${v || "不限"}`)).catch((err: any) => notify(err.message)); }}
                                       className="w-16 px-2 py-1 border rounded"/>
                                <span className="text-gray-400 text-xs">(0=不限)</span>
                            </label>
                        </div>
                        <div className="mt-2 text-sm text-gray-600">
                            接码池：<span className="text-green-700 font-medium">可用 {smsData.stats.free}</span> · 使用中 {smsData.stats.claimed ?? 0} · 已用 {smsData.stats.used}{smsData.stats.bad ? <span className="text-red-500"> · 坏号 {smsData.stats.bad}</span> : null} · 共 {smsData.stats.total}
                            <span className="ml-2 text-gray-400">(claim 只借出、提交成功才消耗；未注册/被拒自动换号，收码超时不换号)</span>
                        </div>
                        {smsData.list.length > 0 && (
                            <div className="mt-2 max-h-44 overflow-auto border rounded bg-white">
                                <table className="w-full text-xs">
                                    <thead className="bg-gray-100 text-gray-500 sticky top-0"><tr><th className="text-left px-2 py-1">卡密</th><th className="text-left px-2 py-1">手机号</th><th className="text-left px-2 py-1">状态</th><th className="text-left px-2 py-1">绑定数</th><th className="text-left px-2 py-1">绑定账号</th><th className="text-left px-2 py-1">操作</th></tr></thead>
                                    <tbody>
                                        {smsData.list.map((s) => (
                                            <tr key={s.id} className="border-t">
                                                <td className="px-2 py-1 font-mono text-gray-500">{s.card || "—"}</td>
                                                <td className="px-2 py-1 font-mono">{s.phone}</td>
                                                <td className="px-2 py-1"><span className={s.status === "free" ? "text-green-600" : s.status === "claimed" ? "text-amber-600" : "text-gray-400"}>{(({free: "可用", claimed: "使用中", used: "已用", bad: "坏号"} as any)[s.status]) || s.status}</span></td>
                                                <td className="px-2 py-1 text-gray-500">{s.bind_count || 0}{smsMaxBind > 0 ? <span className="text-gray-400">/{smsMaxBind}</span> : null}</td>
                                                <td className="px-2 py-1 font-mono text-gray-400 max-w-[200px] truncate" title={s.bind_emails || s.bound_email || ""}>{s.bind_emails || s.bound_email || "—"}</td>
                                                <td className="px-2 py-1 whitespace-nowrap">
                                                    <button onClick={() => api.peekSms(s.id).then((r) => notify("短信: " + (r.text || "").slice(0, 60))).catch((e) => notify(e.message))} className="text-indigo-600 hover:underline mr-2">测收码</button>
                                                    <button onClick={() => api.deleteSms(s.id).then(refreshSms)} className="text-red-400 hover:underline">删除</button>
                                                </td>
                                            </tr>
                                        ))}
                                    </tbody>
                                </table>
                            </div>
                        )}
                    </div>
                )}
            </div>

            {/* 主体：表格 + 日志 */}
            <div className="flex-1 flex min-h-0">
                <div className="flex-1 flex flex-col min-h-0">
                    <div className="flex items-center gap-2 px-4 py-2 border-b bg-gray-50 text-sm flex-wrap shrink-0">
                        <span className="text-gray-500">共 <b className="text-gray-700">{filtered.length}</b> 条{delHits > 0 ? <>（含已删除 <b className="text-gray-500">{delHits}</b> 条，只读）</> : null}{selectedIds.size > 0 ? <> · 已选 <b className="text-indigo-600">{selectedIds.size}</b> 个</> : "（未选则对当前列表全部执行）"}</span>
                        <button onClick={() => api.batchTestAt(selectedIds.size ? [...selectedIds] : actionable.map((a) => a.id)).then((r) => notify(`批量测 at：${r.count} 个`)).catch((e) => notify(e.message))} className="px-2 py-1 bg-blue-600 text-white rounded text-xs">批量测 at</button>
                        {batchAt.running
                            ? <button onClick={() => api.stopBatchAt().then(() => notify("已请求停止(当前号跑完即停)")).catch((e) => notify(e.message))} className="px-2 py-1 bg-red-600 text-white rounded text-xs animate-pulse">⏹ 停止重登 {batchAt.done}/{batchAt.total}</button>
                            : <button onClick={() => { const ids = selectedIds.size ? [...selectedIds] : actionable.map((a) => a.id); if (!ids.length) { notify("无账号"); return; } if (!window.confirm(`对 ${ids.length} 个号【串行】测 at，失效的走浏览器登录重新获取(一次一个、每个约1-2分钟、可停止)。开始？`)) return; api.batchTestAt(ids, true).then((r) => notify(`已开始串行重登 ${r.count} 个`)).catch((e) => notify(e.message)); }} title="批量测 at,失效的号串行(一次一个)走浏览器登录重新获取 at" className="px-2 py-1 bg-blue-700 text-white rounded text-xs">批量重登at(串行)</button>}
                        <button onClick={() => api.batchTestRt(selectedIds.size ? [...selectedIds] : actionable.map((a) => a.id)).then((r) => notify(`批量测 rt：${r.count} 个(只刷新有效的)`)).catch((e) => notify(e.message))} title="只刷新有效 rt、标记失效的;不重登、不耗接码" className="px-2 py-1 bg-teal-600 text-white rounded text-xs">批量测 rt</button>
                        <button onClick={() => { const ids = selectedIds.size ? [...selectedIds] : actionable.map((a) => a.id); if (!ids.length) { notify("无账号"); return; } if (!window.confirm(`对 ${ids.length} 个号批量测 rt，过期/无rt 的会【重登获取 rt】(走 codex OAuth + add-phone 接码，每号消耗一个接码号、有成本、较慢)。开始？`)) return; api.batchTestRt(ids, true).then((r) => notify(`已开始批量重取 rt ${r.count} 个(过期/无rt 会重登获取)`)).catch((e) => notify(e.message)); }} title="过期/无rt 的号重登获取 rt(codex OAuth+接码,有成本)" className="px-2 py-1 bg-teal-700 text-white rounded text-xs">批量重取rt(耗接码)</button>
                        <button onClick={() => api.batchTestChat(selectedIds.size ? [...selectedIds] : actionable.map((a) => a.id)).then((r) => notify(`批量测聊天：${r.count} 个（逐个开浏览器）`)).catch((e) => notify(e.message))} className="px-2 py-1 bg-fuchsia-600 text-white rounded text-xs">批量测聊天</button>
                        <button onClick={() => { const ids = selectedIds.size ? [...selectedIds] : actionable.map((a) => a.id); if (!ids.length) { notify("无账号"); return; } api.enrollMfa(ids).then((r) => notify(`开始绑 2FA ${r.count} 个(需有效 AT)`)).catch((e) => notify(e.message)); }} title="用现有 AT 绑定 TOTP，之后重登走密码+验证器" className="px-2 py-1 bg-emerald-700 text-white rounded text-xs">批量绑2FA</button>
                        {/* 已售出改回未售出:误标/退回重新上架。只对已售出的号生效 */}
                        <button onClick={async () => {
                            const pool = selectedIds.size ? actionable.filter((a) => selectedIds.has(a.id)) : actionable;
                            const ids = pool.filter((a) => a.sold_at).map((a) => a.id);
                            if (!ids.length) { notify("选中(或当前列表)里没有已售出的账号"); return; }
                            if (!window.confirm(`把 ${ids.length} 个已售出账号改回【未售出】？(重新参与保活)`)) return;
                            try {
                                const r = await api.setSold(ids, false);
                                setSelectedIds(new Set());
                                await api.listAccounts().then(setAccounts);
                                notify(`已把 ${r.count} 个账号改回未售出`);
                            } catch (e: any) { notify(e.message); }
                        }} title="把选中(或当前列表)里已售出的号改回未售出,误标/退回时用" className="px-2 py-1 bg-amber-500 text-white rounded text-xs">改回未售出</button>
                        <span className="mx-1 text-gray-300">|</span>
                        <input value={batchAssign} onChange={(e) => setBatchAssign(e.target.value)} placeholder="批次名" list="batch-list" className="w-24 px-2 py-1 border rounded text-xs"/>
                        <datalist id="batch-list">{batches.map((b) => <option key={b.name} value={b.name}/>)}</datalist>
                        <button onClick={setBatchForSelected} title="给选中(或当前列表全部)的号设置批次名,便于分组筛选/导出" className="px-2 py-1 bg-cyan-600 text-white rounded text-xs">设置批次</button>
                        <button onClick={async () => {
                            const ids = selectedIds.size ? [...selectedIds] : actionable.map((a) => a.id);
                            if (!ids.length) { notify("无可删除的账号"); return; }
                            const who = selectedIds.size ? `选中的 ${ids.length} 个` : `当前列表全部 ${ids.length} 个`;
                            if (!window.confirm(`确认删除${who}账号？邮箱将一并删除。运行中的会跳过。`)) return;
                            try { const r = await api.batchDelete(ids); setSelectedIds(new Set()); invalidateDeleted(); await api.listAccounts(showDeleted).then(setAccounts); notify(`已删除 ${r.count} 个${r.skipped ? `（跳过运行中 ${r.skipped}）` : ""}`); }
                            catch (e: any) { notify(e.message); }
                        }} title="删除选中(或当前列表全部)的号" className="px-2 py-1 bg-red-600 text-white rounded text-xs">🗑 删除选中</button>
                        <span className="mx-1 text-gray-300">|</span>
                        <input type="number" min={1} value={quickSelN} onChange={(e) => setQuickSelN(Math.max(1, +e.target.value || 1))} className="w-14 px-1 py-1 border rounded text-xs text-center"/>
                        <button onClick={() => { const s = new Set<number>(); actionable.slice(0, quickSelN).forEach((a) => s.add(a.id)); setSelectedIds(s); }} className="px-2 py-1 bg-gray-200 rounded text-xs hover:bg-gray-300" title={`选中当前列表前 ${quickSelN} 个`}>选前N</button>
                        <button onClick={() => { const s = new Set<number>(); actionable.slice(-quickSelN).forEach((a) => s.add(a.id)); setSelectedIds(s); }} className="px-2 py-1 bg-gray-200 rounded text-xs hover:bg-gray-300" title={`选中当前列表后 ${quickSelN} 个`}>选后N</button>
                        {selectedIds.size > 0 && <button onClick={() => setSelectedIds(new Set())} className="text-gray-400 hover:underline text-xs">清空</button>}
                    </div>
                    <div ref={scrollRef} onScroll={(e) => setScrollTop((e.target as HTMLDivElement).scrollTop)} className="flex-1 overflow-auto min-h-0">
                    <table className="w-full text-sm">
                        <thead className="bg-gray-100 text-gray-500 sticky top-0 z-10">
                        <tr>
                            <th className="px-2 py-2"><input type="checkbox" title="全选当前列表"
                                checked={actionable.length > 0 && actionable.every((a) => selectedIds.has(a.id))}
                                onChange={(e) => setSelectedIds((prev) => { const s = new Set(prev); actionable.forEach((a) => e.target.checked ? s.add(a.id) : s.delete(a.id)); return s; })}/></th>
                            <th className="text-left px-4 py-2 font-medium">#</th>
                            <th className="text-left px-4 py-2 font-medium">邮箱</th>
                            <th className="text-left px-4 py-2 font-medium" title="ChatGPT 登录密码(空则用系统默认)">GPT密码</th>
                            <th className="text-left px-4 py-2 font-medium">状态</th>
                            <th className="text-left px-4 py-2 font-medium">套餐</th>
                            <th className="text-left px-4 py-2 font-medium" title="ChatGPT TOTP 绑定状态">2FA</th>
                            <th className="text-left px-4 py-2 font-medium">注册时间/存活</th>
                            <th className="text-left px-4 py-2 font-medium" title="at / rt / 聊天 概览，点行看详情可测试">令牌</th>
                        </tr>
                        </thead>
                        <tbody>
                        {vTopPad > 0 && <tr style={{height: vTopPad}}><td colSpan={9} className="p-0"/></tr>}
                        {vRows.map((a, idx) => { const i = vStart + idx; return (
                            <tr key={a.id} style={{height: ROW_H}}
                                onClick={() => { setSelectedId(a.id); setLogMode("single"); setPanelOpen(true); setEditMode(false); api.getAccount(a.id).then((r) => { const upd = (prev: Account[]) => prev.map((x) => (x.id === a.id ? r : x)); a.deleted_at && !showDeleted ? setDelAccounts(upd) : setAccounts(upd); }).catch(() => {}); }}
                                className={`border-b cursor-pointer hover:bg-indigo-50 ${selectedId === a.id ? "bg-indigo-100" : ""} ${a.deleted_at && !showDeleted ? "opacity-60" : ""}`}>
                                <td className="px-2 py-2" onClick={(e) => e.stopPropagation()}>
                                    {/* 搜索带出的已删除号只读:不参与批量操作 */}
                                    <input type="checkbox" disabled={!!a.deleted_at && !showDeleted} checked={selectedIds.has(a.id)} onChange={() => toggleSel(a.id)}/>
                                </td>
                                <td className="px-4 py-2 text-gray-400" title={`账号ID ${a.id}`}>{i + 1}</td>
                                <td className="px-4 py-2 font-mono">
                                    {a.email}
                                    {a.sold_at ? <span className="ml-1 px-1 rounded bg-amber-100 text-amber-700 text-xs">已售</span> : null}
                                    {a.deleted_at && !showDeleted ? <span className="ml-1 px-1 rounded bg-gray-200 text-gray-500 text-xs" title={`已删除 ${fmtDateTime(a.deleted_at)}`}>已删除</span> : null}
                                </td>
                                <td className="px-4 py-2 font-mono text-xs select-all" title={a.gpt_password ? "本号独立 GPT 密码" : (defaultGptPw ? "库中为空,登录用系统默认密码" : "无 GPT 密码")}
                                    onClick={(e) => {
                                        const pw = accountGptPw(a, defaultGptPw);
                                        if (!pw) return;
                                        e.stopPropagation();
                                        navigator.clipboard?.writeText(pw);
                                        notify("GPT密码已复制");
                                    }}>
                                    {accountGptPw(a, defaultGptPw) || <span className="text-gray-300">—</span>}
                                    {!a.gpt_password && defaultGptPw ? <span className="ml-1 text-[10px] text-gray-400">默认</span> : null}
                                </td>
                                <td className="px-4 py-2">
                                    <span className={`px-2 py-0.5 rounded text-xs font-medium ${STATUS_STYLE[a.status]}`}>{STATUS_LABEL[a.status]}</span>
                                    {/account_deactivated/i.test(a.error || "")
                                        ? <span className="ml-1 px-1.5 py-0.5 rounded bg-gray-300 text-gray-700 text-xs" title={a.error}>已停用</span>
                                        : a.status === "failed" && a.error ? <span className="ml-2 text-xs text-red-400" title={a.error}>{a.error.slice(0, 20)}…</span> : null}
                                </td>
                                <td className="px-4 py-2">{a.plan && <span className="px-2 py-0.5 bg-purple-100 text-purple-700 rounded text-xs">{a.plan}</span>}</td>
                                <td className="px-4 py-2 whitespace-nowrap" title={a.mfa_status || "未绑"}>
                                    {/✅/.test(a.mfa_status || "")
                                        ? <span className="px-1.5 py-0.5 rounded bg-emerald-100 text-emerald-700 text-xs">已绑</span>
                                        : /❌|⚠/.test(a.mfa_status || "")
                                            ? <span className="px-1.5 py-0.5 rounded bg-amber-100 text-amber-700 text-xs">{(a.mfa_status || "").slice(0, 8)}</span>
                                            : <span className="text-gray-300 text-xs">未绑</span>}
                                </td>
                                <td className="px-4 py-2 text-xs whitespace-nowrap" title={a.finished_at ? `注册完成 ${fmtDateTime(a.finished_at)}${a.dead_at ? ` · 失效 ${fmtDateTime(a.dead_at)}` : ""}` : "未成功"}>
                                    {a.status === "success"
                                        ? <span className="text-gray-500">
                                            {fmtDateTime(a.finished_at)}{" "}
                                            <span className={a.dead_at ? "text-red-500 font-medium" : "text-green-600 font-medium"}>· 存活{aliveDays(a.finished_at, a.dead_at, a.created_at)}{a.dead_at ? "(已失效)" : ""}</span>
                                            {a.started_at && a.finished_at ? <span className="text-gray-400"> · 耗时{fmtDuration(a.started_at, a.finished_at)}</span> : null}
                                          </span>
                                        : <span className="text-gray-300">—</span>}
                                </td>
                                <td className="px-4 py-2 text-xs whitespace-nowrap">
                                    {([["at", a.at_status], ["rt", a.rt_status], ["聊", a.chat_status]] as const).map(([k, v]) => (
                                        <span key={k} className="inline-flex items-center gap-1 mr-2" title={`${k}：${v || "未测"}`}>
                                            <i className={`inline-block w-1.5 h-1.5 rounded-full ${v?.includes("✅") ? "bg-green-500" : v?.includes("❌") ? "bg-red-500" : "bg-gray-300"}`}/>
                                            <span className="text-gray-500">{k}</span>
                                        </span>
                                    ))}
                                </td>
                            </tr>
                        ); })}
                        {vBotPad > 0 && <tr style={{height: vBotPad}}><td colSpan={9} className="p-0"/></tr>}
                        {filtered.length === 0 && (
                            <tr><td colSpan={9} className="px-4 py-10 text-center text-gray-400">暂无数据。请到「📮 邮箱管理」导入独立邮箱并分配给 GPT，即可在此注册。</td></tr>
                        )}
                        </tbody>
                    </table>
                    </div>
                </div>

                {/* 右侧抽屉：全局实时日志 / 账号详情(含日志·收件箱 tab) */}
                {panelOpen && (
                <div className="w-[40%] min-w-[380px] border-l bg-white flex flex-col min-h-0">
                    {logMode === "all" || !selected ? (
                        /* —— 全局实时日志 —— */
                        <>
                            <div className="px-3 py-2 border-b flex items-center gap-2 bg-gray-900 text-gray-100">
                                <span onClick={() => setPanelOpen(false)} title="点击收起日志面板" className="text-sm font-medium cursor-pointer hover:text-white select-none">🌐 全部实时日志 <span className="text-gray-500 text-xs">⟩收起</span></span>
                                <span className="ml-auto text-gray-500 text-xs">所有任务合并 · 实时</span>
                            </div>
                            <div className="flex-1 overflow-auto px-3 py-2 font-mono text-xs leading-relaxed bg-gray-900 text-gray-100">
                                {allLogs.length === 0
                                    ? <div className="text-gray-500">（开始注册后，这里实时显示所有号的进度；点左侧某行看该号详情）</div>
                                    : allLogs.map((l, i) => (
                                        <div key={i} className="whitespace-pre-wrap break-all">
                                            <span className="text-gray-600">{new Date(l.ts).toLocaleTimeString()} </span>
                                            <span className="text-amber-300">{l.email.split("@")[0]}</span>
                                            <span className="text-gray-700"> │ </span>
                                            <span className={l.line.includes("✅") ? "text-green-400" : l.line.includes("❌") ? "text-red-400" : ""}>{l.line}</span>
                                        </div>
                                    ))}
                                <div ref={logEndRef}/>
                            </div>
                        </>
                    ) : (
                        /* —— 账号详情 —— */
                        <>
                            <div className="px-4 py-3 border-b flex items-center gap-2">
                                <button onClick={() => { setSelectedId(null); setLogMode("all"); }} title="返回全局日志" className="text-gray-400 hover:text-gray-700">◀</button>
                                <span onClick={() => setInfoOpen((v) => !v)} title={infoOpen ? "点击邮箱收起账户信息(给日志/收件箱更多空间)" : "点击邮箱展开账户信息"} className="font-mono text-sm truncate flex-1 cursor-pointer hover:text-indigo-600 select-none"><span className="text-gray-400 mr-1">{infoOpen ? "▾" : "▸"}</span>{selected.email}</span>
                                <span className={`px-2 py-0.5 rounded text-xs font-medium ${STATUS_STYLE[selected.status]}`}>{STATUS_LABEL[selected.status]}</span>
                                <button onClick={() => setPanelOpen(false)} title="收起面板" className="text-gray-400 hover:text-gray-700">⟩</button>
                            </div>
                            {infoOpen && (editMode ? (
                                /* —— 编辑记录(改本地库全字段) —— */
                                <div className="px-4 py-3 border-b space-y-2 text-sm shrink-0 overflow-auto" onClick={(e) => e.stopPropagation()}>
                                    {([["email", "邮箱"], ["password", "密码(明文)"], ["gpt_password", "GPT密码"], ["totp_secret", "2FA密钥"], ["mfa_status", "2FA状态"], ["batch", "批次"], ["plan", "套餐"], ["phone", "手机"], ["card", "卡密"], ["at_status", "at状态"], ["rt_status", "rt状态"], ["chat_status", "聊天状态"]] as const).map(([k, label]) => (
                                        <label key={k} className="flex items-center gap-2">
                                            <span className="w-16 text-gray-400 shrink-0 text-xs">{label}</span>
                                            <input value={editForm[k] ?? ""} onChange={ef(k)} className="flex-1 px-2 py-1 border rounded text-xs font-mono"/>
                                        </label>
                                    ))}
                                    <label className="flex items-center gap-2">
                                        <span className="w-16 text-gray-400 shrink-0 text-xs">状态</span>
                                        <select value={editForm.status} onChange={ef("status")} className="flex-1 px-2 py-1 border rounded text-xs">
                                            {["pending", "running", "success", "failed"].map((s) => <option key={s} value={s}>{s}</option>)}
                                        </select>
                                    </label>
                                    <label className="flex items-start gap-2">
                                        <span className="w-16 text-gray-400 shrink-0 text-xs pt-1">错误</span>
                                        <textarea value={editForm.error ?? ""} onChange={ef("error")} className="flex-1 px-2 py-1 border rounded text-xs h-14 resize-y"/>
                                    </label>
                                    <div className="flex items-center gap-4 pl-16 text-xs">
                                        <label className="inline-flex items-center gap-1 cursor-pointer"><input type="checkbox" checked={!!editForm.dead} onChange={(e) => setEditForm((p) => ({...p, dead: e.target.checked}))}/>已失效</label>
                                        <label className="inline-flex items-center gap-1 cursor-pointer"><input type="checkbox" checked={!!editForm.sold} onChange={(e) => setEditForm((p) => ({...p, sold: e.target.checked}))}/>已售出</label>
                                    </div>
                                    <div className="flex gap-2 pt-1">
                                        <button onClick={() => saveEdit(selected.id)} className="px-3 py-1 bg-green-600 hover:bg-green-700 text-white rounded text-xs">保存</button>
                                        <button onClick={() => setEditMode(false)} className="px-3 py-1 bg-gray-200 hover:bg-gray-300 rounded text-xs">取消</button>
                                    </div>
                                </div>
                            ) : (
                              <>
                                {/* 全字段展示(密码明文) */}
                                <div className="px-4 py-3 border-b text-sm grid grid-cols-[5.5rem_1fr] gap-x-3 gap-y-1.5 shrink-0" onClick={(e) => e.stopPropagation()}>
                                    <span className="text-gray-400">ID</span><span className="text-gray-600">{selected.id}</span>
                                    <span className="text-gray-400">邮箱密码</span>
                                    <span className="font-mono text-xs break-all text-gray-700 select-text cursor-text">
                                        {selected.password || "—"}
                                        {selected.password ? <button type="button" className="ml-2 text-[11px] text-indigo-600 hover:underline" onClick={() => { navigator.clipboard?.writeText(selected.password || ""); notify("邮箱密码已复制"); }}>复制</button> : null}
                                    </span>
                                    <span className="text-gray-400">GPT密码</span>
                                    <span className="font-mono text-xs break-all text-gray-700 select-text cursor-text">
                                        {accountGptPw(selected, defaultGptPw) || "—"}
                                        {!selected.gpt_password && defaultGptPw ? <span className="ml-1 text-[10px] text-gray-400">默认</span> : null}
                                        {accountGptPw(selected, defaultGptPw) ? <button type="button" className="ml-2 text-[11px] text-indigo-600 hover:underline" onClick={() => { navigator.clipboard?.writeText(accountGptPw(selected, defaultGptPw)); notify("GPT密码已复制"); }}>复制</button> : null}
                                    </span>
                                    <span className="text-gray-400">2FA</span>
                                    <span className="min-w-0">
                                        <span className={`text-xs ${/✅/.test(selected.mfa_status || "") ? "text-green-600" : /❌/.test(selected.mfa_status || "") ? "text-red-500" : "text-gray-400"}`}>{selected.mfa_status || "未绑"}</span>
                                        {selected.totp_secret ? (
                                            <span className="block mt-0.5 space-y-0.5">
                                                <span className="font-mono text-[11px] break-all text-gray-700 select-all">{selected.totp_secret}</span>
                                                <button type="button" className="ml-2 text-[11px] text-indigo-600 hover:underline" onClick={() => { navigator.clipboard?.writeText(selected.totp_secret || ""); notify("2FA 密钥已复制"); }}>复制密钥</button>
                                                <span className="block"><TotpLive secret={selected.totp_secret}/></span>
                                            </span>
                                        ) : (
                                            <button type="button" className="ml-2 text-[11px] text-emerald-700 hover:underline" onClick={() => api.enrollMfa([selected.id]).then((r) => notify(`开始绑 2FA ${r.count} 个(需有效 AT)`)).catch((e) => notify(e.message))}>去绑定</button>
                                        )}
                                    </span>
                                    <span className="text-gray-400">改密</span><span className={`text-xs ${String(selected.pw_status || "").includes("✅") ? "text-green-600" : String(selected.pw_status || "").includes("❌") ? "text-red-500" : "text-gray-400"}`} title={selected.pw_status || "未改过邮箱密码"}>{selected.pw_status || "未改过"}</span>
                                    <span className="text-gray-400">套餐</span><span>{selected.plan ? <span className="px-2 py-0.5 bg-purple-100 text-purple-700 rounded text-xs">{selected.plan}</span> : "—"}</span>
                                    <span className="text-gray-400">批次</span><span className="text-xs text-gray-600">{selected.batch ? <span className="px-2 py-0.5 bg-cyan-100 text-cyan-700 rounded">{selected.batch}</span> : "—"}</span>
                                    <span className="text-gray-400">手机</span><span className="font-mono text-xs text-gray-600 select-text">{selected.phone ? "+" + selected.phone : "—"}{selected.card ? ` · 卡密 ${selected.card}` : ""}</span>
                                    <span className="text-gray-400">注册</span><span className="text-gray-600">{selected.finished_at ? <>{fmtDateTime(selected.finished_at)} <span className={selected.dead_at ? "text-red-500" : "text-green-600"}>· 存活{aliveDays(selected.finished_at, selected.dead_at, selected.created_at)}{selected.dead_at ? "(已失效)" : ""}</span>{selected.sold_at ? <span className="ml-1 px-1 rounded bg-amber-100 text-amber-700 text-xs">已售</span> : null}</> : "—"}</span>
                                    <span className="text-gray-400">耗时</span><span className="text-gray-600 text-xs" title="注册开始→完成的花费时长(started_at→finished_at)">{fmtDuration(selected.started_at, selected.finished_at)}</span>
                                    <span className="text-gray-400">创建</span><span className="text-gray-500 text-xs">{fmtDateTime(selected.created_at)}</span>
                                    <span className="text-gray-400">at令牌</span><span className="font-mono text-xs break-all text-gray-500 select-text cursor-text">{selected.token ? selected.token.slice(0, 48) + "…" : "—"}</span>
                                    <span className="text-gray-400">at文件</span><span className="font-mono text-[11px] break-all text-gray-400 select-text">{selected.auth_file || "—"}</span>
                                    <span className="text-gray-400">rt文件</span><span className="font-mono text-[11px] break-all text-gray-400 select-text">{selected.rt_file || "—"}</span>
                                    {selected.error && <><span className="text-gray-400">错误</span><span className="text-red-500 text-xs break-all">{selected.error}</span></>}
                                </div>
                                {/* 令牌三态 + 测试 */}
                                <div className="px-4 py-3 border-b space-y-1.5 text-sm shrink-0" onClick={(e) => e.stopPropagation()}>
                                    {([["at", selected.at_status, () => api.testAt(selected.id), "text-blue-600"],
                                       ["rt", selected.rt_status, () => api.testRt(selected.id), "text-teal-600"],
                                       ["聊天", selected.chat_status, () => api.testChat(selected.id), "text-fuchsia-600"]] as const).map(([k, v, fn, cls]) => (
                                        <div key={k} className="flex items-center gap-2">
                                            <span className="w-8 text-gray-400">{k}</span>
                                            <span className={`flex-1 text-xs ${v?.includes("✅") ? "text-green-600" : v?.includes("❌") ? "text-red-500" : "text-gray-400"}`}>{v || "未测"}</span>
                                            <button title={k === "rt" ? "有rt→刷新续期；无rt/已过期→走 codex OAuth 获取(会耗接码)" : undefined}
                                                    onClick={() => { notify(`测 ${k} 中…`); fn().then((r: any) => notify(r?.ok ? `${k} ✅有效` : `${k} ❌${(r?.reason || "失效").slice(0, 40)}`)).catch((e: any) => notify(`${k} 测试异常: ${e.message}`)); }} className={`${cls} hover:underline text-xs`}>测</button>
                                        </div>
                                    ))}
                                </div>
                                {/* 操作 */}
                                <div className="px-4 py-2.5 border-b flex flex-wrap gap-2 shrink-0" onClick={(e) => e.stopPropagation()}>
                                    <button onClick={() => startEdit(selected)} title="编辑本地库记录(全字段,不动真邮箱)" className="px-2.5 py-1 bg-slate-600 hover:bg-slate-700 text-white rounded text-xs">✏️ 编辑</button>
                                    <button onClick={() => doOpenBrowser(selected)} disabled={!selected.auth_file} title={selected.auth_file ? "注入 at 打开已登录的 chatgpt 浏览器" : "无 at 授权文件，不能打开"} className={`px-2.5 py-1 rounded text-xs text-white ${selected.auth_file ? "bg-emerald-600 hover:bg-emerald-700" : "bg-gray-300 cursor-not-allowed"}`}>🌐 打开浏览器</button>
                                    <button onClick={() => api.getSession(selected.id).then((r) => { navigator.clipboard?.writeText(JSON.stringify(r.session)); notify("session json 已复制"); }).catch((e) => notify(`复制失败: ${e.message}`))} disabled={!selected.auth_file} title={selected.auth_file ? "复制该号 session json(可恢复登录态,同导出 session 格式)" : "无 at 授权文件，没有 session"} className={`px-2.5 py-1 rounded text-xs text-white ${selected.auth_file ? "bg-cyan-600 hover:bg-cyan-700" : "bg-gray-300 cursor-not-allowed"}`}>📋 复制session</button>
                                    {/* 已删除的号只读:重跑/再删无意义(调度器不认领软删记录),留查看+导出凭证的能力 */}
                                    {selected.deleted_at
                                        ? <span className="px-2 py-1 rounded bg-gray-200 text-gray-500 text-xs" title={`已删除 ${fmtDateTime(selected.deleted_at)}`}>已删除（只读）</span>
                                        : <>
                                    {(selected.status === "failed" || selected.status === "success") &&
                                        <button onClick={() => api.retry(selected.id).then(() => notify("已重新排队")).catch((e) => notify(e.message))} className="px-2.5 py-1 bg-indigo-500 hover:bg-indigo-600 text-white rounded text-xs">重跑</button>}
                                    <button onClick={() => { if (!window.confirm(`删除 ${selected.email}？邮箱将一并删除。`)) return; api.remove(selected.id).then(() => { setSelectedId(null); setLogMode("all"); invalidateDeleted(); api.listAccounts(showDeleted).then(setAccounts); }).catch((e) => notify(e.message)); }} className="px-2.5 py-1 bg-red-500 hover:bg-red-600 text-white rounded text-xs">删除</button>
                                          </>}
                                </div>
                              </>
                            ))}
                            {/* 日志(注册过程日志;收件箱已迁至「📮 邮箱管理」的邮箱详情) */}
                            <div className="px-3 pt-2 flex items-center gap-1 text-sm shrink-0">
                                <span className="px-3 py-1.5 rounded-t text-xs font-medium bg-gray-900 text-white">📋 日志</span>
                            </div>
                            <div className="flex-1 overflow-auto min-h-0">
                                <div className="px-3 py-2 font-mono text-xs leading-relaxed bg-gray-900 text-gray-100 min-h-full">
                                    {logs.length === 0
                                        ? <div className="text-gray-500">（暂无该号日志）</div>
                                        : logs.map((l, i) => (
                                            <div key={i} className="whitespace-pre-wrap break-all">
                                                <span className="text-gray-600">{new Date(l.ts).toLocaleTimeString()} </span>
                                                <span className={l.line.includes("✅") ? "text-green-400" : l.line.includes("❌") ? "text-red-400" : ""}>{l.line}</span>
                                            </div>
                                        ))}
                                    <div ref={logEndRef}/>
                                </div>
                            </div>
                        </>
                    )}
                </div>
                )}
                {!panelOpen && (
                    <button onClick={() => setPanelOpen(true)} title="展开日志/详情面板"
                            className="border-l bg-gray-900 text-gray-300 hover:text-white px-1.5 py-4 text-xs [writing-mode:vertical-rl] tracking-widest">⟨ 日志/详情</button>
                )}
            </div>
            {showExport && (
                <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-30" onClick={() => setShowExport(false)}>
                    <div className="bg-white rounded-xl w-[480px] shadow-2xl" onClick={(e) => e.stopPropagation()}>
                        <div className="px-5 py-3 border-b flex items-center justify-between">
                            <span className="font-medium">⬇ 导出账号</span>
                            <button onClick={() => setShowExport(false)} className="text-gray-400 hover:text-gray-700 text-lg leading-none">✕</button>
                        </div>
                        <div className="px-5 py-4 space-y-3 text-sm">
                            <label className="flex items-center gap-2"><span className="w-14 text-gray-400 shrink-0">范围</span>
                                <select value={exportRange} onChange={(e) => setExportRange(e.target.value as any)} className="flex-1 px-2 py-1.5 border rounded">
                                    <option value="all">全部(可用号 + 有GPT密码的谷歌号)</option>
                                    <option value="filtered">当前筛选({actionable.length})</option>
                                    <option value="selected">选中的号({selectedIds.size})</option>
                                    <option value="batch">按批次…</option>
                                </select>
                            </label>
                            {exportRange === "batch" &&
                                <label className="flex items-center gap-2"><span className="w-14 text-gray-400 shrink-0">批次</span>
                                    <select value={exportBatch} onChange={(e) => setExportBatch(e.target.value)} className="flex-1 px-2 py-1.5 border rounded">
                                        <option value="">请选择批次…</option>
                                        {batches.map((b) => <option key={b.name} value={b.name}>{b.name} ({b.count})</option>)}
                                    </select>
                                </label>}
                            <label className="flex items-center gap-2"><span className="w-14 text-gray-400 shrink-0">rt 筛选</span>
                                <select value={exportScope} onChange={(e) => setExportScope(e.target.value as any)} className="flex-1 px-2 py-1.5 border rounded">
                                    <option value="all">不限(带rt+只有at)</option>
                                    <option value="hasRt">仅带 rt 的</option>
                                    <option value="atOnly">仅只有 at 的</option>
                                </select>
                            </label>
                            <label className="flex items-center gap-2"><span className="w-14 text-gray-400 shrink-0">格式</span>
                                <select value={exportFormat} onChange={(e) => setExportFormat(e.target.value as any)} className="flex-1 px-2 py-1.5 border rounded">
                                    <option value="full">账号(邮箱----邮箱密码----邮箱2FA[----GPT密码----GPT2FA----rt])</option>
                                    <option value="at">账号+AT(邮箱--邮箱密码--accessToken)</option>
                                    <option value="session">session(邮箱--邮箱密码--session json)</option>
                                    <option value="jsonl">JSONL(含 accessToken)</option>
                                    <option value="csv">CSV(统一列, 含 rt/卡密)</option>
                                </select>
                            </label>
                            <label className="flex items-center gap-2 cursor-pointer text-amber-700 pt-1">
                                <input type="checkbox" checked={exportMarkSold} onChange={(e) => setExportMarkSold(e.target.checked)}/>
                                导出后把这批号标记为【已售出】
                            </label>
                        </div>
                        <div className="px-5 py-3 border-t flex items-center gap-2">
                            <span className="text-sm text-gray-500 mr-auto">将导出 <b className={exportCount ? "text-emerald-600" : "text-red-500"}>{exportCount}</b> 条{exportSkipped > 0 && <span className="text-gray-400">（排除不可用 {exportSkipped} 条）</span>}</span>
                            <button onClick={() => setShowExport(false)} className="px-4 py-1.5 bg-gray-200 hover:bg-gray-300 rounded text-sm">取消</button>
                            <button onClick={doExportFull} className="px-4 py-1.5 bg-emerald-600 hover:bg-emerald-700 text-white rounded text-sm">⬇ 导出</button>
                        </div>
                    </div>
                </div>
            )}
            {showRefreshAt && (
                <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-30" onClick={() => !refreshAtRunning && setShowRefreshAt(false)}>
                    <div className="bg-white rounded-xl w-[700px] max-h-[85vh] flex flex-col shadow-2xl" onClick={(e) => e.stopPropagation()}>
                        <div className="px-5 py-3 border-b flex items-center justify-between">
                            <span className="font-medium">🔄 批量获取 AccessToken <span className="text-xs text-gray-400 font-normal">粘贴邮箱列表，走浏览器登录重新拿 at</span></span>
                            <button onClick={() => !refreshAtRunning && setShowRefreshAt(false)} disabled={refreshAtRunning} className="text-gray-400 hover:text-gray-700 text-lg leading-none disabled:opacity-40">✕</button>
                        </div>
                        <div className="px-5 py-4 space-y-3 text-sm overflow-auto">
                            <div className="text-xs text-gray-500">每行一个邮箱，或 <span className="font-mono">邮箱----密码----at</span> 格式（取第一段邮箱匹配数据库账号，走浏览器登录重新获取 at）。</div>
                            <textarea value={refreshAtInput} onChange={(e) => setRefreshAtInput(e.target.value)} placeholder={"a@mail.com\nb@mail.com----pass----oldAt"} disabled={refreshAtRunning}
                                      className="w-full h-24 px-2 py-1.5 border rounded text-xs font-mono resize-y disabled:bg-gray-50"/>
                            <div className="flex items-center gap-3">
                                <button onClick={async () => {
                                    const sep = "----";
                                    const lines = refreshAtInput.split("\n").map(l => l.trim()).filter(Boolean);
                                    const emails = lines.map(l => l.split(sep)[0].trim().toLowerCase()).filter(Boolean);
                                    if (!emails.length) { notify("请粘贴邮箱列表"); return; }
                                    setRefreshAtRunning(true);
                                    setRefreshAtResults(emails.map(e => ({email: e, ok: false, status: "pending" as const})));
                                    try {
                                        await api.batchRefreshAt(refreshAtInput);
                                    } catch (e: any) { notify("请求失败: " + e.message); setRefreshAtRunning(false); }
                                }} disabled={refreshAtRunning} className={`px-4 py-1.5 rounded text-sm font-medium text-white ${refreshAtRunning ? "bg-gray-400 cursor-not-allowed" : "bg-cyan-600 hover:bg-cyan-700"}`}>
                                    {refreshAtRunning ? "获取中(浏览器登录)…" : "▶ 开始获取"}
                                </button>
                                {refreshAtRunning && <button onClick={() => { api.stopBatchRefreshAt(); setRefreshAtRunning(false); }} className="px-3 py-1.5 rounded text-sm font-medium text-white bg-red-500 hover:bg-red-600">⏹ 停止</button>}
                                {refreshAtResults.length > 0 && <span className="text-xs text-gray-500">成功 {refreshAtResults.filter(r => r.ok).length}/{refreshAtResults.length}</span>}
                            </div>
                            {refreshAtResults.length > 0 && (
                                <>
                                    <div className="max-h-52 overflow-auto border rounded">
                                        <table className="w-full text-xs">
                                            <thead className="bg-gray-100 text-gray-500 sticky top-0"><tr><th className="text-left px-2 py-1 w-8">#</th><th className="text-left px-2 py-1">邮箱</th><th className="text-left px-2 py-1">结果</th></tr></thead>
                                            <tbody>
                                                {refreshAtResults.map((r, i) => (
                                                    <tr key={i} className="border-t">
                                                        <td className="px-2 py-1 text-gray-400">{i + 1}</td>
                                                        <td className="px-2 py-1 font-mono">{r.email}</td>
                                                        <td className="px-2 py-1">{r.status === "pending" ? <span className="text-gray-400">未开始</span> : r.status === "running" ? <span className="text-amber-600">进行中 {r.reason || ""}</span> : r.ok ? <span className="text-green-600">✅ {r.reason}</span> : <span className="text-red-500">❌ {r.reason}</span>}</td>
                                                    </tr>
                                                ))}
                                            </tbody>
                                        </table>
                                    </div>
                                    <div>
                                        <div className="flex items-center gap-2 mb-1">
                                            <span className="text-xs text-gray-500">成功项（邮箱----密码----accessToken，点击全选复制）:</span>
                                            <button onClick={() => {
                                                const ok = refreshAtResults.filter(r => r.ok);
                                                if (!ok.length) { notify("无成功项可导出"); return; }
                                                const esc = (v: string) => `"${String(v ?? "").replace(/"/g, '""')}"`;
                                                const head = "﻿邮箱,密码,SessionJSON\n";
                                                const body = ok.map(r => [esc(r.email), esc(r.password || ""), esc(r.sessionJson ? JSON.stringify(r.sessionJson) : "")].join(",")).join("\n");
                                                const blob = new Blob([head + body], {type: "text/csv;charset=utf-8"});
                                                const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = "batch-at-session.csv"; a.click(); URL.revokeObjectURL(a.href);
                                                notify(`已导出 ${ok.length} 条`);
                                            }} disabled={!refreshAtResults.some(r => r.ok)} className="px-2 py-0.5 rounded text-xs border border-green-300 text-green-700 hover:bg-green-50 disabled:opacity-40 disabled:cursor-not-allowed">
                                                📊 导出Excel(邮箱+密码+SessionJSON)
                                            </button>
                                        </div>
                                        <textarea readOnly value={(() => {
                                            const sep = "----";
                                            const lines = refreshAtInput.split("\n").map(l => l.trim()).filter(Boolean);
                                            return refreshAtResults.map((r, i) => {
                                                if (!r.ok || !r.accessToken) return null;
                                                const origParts = (lines[i] || "").split(sep);
                                                if (origParts.length >= 3) { origParts[2] = r.accessToken; if (r.password && !origParts[1]) origParts[1] = r.password; return origParts.join(sep); }
                                                return `${r.email}${sep}${r.password || ""}${sep}${r.accessToken}`;
                                            }).filter(Boolean).join("\n");
                                        })()} onClick={(e) => (e.target as HTMLTextAreaElement).select()} className="w-full h-20 px-2 py-1 border rounded text-xs font-mono bg-gray-50 select-text"/>
                                    </div>
                                </>
                            )}
                        </div>
                    </div>
                </div>
            )}
            {showAcquireRt && (
                <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-30" onClick={() => !acquireRtRunning && setShowAcquireRt(false)}>
                    <div className="bg-white rounded-xl w-[700px] max-h-[85vh] flex flex-col shadow-2xl" onClick={(e) => e.stopPropagation()}>
                        <div className="px-5 py-3 border-b flex items-center justify-between">
                            <span className="font-medium">🔑 批量获取 RefreshToken <span className="text-xs text-gray-400 font-normal">走 OAuth 登录获取全新 rt（Pro号无需接码）</span></span>
                            <button onClick={() => !acquireRtRunning && setShowAcquireRt(false)} disabled={acquireRtRunning} className="text-gray-400 hover:text-gray-700 text-lg leading-none disabled:opacity-40">✕</button>
                        </div>
                        <div className="px-5 py-4 space-y-3 text-sm overflow-auto">
                            <div className="text-xs text-gray-500">每行 <span className="font-mono">邮箱----密码</span> 或 <span className="font-mono">邮箱:密码</span>，走 codex OAuth 登录获取 refresh_token。</div>
                            <textarea value={acquireRtInput} onChange={(e) => setAcquireRtInput(e.target.value)} placeholder={"a@mail.com----password1\nb@mail.com:password2"} disabled={acquireRtRunning}
                                      className="w-full h-24 px-2 py-1.5 border rounded text-xs font-mono resize-y disabled:bg-gray-50"/>
                            <div className="flex items-center gap-3">
                                <button onClick={async () => {
                                    const lines = acquireRtInput.split("\n").map(l => l.trim()).filter(Boolean);
                                    const emails = lines.map(l => l.split(/----| |\t|:|;|,|\|/)[0].trim().toLowerCase()).filter(Boolean);
                                    if (!emails.length) { notify("请粘贴邮箱----密码列表"); return; }
                                    setAcquireRtRunning(true);
                                    setAcquireRtResults(emails.map((e, i) => ({email: e, ok: false, status: i === 0 ? "running" as const : "pending" as const, reason: i === 0 ? "已提交，正在登录…" : ""})));
                                    try { await api.batchAcquireRt(acquireRtInput); } catch (e: any) { notify("请求失败: " + e.message); setAcquireRtRunning(false); }
                                }} disabled={acquireRtRunning} className={`px-4 py-1.5 rounded text-sm font-medium text-white ${acquireRtRunning ? "bg-gray-400 cursor-not-allowed" : "bg-amber-600 hover:bg-amber-700"}`}>
                                    {acquireRtRunning ? "获取中(OAuth登录)…" : "▶ 开始获取"}
                                </button>
                                {acquireRtRunning && <button onClick={() => { api.stopBatchAcquireRt(); setAcquireRtRunning(false); }} className="px-3 py-1.5 rounded text-sm font-medium text-white bg-red-500 hover:bg-red-600">⏹ 停止</button>}
                                {acquireRtResults.length > 0 && <span className="text-xs text-gray-500">成功 {acquireRtResults.filter(r => r.ok).length}/{acquireRtResults.length}</span>}
                            </div>
                            {acquireRtResults.length > 0 && (
                                <>
                                    <div className="max-h-52 overflow-auto border rounded">
                                        <table className="w-full text-xs">
                                            <thead className="bg-gray-100 text-gray-500 sticky top-0"><tr><th className="text-left px-2 py-1 w-8">#</th><th className="text-left px-2 py-1">邮箱</th><th className="text-left px-2 py-1">结果</th></tr></thead>
                                            <tbody>
                                                {acquireRtResults.map((r, i) => (
                                                    <tr key={i} className="border-t">
                                                        <td className="px-2 py-1 text-gray-400">{i + 1}</td>
                                                        <td className="px-2 py-1 font-mono">{r.email}</td>
                                                        <td className="px-2 py-1">{r.status === "pending" ? <span className="text-gray-400">未开始</span> : r.status === "running" ? <span className="text-amber-600">进行中 {r.reason || ""}</span> : r.ok ? <span className="text-green-600">✅ {r.reason}</span> : <span className="text-red-500">❌ {r.reason}</span>}</td>
                                                    </tr>
                                                ))}
                                            </tbody>
                                        </table>
                                    </div>
                                    <div>
                                        <div className="flex items-center gap-2 mb-1">
                                            <span className="text-xs text-gray-500">成功项（邮箱----密码----rt，点击全选复制）:</span>
                                            <button onClick={() => {
                                                const ok = acquireRtResults.filter(r => r.ok && r.rt);
                                                if (!ok.length) { notify("无成功项可导出"); return; }
                                                const data = ok.map(r => ({email: r.email, password: r.password || "", refresh_token: r.rt || "", access_token: r.accessToken || ""}));
                                                const blob = new Blob([JSON.stringify(data, null, 2)], {type: "application/json;charset=utf-8"});
                                                const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = "batch-rt-sub2json.json"; a.click(); URL.revokeObjectURL(a.href);
                                                notify(`已导出 ${ok.length} 条 sub2json`);
                                            }} disabled={!acquireRtResults.some(r => r.ok)} className="px-2 py-0.5 rounded text-xs border border-amber-300 text-amber-700 hover:bg-amber-50 disabled:opacity-40 disabled:cursor-not-allowed">
                                                📦 导出 sub2json
                                            </button>
                                        </div>
                                        <textarea readOnly value={acquireRtResults.filter(r => r.ok && r.rt).map(r => `${r.email}----${r.password || ""}----${r.rt}`).join("\n")}
                                                  onClick={(e) => (e.target as HTMLTextAreaElement).select()} className="w-full h-20 px-2 py-1 border rounded text-xs font-mono bg-gray-50 select-text"/>
                                    </div>
                                </>
                            )}
                        </div>
                    </div>
                </div>
            )}
            {showPicker && (
                <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-30" onClick={() => setShowPicker(false)}>
                    <div className="bg-white rounded-xl w-[560px] max-h-[80vh] flex flex-col shadow-2xl" onClick={(e) => e.stopPropagation()}>
                        <div className="px-5 py-3 border-b flex items-center justify-between">
                            <span className="font-medium">📥 从邮箱选号分配到 GPT</span>
                            <button onClick={() => setShowPicker(false)} className="text-gray-400 hover:text-gray-700 text-lg leading-none">✕</button>
                        </div>
                        <div className="px-5 py-3 space-y-3 text-sm overflow-hidden flex flex-col min-h-0">
                            {/* 分组筛选 + 批次 */}
                            <div className="flex items-center gap-2">
                                <span className="w-14 text-gray-400 shrink-0">分组</span>
                                <select value={pickerGrp} onChange={(e) => setPickerGrp(e.target.value)} className="flex-1 px-2 py-1.5 border rounded">
                                    <option value="">全部待分配({pickerList.length})</option>
                                    <option value="__NONE__">未分组</option>
                                    {pickerGrps.filter((g) => g.grp).map((g) => <option key={g.grp} value={g.grp}>{g.grp}({g.n})</option>)}
                                </select>
                                <select value={pickerPw} onChange={(e) => setPickerPw(e.target.value)} className="px-2 py-1.5 border rounded">
                                    <option value="">改密:全部</option>
                                    <option value="no">未改密</option>
                                    <option value="yes">已改密</option>
                                    <option value="fail">改密失败</option>
                                </select>
                            </div>
                            <div className="flex items-center gap-2">
                                <span className="w-14 text-gray-400 shrink-0">批次</span>
                                <input value={pickerBatch} onChange={(e) => setPickerBatch(e.target.value)} placeholder="分配批次名(选填,便于后续筛选/导出)" list="batch-list" className="flex-1 px-2 py-1.5 border rounded"/>
                            </div>
                            {/* 邮箱勾选列表 */}
                            <div className="flex items-center justify-between text-xs text-gray-500">
                                <label className="inline-flex items-center gap-1 cursor-pointer">
                                    <input type="checkbox" checked={pickerVisible.length > 0 && pickerVisible.every((m) => pickerSel.has(m.id))}
                                           onChange={(e) => setPickerSel((prev) => { const s = new Set(prev); pickerVisible.forEach((m) => e.target.checked ? s.add(m.id) : s.delete(m.id)); return s; })}/>
                                    全选当前({pickerVisible.length})
                                </label>
                                <span>已勾选 <b className="text-emerald-600">{pickerSel.size}</b> 个</span>
                            </div>
                            <div className="border rounded overflow-auto min-h-[120px] max-h-[38vh]">
                                {pickerLoading ? <div className="p-4 text-center text-gray-400">加载中…</div>
                                    : pickerVisible.length === 0 ? <div className="p-4 text-center text-gray-400">没有待分配邮箱</div>
                                    : pickerVisible.map((m) => (
                                        <label key={m.id} className="flex items-center gap-2 px-3 py-1.5 border-b last:border-0 hover:bg-gray-50 cursor-pointer">
                                            <input type="checkbox" checked={pickerSel.has(m.id)} onChange={() => setPickerSel((prev) => { const s = new Set(prev); s.has(m.id) ? s.delete(m.id) : s.add(m.id); return s; })}/>
                                            <span className="font-mono text-gray-700 flex-1 truncate">{m.email}</span>
                                            {m.grp ? <span className="text-xs px-1 rounded bg-gray-100 text-gray-500">{m.grp}</span> : null}
                                            {String(m.pw_status || "").includes("✅") ? <span className="text-xs text-green-600" title={m.pw_status}>已改密</span> : null}
                                        </label>
                                    ))}
                            </div>
                            {/* 先改密开关 */}
                            <label className="flex items-center gap-2 cursor-pointer text-amber-700">
                                <input type="checkbox" checked={pickerChangePw} onChange={(e) => setPickerChangePw(e.target.checked)}/>
                                先改密再分配<span className="text-xs text-gray-400">(串行改 mail.com 密码后进注册队列;改密失败的仍照常分配)</span>
                            </label>
                        </div>
                        <div className="px-5 py-3 border-t flex items-center gap-2">
                            <span className="text-sm text-gray-500 mr-auto">将分配 <b className={pickerSel.size ? "text-emerald-600" : "text-red-500"}>{pickerSel.size}</b> 个进 GPT 注册队列</span>
                            <button onClick={() => setShowPicker(false)} className="px-4 py-1.5 bg-gray-200 hover:bg-gray-300 rounded text-sm">取消</button>
                            <button onClick={doPickAllocate} className="px-4 py-1.5 bg-emerald-600 hover:bg-emerald-700 text-white rounded text-sm">{pickerChangePw ? "🔑 改密并分配" : "→ 分配"}</button>
                        </div>
                    </div>
                </div>
            )}
            </>)}
            {toast && <div className="fixed bottom-6 left-1/2 -translate-x-1/2 bg-gray-900 text-white px-5 py-2.5 rounded-lg shadow-lg text-sm">{toast}</div>}
        </div>
    );
}
