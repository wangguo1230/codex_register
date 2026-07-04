import React, {useEffect, useMemo, useRef, useState} from "react";
import {api, connectStream, type Account, type Stats, type Daily, type XrayStatus} from "./api";
import {MailboxPanel} from "./MailboxPanel";
import {ClaudePanel} from "./ClaudePanel";

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
// 存活天数：账号确认死亡(deadAt)后定格 = 死亡时间 - 注册时间；否则 = 现在 - 注册时间
function aliveDays(ts?: number | null, deadAt?: number | null): string {
    if (!ts) return "—";
    const end = deadAt ? deadAt : Date.now();
    return Math.max(0, Math.floor((end - ts) / 86400000)) + "天";
}
// 数字版存活天数(用于过期/正常筛选)
function aliveDaysNum(ts?: number | null, deadAt?: number | null): number {
    if (!ts) return 0;
    const end = deadAt ? deadAt : Date.now();
    return Math.max(0, Math.floor((end - ts) / 86400000));
}
// 注册耗时:完成 - 开始(started_at→finished_at),显示 X分X秒
function fmtDuration(startAt?: number | null, endAt?: number | null): string {
    if (!startAt || !endAt || endAt < startAt) return "—";
    const s = Math.round((endAt - startAt) / 1000);
    return s < 60 ? `${s}秒` : `${Math.floor(s / 60)}分${pad(s % 60)}秒`;
}
// 前端生成随机密码:20位 大写(去OI)+小写(去l)+数字(去01),保证各类≥1
export default function App() {
    const [accounts, setAccounts] = useState<Account[]>([]);
    const [stats, setStats] = useState<Stats>({pending: 0, running: 0, success: 0, failed: 0, total: 0});
    const [paused, setPaused] = useState(true);
    const [concurrency, setConcurrency] = useState(2);
    const [regEngine, setRegEngine] = useState<string>("http");
    const [expDays, setExpDays] = useState(10); // 过期阈值:注册满 N 天视为过期(网页 token 约 10 天)
    const [otpSingle, setOtpSingle] = useState(true);
    const [chatSim, setChatSim] = useState(true);
    const [regProxy, setRegProxy] = useState("");
    const [mailProxy, setMailProxy] = useState("");
    const [showProxy, setShowProxy] = useState(false);
    const [showSms, setShowSms] = useState(false);
    const [smsText, setSmsText] = useState("");
    const [smsData, setSmsData] = useState<{list: any[]; stats: {free: number; used: number; bad: number; claimed: number; total: number}}>({list: [], stats: {free: 0, used: 0, bad: 0, claimed: 0, total: 0}});
    const [smsEnabled, setSmsEnabled] = useState(true);
    const [rtEnabled, setRtEnabled] = useState(false);
    const [bitBrowser, setBitBrowser] = useState(false); // 比特浏览器:每号独立指纹窗口
    const [daily, setDaily] = useState<Daily | null>(null);
    const [showDaily, setShowDaily] = useState(false);
    const [xray, setXray] = useState<XrayStatus | null>(null);
    const [showXray, setShowXray] = useState(false);
    const [vlessInput, setVlessInput] = useState("");
    const [smsLinkTemplate, setSmsLinkTemplate] = useState("");
    const [smsMaxBind, setSmsMaxBind] = useState(3);
    const [batchFilter, setBatchFilter] = useState(""); // 按批次筛选("" =全部)
    const [batches, setBatches] = useState<{name: string; count: number}[]>([]);
    const [showExport, setShowExport] = useState(false); // 高级导出弹窗
    const [exportScope, setExportScope] = useState<"all" | "hasRt" | "atOnly">("all");
    const [exportFormat, setExportFormat] = useState<"txt" | "csv">("txt");
    const [exportBatch, setExportBatch] = useState(""); // 导出选的批次("" =全部)
    const [batchAssign, setBatchAssign] = useState(""); // 批量设置批次的输入
    const [exportMarkSold, setExportMarkSold] = useState(false); // 高级导出时是否标记已售出
    // 邮箱密码校验工具已迁至邮箱管理域(web/src/MailCheckTool.tsx,由 MailboxPanel 挂载)
    const [filter, setFilter] = useState<string>("all");
    const [search, setSearch] = useState(""); // 邮箱名搜索
    const [selectedId, setSelectedId] = useState<number | null>(null);
    const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
    const toggleSel = (id: number) => setSelectedIds((prev) => { const s = new Set(prev); s.has(id) ? s.delete(id) : s.add(id); return s; });
    const [logs, setLogs] = useState<{ts: number; line: string}[]>([]);
    const [allLogs, setAllLogs] = useState<{id: number; email: string; ts: number; line: string}[]>([]);
    const [logMode, setLogMode] = useState<"all" | "single">("all");
    const [detailTab, setDetailTab] = useState<"log" | "inbox">("log"); // 详情抽屉内 tab：日志/收件箱
    const [panelOpen, setPanelOpen] = useState(true); // 右侧抽屉是否展开(收起则表格占满)
    const [domain, setDomain] = useState<"gpt" | "mailbox" | "claude">("gpt"); // 顶层业务域:GPT注册 / 邮箱管理 / Claude注册(三域隔离)
    const [dark, setDark] = useState<boolean>(() => (localStorage.getItem("theme") ?? "dark") === "dark"); // 默认暗色
    useEffect(() => { document.documentElement.classList.toggle("dark", dark); localStorage.setItem("theme", dark ? "dark" : "light"); }, [dark]);
    const [editMode, setEditMode] = useState(false); // 详情抽屉是否处于编辑记录态
    const [editForm, setEditForm] = useState<Record<string, any>>({});
    const [infoOpen, setInfoOpen] = useState(true); // 详情抽屉的账户信息区是否展开(收起给日志/收件箱更多空间)
    const [batchAt, setBatchAt] = useState<{running: boolean; done: number; total: number}>({running: false, done: 0, total: 0});
    // 虚拟滚动:大数据量只渲染可视区行(固定行高),避免几千行 DOM 卡顿
    const scrollRef = useRef<HTMLDivElement>(null);
    const [scrollTop, setScrollTop] = useState(0);
    const [viewH, setViewH] = useState(600);
    const [toast, setToast] = useState("");
    const [inboxAccount, setInboxAccount] = useState<Account | null>(null);
    const [inboxData, setInboxData] = useState<{email: string; mails: any[]} | null>(null);
    const [inboxLoading, setInboxLoading] = useState(false);
    const [inboxError, setInboxError] = useState("");
    const [expandedMail, setExpandedMail] = useState<string | null>(null);
    const [mailBodies, setMailBodies] = useState<Record<string, string>>({});
    const [mailLoadingId, setMailLoadingId] = useState<string | null>(null);
    const logEndRef = useRef<HTMLDivElement>(null);
    const selectedIdRef = useRef<number | null>(null);
    selectedIdRef.current = selectedId;
    const accountsRef = useRef<Account[]>([]);
    accountsRef.current = accounts;

    const notify = (m: string) => { setToast(m); setTimeout(() => setToast(""), 2600); };

    // 初次加载 + SSE
    useEffect(() => {
        api.state().then((s) => { setPaused(s.state.paused); setConcurrency(s.state.concurrency); setOtpSingle(s.state.otpSingle); setChatSim(s.state.simulateChat); setSmsEnabled(s.state.smsEnabled); setRtEnabled(s.state.rtEnabled); setDaily(s.state.daily); setXray(s.state.xray); setRegEngine(s.state.regEngine || "http"); setBitBrowser(!!s.state.bitBrowser); setSmsLinkTemplate(s.state.smsLinkTemplate || ""); setSmsMaxBind(s.state.smsMaxBind ?? 3); setRegProxy(s.state.regProxy || ""); setMailProxy(s.state.mailProxy || ""); setStats(s.stats); }).catch(() => {});
        api.listAccounts().then(setAccounts).catch(() => {});
        // 批次数据来自数据库(筛选/导出用;导入已迁至邮箱管理)
        api.batches().then(setBatches).catch(() => {});
        api.listSms().then(setSmsData).catch(() => {});

        const disconnect = connectStream((event, data) => {
            if (event === "sms") { api.listSms().then(setSmsData).catch(() => {}); return; }
            if (event === "daily") { setDaily(data); return; }
            if (event === "batchAt") { setBatchAt(data); if (!data.running) api.listAccounts().then(setAccounts).catch(() => {}); return; }
            if (event === "batchPw") { api.listAccounts().then(setAccounts).catch(() => {}); return; } // 邮箱改密在邮箱管理页;这里仅刷新账号让 gpt 邮箱密码同步
            if (event === "stats") setStats(data);
            else if (event === "snapshot") setAccounts(data);
            else if (event === "hello") { setStats(data.stats); setPaused(data.state.paused); setConcurrency(data.state.concurrency); setOtpSingle(data.state.otpSingle); setChatSim(data.state.simulateChat); setRegProxy(data.state.regProxy || ""); setMailProxy(data.state.mailProxy || ""); api.listAccounts().then(setAccounts).catch(() => {}); }
            else if (event === "status") {
                setAccounts((prev) => prev.map((a) => (a.id === data.id ? {...a, ...data, status: data.status} : a)));
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

    // 选中账号 → 拉历史日志
    useEffect(() => {
        if (selectedId == null) { setLogs([]); return; }
        api.logs(selectedId).then((rows) => setLogs(rows.map((r) => ({ts: r.ts, line: r.line})))).catch(() => setLogs([]));
    }, [selectedId]);

    useEffect(() => { logEndRef.current?.scrollIntoView({behavior: "smooth"}); }, [logs, allLogs, logMode]);
    // 测量表格滚动容器高度(用于虚拟滚动可视区计算)
    useEffect(() => {
        const el = scrollRef.current; if (!el) return;
        const measure = () => setViewH(el.clientHeight);
        measure();
        const ro = new ResizeObserver(measure); ro.observe(el);
        return () => ro.disconnect();
    }, []);

    // 过期判定:成功注册且【注册满 expDays 天】(存活天数≥阈值,dead_at 优先定格)。正常=成功且未到阈值。
    const isExpired = (a: Account) => a.status === "success" && aliveDaysNum(a.finished_at, a.dead_at) >= expDays;
    const filtered = useMemo(() => {
        const base = (() => {
            if (filter === "all") return accounts;
            if (filter === "hasRt") return accounts.filter((a) => a.rt_file);              // 带 rt(可续期)
            if (filter === "atOnly") return accounts.filter((a) => a.status === "success" && !a.rt_file); // 只有 at(无 rt)
            if (filter === "sold") return accounts.filter((a) => a.sold_at);               // 已售出
            if (filter === "noPw") return accounts.filter((a) => a.status === "success" && !String(a.pw_status || "").includes("✅")); // 未改过密码
            if (filter === "pwFail") return accounts.filter((a) => String(a.pw_status || "").includes("❌")); // 改密失败
        if (filter === "deactivated") return accounts.filter((a) => /account_deactivated/i.test(a.error || "")); // 账号被停用(死号)
        if (filter === "atFail") return accounts.filter((a) => a.status === "success" && /❌/.test(a.at_status || "")); // at 测试失效
        if (filter === "atOk") return accounts.filter((a) => /✅/.test(a.at_status || "")); // at 测试有效
            if (filter === "expired") return accounts.filter(isExpired);                   // 过期(注册满阈值天)
            if (filter === "normal") return accounts.filter((a) => a.status === "success" && !isExpired(a)); // 正常(成功且未过期)
            return accounts.filter((a) => a.status === filter);
        })();
        const q = search.trim().toLowerCase();
        let list = q ? base.filter((a) => a.email.toLowerCase().includes(q)) : base; // 邮箱名搜索(在筛选结果上再过滤)
        if (batchFilter) list = list.filter((a) => (a.batch || "") === batchFilter); // 批次筛选
        return list;
    }, [accounts, filter, expDays, search, batchFilter]);
    // 带rt/只有at/已售出/过期/正常 计数(stats 只有 status 维度，这些前端算)
    const tokenCnt = useMemo(() => ({
        hasRt: accounts.filter((a) => a.rt_file).length,
        atOnly: accounts.filter((a) => a.status === "success" && !a.rt_file).length,
        sold: accounts.filter((a) => a.sold_at).length,
        noPw: accounts.filter((a) => a.status === "success" && !String(a.pw_status || "").includes("✅")).length,
        pwFail: accounts.filter((a) => String(a.pw_status || "").includes("❌")).length,
        deactivated: accounts.filter((a) => /account_deactivated/i.test(a.error || "")).length,
        atFail: accounts.filter((a) => a.status === "success" && /❌/.test(a.at_status || "")).length,
        atOk: accounts.filter((a) => /✅/.test(a.at_status || "")).length,
        expired: accounts.filter(isExpired).length,
        normal: accounts.filter((a) => a.status === "success" && !isExpired(a)).length,
    }), [accounts, expDays]);
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
    const selected = accounts.find((a) => a.id === selectedId) || null;
    // 虚拟滚动可视区:只渲染 [vStart, vEnd) 行,上下用占位撑起总高度
    const ROW_H = 41;
    const vTotal = filtered.length;
    const vStart = Math.max(0, Math.floor(scrollTop / ROW_H) - 8);
    const vEnd = Math.min(vTotal, Math.ceil((scrollTop + viewH) / ROW_H) + 8);
    const vRows = filtered.slice(vStart, vEnd);
    const vTopPad = vStart * ROW_H;
    const vBotPad = Math.max(0, (vTotal - vEnd) * ROW_H);

    async function openInbox(a: Account) {
        setInboxAccount(a); setInboxData(null); setInboxError(""); setInboxLoading(true); setExpandedMail(null); setMailBodies({});
        try { setInboxData(await api.inbox(a.id)); }
        catch (e: any) { setInboxError(e.message); }
        finally { setInboxLoading(false); }
    }

    // 切到「收件箱」tab 且当前详情号尚未加载 → 自动拉取
    useEffect(() => {
        if (detailTab === "inbox" && selected && inboxAccount?.id !== selected.id && !inboxLoading) openInbox(selected);
    }, [detailTab, selectedId]);

    // 进入编辑记录态:把当前号字段拷进表单
    function startEdit(a: Account) {
        setEditForm({
            email: a.email, password: a.password, status: a.status, plan: a.plan || "",
            phone: a.phone || "", card: a.card || "", at_status: a.at_status || "",
            rt_status: a.rt_status || "", chat_status: a.chat_status || "", error: a.error || "",
            batch: a.batch || "", dead: !!a.dead_at, sold: !!a.sold_at,
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

    // 打开自定义改密弹窗(替代 window.prompt/confirm)
    // 邮箱改密已迁至邮箱管理域(单个/批量改密都在 MailboxPanel 操作,GPT 只做注册)

    function toggleMail(mailId: string) {
        if (expandedMail === mailId) { setExpandedMail(null); return; }
        setExpandedMail(mailId);
        if (mailBodies[mailId] === undefined && inboxAccount) {
            setMailLoadingId(mailId);
            api.mailBody(inboxAccount.id, mailId)
                .then((r) => setMailBodies((p) => ({...p, [mailId]: r.body || "(无正文)"})))
                .catch((e: any) => setMailBodies((p) => ({...p, [mailId]: "加载失败: " + e.message})))
                .finally(() => setMailLoadingId(null));
        }
    }

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

    async function doExportFull() {
        if (exportMarkSold && !window.confirm("导出并把这批号标记为【已售出】？")) return;
        try {
            const res = await fetch(api.exportFullUrl({format: exportFormat, scope: exportScope, batch: exportBatch || undefined, markSold: exportMarkSold}));
            if (!res.ok) throw new Error(await res.text());
            const text = await res.text();
            const blob = new Blob([text], {type: exportFormat === "csv" ? "text/csv;charset=utf-8" : "text/plain;charset=utf-8"});
            const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = `export.${exportFormat}`; a.click(); URL.revokeObjectURL(a.href);
            if (exportMarkSold) await api.listAccounts().then(setAccounts);
            notify(`已导出${exportMarkSold ? "并标记已售出" : ""}`);
            setShowExport(false);
        } catch (e: any) { notify("导出失败: " + e.message); }
    }
    async function setBatchForSelected() {
        const ids = selectedIds.size ? [...selectedIds] : filtered.map((a) => a.id);
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

    const StatBadge = ({label, n, color, active, onClick}: any) => (
        <button onClick={onClick}
                className={`px-3 py-1.5 rounded-lg text-sm font-medium border transition ${active ? "ring-2 ring-offset-1 " + color : color} `}>
            {label} <span className="font-bold">{n}</span>
        </button>
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
                <DomainTab active={domain === "mailbox"} onClick={() => setDomain("mailbox")}>📮 邮箱管理</DomainTab>
                <DomainTab active={domain === "claude"} onClick={() => setDomain("claude")}>🧠 Claude 注册</DomainTab>
            </nav>
            {domain === "mailbox" && <MailboxPanel notify={notify}/>}
            {domain === "claude" && <ClaudePanel notify={notify}/>}
            {domain === "gpt" && (<>
            {/* 顶栏 */}
            <header className="bg-white border-b px-6 py-3 flex items-center gap-4 flex-wrap shadow-sm">
                <h1 className="text-lg font-bold">⚡ GPT 批量注册控制台</h1>
                <div className="flex gap-2">
                    <StatBadge label="全部" n={stats.total} color="bg-gray-100 text-gray-700 border-gray-200" active={filter === "all"} onClick={() => setFilter("all")}/>
                    <StatBadge label="等待" n={stats.pending} color="bg-gray-100 text-gray-600 border-gray-200" active={filter === "pending"} onClick={() => setFilter("pending")}/>
                    <StatBadge label="运行" n={stats.running} color="bg-blue-50 text-blue-700 border-blue-200" active={filter === "running"} onClick={() => setFilter("running")}/>
                    <StatBadge label="成功" n={stats.success} color="bg-green-50 text-green-700 border-green-200" active={filter === "success"} onClick={() => setFilter("success")}/>
                    <StatBadge label="失败" n={stats.failed} color="bg-red-50 text-red-700 border-red-200" active={filter === "failed"} onClick={() => setFilter("failed")}/>
                    <StatBadge label="带rt" n={tokenCnt.hasRt} color="bg-teal-50 text-teal-700 border-teal-200" active={filter === "hasRt"} onClick={() => setFilter("hasRt")}/>
                    <StatBadge label="只有at" n={tokenCnt.atOnly} color="bg-sky-50 text-sky-700 border-sky-200" active={filter === "atOnly"} onClick={() => setFilter("atOnly")}/>
                    <StatBadge label="已售出" n={tokenCnt.sold} color="bg-amber-50 text-amber-700 border-amber-200" active={filter === "sold"} onClick={() => setFilter("sold")}/>
                    <StatBadge label="未改密" n={tokenCnt.noPw} color="bg-rose-50 text-rose-700 border-rose-200" active={filter === "noPw"} onClick={() => setFilter("noPw")}/>
                    {tokenCnt.pwFail > 0 && <StatBadge label="改密失败" n={tokenCnt.pwFail} color="bg-red-50 text-red-700 border-red-200" active={filter === "pwFail"} onClick={() => setFilter("pwFail")}/>}
                    {tokenCnt.deactivated > 0 && <StatBadge label="已停用" n={tokenCnt.deactivated} color="bg-gray-200 text-gray-600 border-gray-300" active={filter === "deactivated"} onClick={() => setFilter("deactivated")}/>}
                    {tokenCnt.atFail > 0 && <StatBadge label="at失效" n={tokenCnt.atFail} color="bg-red-50 text-red-700 border-red-200" active={filter === "atFail"} onClick={() => setFilter("atFail")}/>}
                    {tokenCnt.atOk > 0 && <StatBadge label="at有效" n={tokenCnt.atOk} color="bg-green-50 text-green-700 border-green-200" active={filter === "atOk"} onClick={() => setFilter("atOk")}/>}
                    <StatBadge label="正常" n={tokenCnt.normal} color="bg-green-50 text-green-700 border-green-200" active={filter === "normal"} onClick={() => setFilter("normal")}/>
                    <StatBadge label="过期" n={tokenCnt.expired} color="bg-orange-50 text-orange-700 border-orange-200" active={filter === "expired"} onClick={() => setFilter("expired")}/>
                    <label className="inline-flex items-center gap-1 text-xs text-gray-500" title="注册满 N 天视为过期(网页 token 约 10 天;有 rt 的可续期)">
                        满<input type="number" min={1} value={expDays} onChange={(e) => setExpDays(Math.max(1, Number(e.target.value) || 1))} className="w-12 px-1 py-0.5 border rounded"/>天
                    </label>
                    <div className="relative">
                        <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="🔍 搜索邮箱名"
                               className="w-44 pl-2 pr-6 py-1 border rounded-lg text-sm"/>
                        {search && <button onClick={() => setSearch("")} title="清除" className="absolute right-1.5 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600 text-sm">✕</button>}
                    </div>
                    {batches.length > 0 &&
                        <select value={batchFilter} onChange={(e) => setBatchFilter(e.target.value)} title="按批次筛选" className="px-2 py-1 border rounded-lg text-sm">
                            <option value="">全部批次</option>
                            {batches.map((b) => <option key={b.name} value={b.name}>{b.name} ({b.count})</option>)}
                        </select>}
                    {batchStats &&
                        <span className="text-xs px-2 py-1 rounded bg-slate-100 text-slate-700 whitespace-nowrap" title="该批次:成功/失败/进行中 + 成功率(成功占已完成的比例)">
                            共{batchStats.total} · <b className="text-green-600">成{batchStats.success}</b> <b className="text-red-500">败{batchStats.failed}</b>{batchStats.busy > 0 ? ` ⏳${batchStats.busy}` : ""}{batchStats.dead > 0 ? ` 停用${batchStats.dead}` : ""} · 成功率<b>{batchStats.rate}%</b>
                        </span>}
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
                    {paused
                        ? <button onClick={start} className="px-4 py-1.5 bg-green-600 text-white rounded-lg text-sm font-medium hover:bg-green-700">▶ 开始</button>
                        : <button onClick={pause} className="px-4 py-1.5 bg-amber-500 text-white rounded-lg text-sm font-medium hover:bg-amber-600">⏸ 暂停</button>}
                    <button onClick={ctrl(api.stop, "已停止全部运行中任务")} className="px-3 py-1.5 bg-red-500 text-white rounded-lg text-sm hover:bg-red-600">⏹ 停止</button>
                    <button onClick={ctrl(api.retryFailed, "已把失败项重置为等待")} className="px-3 py-1.5 bg-gray-200 rounded-lg text-sm hover:bg-gray-300">↻ 重试失败</button>
                    <button onClick={() => { setShowProxy(true); notify("代理设置已在下方展开"); }} className="px-3 py-1.5 bg-gray-200 rounded-lg text-sm hover:bg-gray-300">⚙ 代理</button>
                    <div className="relative group">
                        <button className="px-3 py-1.5 bg-indigo-600 text-white rounded-lg text-sm hover:bg-indigo-700">⬇ 下载</button>
                        <div className="absolute right-0 mt-1 hidden group-hover:block bg-white border rounded-lg shadow-lg z-10 w-64">
                            <button onClick={() => { setExportBatch(batchFilter); setShowExport(true); }} className="block w-full text-left px-3 py-2 text-sm hover:bg-gray-100 font-medium text-emerald-700">⚙ 按批次/格式导出…</button>
                            <a href={api.exportUrl("txt")} className="block px-3 py-2 text-sm hover:bg-gray-100 font-medium text-indigo-700">TXT(邮箱----密码----rt----at)</a>
                            <a href={api.exportUrl("jsonl")} className="block px-3 py-2 text-sm hover:bg-gray-100">JSONL(含 session)</a>
                            <a href={api.exportUrl("csv")} className="block px-3 py-2 text-sm hover:bg-gray-100">CSV(含 session)</a>
                        </div>
                    </div>
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
                        <div className="flex gap-2 items-start flex-wrap">
                            <textarea value={vlessInput} onChange={(e) => setVlessInput(e.target.value)} placeholder="vless://uuid@host:port?security=reality&pbk=…&sid=…&sni=…&flow=…&type=tcp#name"
                                      className="flex-1 min-w-[360px] h-14 px-2 py-1 border rounded text-xs font-mono"/>
                            <button onClick={() => { const v = vlessInput.trim(); if (!v) { notify("请粘贴 vless 链接"); return; } api.startXray(v).then((r) => { setXray(r.xray); setRegProxy(r.regProxy); notify(`独立代理已启动: ${r.xray.node} @ 端口${r.xray.port}`); }).catch((err: any) => notify(err.message)); }}
                                    className="px-4 py-2 bg-cyan-600 text-white rounded text-sm font-medium">▶ 启动</button>
                            <button onClick={() => api.stopXray().then((r) => { setXray(r.xray); notify("独立代理已停止"); }).catch((err: any) => notify(err.message))}
                                    className="px-3 py-2 bg-gray-500 text-white rounded text-sm">■ 停止</button>
                            <button onClick={() => { notify("正在经代理测出口…"); api.xrayProbe().then((r) => notify(r.ok ? `出口 ${r.ip} · chatgpt ${r.chatgpt} ${r.pass ? "✅可用" : "⚠️异常"}` : `❌${r.reason}`)).catch((err: any) => notify(err.message)); }}
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
                            <label className="text-xs text-gray-500 mb-1">邮箱登录代理(默认空=直连)</label>
                            <input value={mailProxy} onChange={(e) => setMailProxy(e.target.value)}
                                   placeholder="留空=直连"
                                   className="w-72 px-2 py-1.5 border rounded text-sm font-mono"/>
                        </div>
                        <button onClick={() => api.setProxy(regProxy, mailProxy).then(() => notify("代理已保存(影响之后启动的任务)")).catch((e) => notify(e.message))}
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
                        <span className="text-gray-500">共 <b className="text-gray-700">{filtered.length}</b> 条{selectedIds.size > 0 ? <> · 已选 <b className="text-indigo-600">{selectedIds.size}</b> 个</> : "（未选则对当前列表全部执行）"}</span>
                        <button onClick={() => api.batchTestAt(selectedIds.size ? [...selectedIds] : filtered.map((a) => a.id)).then((r) => notify(`批量测 at：${r.count} 个`)).catch((e) => notify(e.message))} className="px-2 py-1 bg-blue-600 text-white rounded text-xs">批量测 at</button>
                        {batchAt.running
                            ? <button onClick={() => api.stopBatchAt().then(() => notify("已请求停止(当前号跑完即停)")).catch((e) => notify(e.message))} className="px-2 py-1 bg-red-600 text-white rounded text-xs animate-pulse">⏹ 停止重登 {batchAt.done}/{batchAt.total}</button>
                            : <button onClick={() => { const ids = selectedIds.size ? [...selectedIds] : filtered.map((a) => a.id); if (!ids.length) { notify("无账号"); return; } if (!window.confirm(`对 ${ids.length} 个号【串行】测 at，失效的走浏览器登录重新获取(一次一个、每个约1-2分钟、可停止)。开始？`)) return; api.batchTestAt(ids, true).then((r) => notify(`已开始串行重登 ${r.count} 个`)).catch((e) => notify(e.message)); }} title="批量测 at,失效的号串行(一次一个)走浏览器登录重新获取 at" className="px-2 py-1 bg-blue-700 text-white rounded text-xs">批量重登at(串行)</button>}
                        <button onClick={() => api.batchTestRt(selectedIds.size ? [...selectedIds] : filtered.map((a) => a.id)).then((r) => notify(`批量测 rt：${r.count} 个`)).catch((e) => notify(e.message))} className="px-2 py-1 bg-teal-600 text-white rounded text-xs">批量测 rt</button>
                        <button onClick={() => api.batchTestChat(selectedIds.size ? [...selectedIds] : filtered.map((a) => a.id)).then((r) => notify(`批量测聊天：${r.count} 个（逐个开浏览器）`)).catch((e) => notify(e.message))} className="px-2 py-1 bg-fuchsia-600 text-white rounded text-xs">批量测聊天</button>
                        <button onClick={async () => {
                            const ids = selectedIds.size ? [...selectedIds] : filtered.map((a) => a.id);
                            if (!ids.length) { notify("无可导出的账号"); return; }
                            if (!window.confirm(`导出 ${ids.length} 个账号(邮箱----密码----rt----at)并标记为【已售出】？`)) return;
                            try {
                                const text = await api.exportSelected(ids, true);
                                const url = URL.createObjectURL(new Blob([text], {type: "text/plain;charset=utf-8"}));
                                const el = document.createElement("a"); el.href = url; el.download = "sold.txt"; el.click(); URL.revokeObjectURL(url);
                                setSelectedIds(new Set());
                                notify(`已导出 ${ids.length} 个并标记已售出`);
                            } catch (e: any) { notify(e.message); }
                        }} className="px-2 py-1 bg-amber-600 text-white rounded text-xs">导出选中+标记已售出</button>
                        <span className="mx-1 text-gray-300">|</span>
                        <input value={batchAssign} onChange={(e) => setBatchAssign(e.target.value)} placeholder="批次名" list="batch-list" className="w-24 px-2 py-1 border rounded text-xs"/>
                        <datalist id="batch-list">{batches.map((b) => <option key={b.name} value={b.name}/>)}</datalist>
                        <button onClick={setBatchForSelected} title="给选中(或当前列表全部)的号设置批次名,便于分组筛选/导出" className="px-2 py-1 bg-cyan-600 text-white rounded text-xs">设置批次</button>
                        <button onClick={async () => {
                            const ids = selectedIds.size ? [...selectedIds] : filtered.map((a) => a.id);
                            if (!ids.length) { notify("无可删除的账号"); return; }
                            const who = selectedIds.size ? `选中的 ${ids.length} 个` : `当前列表全部 ${ids.length} 个`;
                            if (!window.confirm(`确认删除${who}账号？此操作不可恢复（运行中的会跳过）。`)) return;
                            try { const r = await api.batchDelete(ids); setSelectedIds(new Set()); await api.listAccounts().then(setAccounts); notify(`已删除 ${r.count} 个${r.skipped ? `（跳过运行中 ${r.skipped}）` : ""}`); }
                            catch (e: any) { notify(e.message); }
                        }} title="删除选中(或当前列表全部)的号,不可恢复" className="px-2 py-1 bg-red-600 text-white rounded text-xs">🗑 删除选中</button>
                        {selectedIds.size > 0 && <button onClick={() => setSelectedIds(new Set())} className="text-gray-400 hover:underline text-xs">清空</button>}
                    </div>
                    <div ref={scrollRef} onScroll={(e) => setScrollTop((e.target as HTMLDivElement).scrollTop)} className="flex-1 overflow-auto min-h-0">
                    <table className="w-full text-sm">
                        <thead className="bg-gray-100 text-gray-500 sticky top-0 z-10">
                        <tr>
                            <th className="px-2 py-2"><input type="checkbox" title="全选当前列表"
                                checked={filtered.length > 0 && filtered.every((a) => selectedIds.has(a.id))}
                                onChange={(e) => setSelectedIds((prev) => { const s = new Set(prev); filtered.forEach((a) => e.target.checked ? s.add(a.id) : s.delete(a.id)); return s; })}/></th>
                            <th className="text-left px-4 py-2 font-medium">#</th>
                            <th className="text-left px-4 py-2 font-medium">邮箱</th>
                            <th className="text-left px-4 py-2 font-medium">状态</th>
                            <th className="text-left px-4 py-2 font-medium">套餐</th>
                            <th className="text-left px-4 py-2 font-medium">注册时间/存活</th>
                            <th className="text-left px-4 py-2 font-medium" title="at / rt / 聊天 概览，点行看详情可测试">令牌</th>
                        </tr>
                        </thead>
                        <tbody>
                        {vTopPad > 0 && <tr style={{height: vTopPad}}><td colSpan={7} className="p-0"/></tr>}
                        {vRows.map((a, idx) => { const i = vStart + idx; return (
                            <tr key={a.id} style={{height: ROW_H}}
                                onClick={() => { setSelectedId(a.id); setLogMode("single"); setDetailTab("log"); setPanelOpen(true); setEditMode(false); api.getAccount(a.id).then((r) => setAccounts((prev) => prev.map((x) => (x.id === a.id ? r : x)))).catch(() => {}); }}
                                className={`border-b cursor-pointer hover:bg-indigo-50 ${selectedId === a.id ? "bg-indigo-100" : ""}`}>
                                <td className="px-2 py-2" onClick={(e) => e.stopPropagation()}>
                                    <input type="checkbox" checked={selectedIds.has(a.id)} onChange={() => toggleSel(a.id)}/>
                                </td>
                                <td className="px-4 py-2 text-gray-400" title={`账号ID ${a.id}`}>{i + 1}</td>
                                <td className="px-4 py-2 font-mono">
                                    {a.email}
                                    {a.sold_at ? <span className="ml-1 px-1 rounded bg-amber-100 text-amber-700 text-xs">已售</span> : null}
                                </td>
                                <td className="px-4 py-2">
                                    <span className={`px-2 py-0.5 rounded text-xs font-medium ${STATUS_STYLE[a.status]}`}>{STATUS_LABEL[a.status]}</span>
                                    {/account_deactivated/i.test(a.error || "")
                                        ? <span className="ml-1 px-1.5 py-0.5 rounded bg-gray-300 text-gray-700 text-xs" title={a.error}>已停用</span>
                                        : a.status === "failed" && a.error ? <span className="ml-2 text-xs text-red-400" title={a.error}>{a.error.slice(0, 20)}…</span> : null}
                                </td>
                                <td className="px-4 py-2">{a.plan && <span className="px-2 py-0.5 bg-purple-100 text-purple-700 rounded text-xs">{a.plan}</span>}</td>
                                <td className="px-4 py-2 text-xs whitespace-nowrap" title={a.finished_at ? `注册完成 ${fmtDateTime(a.finished_at)}${a.dead_at ? ` · 失效 ${fmtDateTime(a.dead_at)}` : ""}` : "未成功"}>
                                    {a.status === "success"
                                        ? <span className="text-gray-500">
                                            {fmtDateTime(a.finished_at)}{" "}
                                            <span className={a.dead_at ? "text-red-500 font-medium" : "text-green-600 font-medium"}>· 存活{aliveDays(a.finished_at, a.dead_at)}{a.dead_at ? "(已失效)" : ""}</span>
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
                        {vBotPad > 0 && <tr style={{height: vBotPad}}><td colSpan={7} className="p-0"/></tr>}
                        {filtered.length === 0 && (
                            <tr><td colSpan={7} className="px-4 py-10 text-center text-gray-400">暂无数据。请到「📮 邮箱管理」导入独立邮箱并分配给 GPT，即可在此注册。</td></tr>
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
                                    {([["email", "邮箱"], ["password", "密码(明文)"], ["batch", "批次"], ["plan", "套餐"], ["phone", "手机"], ["card", "卡密"], ["at_status", "at状态"], ["rt_status", "rt状态"], ["chat_status", "聊天状态"]] as const).map(([k, label]) => (
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
                                <div className="px-4 py-3 border-b text-sm grid grid-cols-[4rem_1fr] gap-x-3 gap-y-1.5 shrink-0" onClick={(e) => e.stopPropagation()}>
                                    <span className="text-gray-400">ID</span><span className="text-gray-600">{selected.id}</span>
                                    <span className="text-gray-400">密码</span><span className="font-mono text-xs break-all text-gray-700 select-text cursor-text">{selected.password}</span>
                                    <span className="text-gray-400">改密</span><span className={`text-xs ${String(selected.pw_status || "").includes("✅") ? "text-green-600" : String(selected.pw_status || "").includes("❌") ? "text-red-500" : "text-gray-400"}`} title={selected.pw_status || "未改过邮箱密码"}>{selected.pw_status || "未改过"}</span>
                                    <span className="text-gray-400">套餐</span><span>{selected.plan ? <span className="px-2 py-0.5 bg-purple-100 text-purple-700 rounded text-xs">{selected.plan}</span> : "—"}</span>
                                    <span className="text-gray-400">批次</span><span className="text-xs text-gray-600">{selected.batch ? <span className="px-2 py-0.5 bg-cyan-100 text-cyan-700 rounded">{selected.batch}</span> : "—"}</span>
                                    <span className="text-gray-400">手机</span><span className="font-mono text-xs text-gray-600 select-text">{selected.phone ? "+" + selected.phone : "—"}{selected.card ? ` · 卡密 ${selected.card}` : ""}</span>
                                    <span className="text-gray-400">注册</span><span className="text-gray-600">{selected.finished_at ? <>{fmtDateTime(selected.finished_at)} <span className={selected.dead_at ? "text-red-500" : "text-green-600"}>· 存活{aliveDays(selected.finished_at, selected.dead_at)}{selected.dead_at ? "(已失效)" : ""}</span>{selected.sold_at ? <span className="ml-1 px-1 rounded bg-amber-100 text-amber-700 text-xs">已售</span> : null}</> : "—"}</span>
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
                                    {(selected.status === "failed" || selected.status === "success") &&
                                        <button onClick={() => api.retry(selected.id).then(() => notify("已重新排队")).catch((e) => notify(e.message))} className="px-2.5 py-1 bg-indigo-500 hover:bg-indigo-600 text-white rounded text-xs">重跑</button>}
                                    <button onClick={() => { if (!window.confirm(`删除 ${selected.email}？`)) return; api.remove(selected.id).then(() => { setSelectedId(null); setLogMode("all"); api.listAccounts().then(setAccounts); }).catch((e) => notify(e.message)); }} className="px-2.5 py-1 bg-red-500 hover:bg-red-600 text-white rounded text-xs">删除</button>
                                </div>
                              </>
                            ))}
                            {/* Tab 栏 */}
                            <div className="px-3 pt-2 flex items-center gap-1 text-sm shrink-0">
                                {(["log", "inbox"] as const).map((t) => (
                                    <button key={t} onClick={() => setDetailTab(t)}
                                            className={`px-3 py-1.5 rounded-t text-xs font-medium ${detailTab === t ? "bg-gray-900 text-white" : "bg-gray-100 text-gray-500 hover:bg-gray-200"}`}>
                                        {t === "log" ? "📋 日志" : "📥 收件箱"}
                                    </button>
                                ))}
                                {detailTab === "inbox" && <button onClick={() => selected && openInbox(selected)} disabled={inboxLoading} className={`ml-auto text-xs ${inboxLoading ? "text-gray-300" : "text-indigo-600 hover:underline"}`}>{inboxLoading ? "刷新中…" : "🔄 刷新"}</button>}
                            </div>
                            {/* Tab 内容 */}
                            <div className="flex-1 overflow-auto min-h-0">
                                {detailTab === "log" ? (
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
                                ) : (
                                    <div className="p-4">
                                        {inboxLoading && <div className="text-center py-10 text-gray-500">正在登录 mail.com 拉取收件箱…（约 20~30s）</div>}
                                        {inboxError && !inboxLoading && <div className="text-red-500 text-sm py-4">❌ 登录/收信失败：{inboxError}</div>}
                                        {inboxData && !inboxLoading && inboxData.mails.length === 0 && <div className="text-emerald-600 text-center py-10">✓ 登录成功，收件箱为空</div>}
                                        {inboxData && inboxData.mails.map((m: any) => (
                                            <div key={m.id} className="border-b py-2 cursor-pointer hover:bg-gray-50 -mx-2 px-2 rounded" onClick={() => toggleMail(m.id)}>
                                                <div className="flex justify-between text-xs text-gray-400 mb-0.5">
                                                    <span className="truncate max-w-[60%]">{m.from}</span><span>{m.date}</span>
                                                </div>
                                                <div className="text-sm text-gray-800 flex items-center gap-1">
                                                    <span className="text-gray-400 text-xs">{expandedMail === m.id ? "▾" : "▸"}</span>
                                                    {m.subject || "(无主题)"}
                                                </div>
                                                {expandedMail === m.id && (
                                                    <div className="mt-2 text-xs text-gray-600 whitespace-pre-wrap bg-gray-50 border rounded p-2 max-h-64 overflow-auto leading-relaxed select-text cursor-text" onClick={(e) => e.stopPropagation()}>
                                                        {mailLoadingId === m.id ? "正在加载正文…" : (mailBodies[m.id] ?? "(点击加载)")}
                                                    </div>
                                                )}
                                            </div>
                                        ))}
                                    </div>
                                )}
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
                            <span className="font-medium">⚙ 按批次/格式导出</span>
                            <button onClick={() => setShowExport(false)} className="text-gray-400 hover:text-gray-700 text-lg leading-none">✕</button>
                        </div>
                        <div className="px-5 py-4 space-y-3 text-sm">
                            <div className="text-xs text-gray-500">
                                带 rt 的：<span className="font-mono">邮箱----邮箱密码----GPT密码----rt----sessjson</span><br/>
                                只有 at 的：<span className="font-mono">邮箱----邮箱密码----GPT密码----sessjson</span>
                            </div>
                            <label className="flex items-center gap-2"><span className="w-14 text-gray-400">批次</span>
                                <select value={exportBatch} onChange={(e) => setExportBatch(e.target.value)} className="flex-1 px-2 py-1.5 border rounded">
                                    <option value="">全部批次</option>
                                    {batches.map((b) => <option key={b.name} value={b.name}>{b.name} ({b.count})</option>)}
                                </select>
                            </label>
                            <label className="flex items-center gap-2"><span className="w-14 text-gray-400">范围</span>
                                <select value={exportScope} onChange={(e) => setExportScope(e.target.value as any)} className="flex-1 px-2 py-1.5 border rounded">
                                    <option value="all">全部成功号</option>
                                    <option value="hasRt">仅带 rt 的</option>
                                    <option value="atOnly">仅只有 at 的</option>
                                </select>
                            </label>
                            <label className="flex items-center gap-2"><span className="w-14 text-gray-400">格式</span>
                                <select value={exportFormat} onChange={(e) => setExportFormat(e.target.value as any)} className="flex-1 px-2 py-1.5 border rounded">
                                    <option value="txt">TXT(每行一条, ---- 分隔)</option>
                                    <option value="csv">CSV(统一列, 逗号分隔)</option>
                                </select>
                            </label>
                            <label className="flex items-center gap-2 cursor-pointer text-amber-700 pt-1">
                                <input type="checkbox" checked={exportMarkSold} onChange={(e) => setExportMarkSold(e.target.checked)}/>
                                导出后把这批号标记为【已售出】
                            </label>
                        </div>
                        <div className="px-5 py-3 border-t flex justify-end gap-2">
                            <button onClick={() => setShowExport(false)} className="px-4 py-1.5 bg-gray-200 hover:bg-gray-300 rounded text-sm">取消</button>
                            <button onClick={doExportFull} className="px-4 py-1.5 bg-emerald-600 hover:bg-emerald-700 text-white rounded text-sm">⬇ 导出</button>
                        </div>
                    </div>
                </div>
            )}
            </>)}
            {toast && <div className="fixed bottom-6 left-1/2 -translate-x-1/2 bg-gray-900 text-white px-5 py-2.5 rounded-lg shadow-lg text-sm">{toast}</div>}
        </div>
    );
}
