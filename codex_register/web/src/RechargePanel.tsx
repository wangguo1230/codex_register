import {useEffect, useState, useMemo, useRef, type Dispatch, type SetStateAction} from "react";
import {api, connectStream, type Account, type RebindGmailPoolItem, type RechargeCard, type RechargeCardStats, type RechargeQueueItem, type RechargeQueueStats} from "./api";
import {filterRechargeQueue} from "./recharge-queue-filter";

const BJ_TIME_FORMATTERS = {
    minute: new Intl.DateTimeFormat("en-CA", {
        timeZone: "Asia/Shanghai",
        month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false,
    }),
    second: new Intl.DateTimeFormat("en-CA", {
        timeZone: "Asia/Shanghai",
        month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
    }),
};
/** 北京时间固定 Asia/Shanghai，不跟浏览器本地时区 */
const fmtBjParts = (ts: number, withSec = false) => {
    const parts = BJ_TIME_FORMATTERS[withSec ? "second" : "minute"].formatToParts(new Date(ts));
    const g = (t: string) => parts.find((p) => p.type === t)?.value || "00";
    return withSec
        ? `${g("month")}-${g("day")} ${g("hour")}:${g("minute")}:${g("second")}`
        : `${g("month")}-${g("day")} ${g("hour")}:${g("minute")}`;
};
const fmtTime = (ts?: number) => (!ts ? "—" : fmtBjParts(ts, false));
const fmtLogTime = (ts?: number) => (!ts ? "—" : fmtBjParts(ts, true));
const fmtDur = (start?: number, end?: number) => {
    if (!start || !end || end < start) return "—";
    const s = Math.round((end - start) / 1000);
    if (s < 60) return `${s}秒`;
    const m = Math.floor(s / 60), sec = s % 60;
    if (m < 60) return sec ? `${m}分${sec}秒` : `${m}分`;
    return `${Math.floor(m / 60)}小时${m % 60}分`;
};

const Q_LABEL: Record<string, string> = {pending: "待提交", paired: "已配对", submitting: "提交中", submitted: "已提交", done: "完成", error: "失败"};
const Q_COLOR: Record<string, string> = {pending: "#6b7280", paired: "#2563eb", submitting: "#f59e0b", submitted: "#8b5cf6", done: "#16a34a", error: "#dc2626"};
const TASK_COLOR: Record<string, string> = {pending: "#6b7280", leased: "#2563eb", running: "#2563eb", paid: "#16a34a", failed: "#dc2626", canceled: "#dc2626", returned: "#f59e0b", manual_review: "#f59e0b"};
const EMPTY_Q: RechargeQueueStats = {pending: 0, paired: 0, submitting: 0, submitted: 0, done: 0, error: 0, total: 0, undelivered: 0, delivered: 0, failed: 0, working: 0, ready: 0};
const TEST_SEND_TO = "wangguodong194@163.com";
const EMPTY_C: RechargeCardStats = {unused: 0, paired: 0, submitting: 0, submitted: 0, done: 0, error: 0, total: 0};
type RechargeLogEntry = {ts: number; line: string; instance_id?: string; scope?: string};
type TrackedOperationKind = "rebind" | "submit" | "reloginSubmit" | "rtExport" | "reloginRt" | "sub2json";
type TrackedOperation = {
    kind: TrackedOperationKind;
    label: string;
    ids: number[];
    total: number;
    skipped: number;
    startedAt: number;
    final?: {done: number; failed: number; total: number};
};

/** 官方 24h 换绑上限还剩多久解禁，<=0 表示没在冷却 */
function rebindCooldownLeft(q: RechargeQueueItem): number {
    return Math.max(0, (Number(q.rebind_blocked_until) || 0) - Date.now());
}
function fmtCooldown(ms: number): string {
    const min = Math.ceil(ms / 60_000);
    if (min < 60) return `${min} 分钟`;
    return `${Math.floor(min / 60)} 小时 ${min % 60} 分`;
}

/** 换绑展示：原邮箱 → 现邮箱 */
function rebindLine(q: RechargeQueueItem): {text: string; title: string; ok: boolean} {
    const from = String(q.rebind_from || "").trim();
    const to = String(q.rebind_email || q.email || "").trim();
    // 待核对要先判：二次换绑时 rebind_from 已有值，会被下面的「已换绑」分支误吞
    if (q.rebind_status === "unknown") {
        const t = String(q.rebind_attempt_email || "").trim();
        return {
            text: t ? `待核对 → ${t}` : "待核对",
            title: q.rebind_error || "官方是否已改未知，正在向官方对账，目标邮箱暂不回池",
            ok: false,
        };
    }
    if (q.rebind_status === "ok" || (from && to && from !== to)) {
        const text = from && to && from !== to ? `${from} → ${to}` : (to || from || "已换绑");
        return {text, title: text, ok: true};
    }
    if (q.rebind_status === "pending") {
        const t = q.rebind_target === "mailcom" ? " mail.com" : q.rebind_target === "gmail" ? " Gmail" : "";
        return {text: `换绑中${t}`, title: q.rebind_error || "", ok: false};
    }
    if (q.rebind_status === "fail") {
        // 24h 上限是"等就好"，跟真失败区分开，不然会一直去点它
        if (rebindCooldownLeft(q) > 0) {
            return {
                text: `24h 上限 · ${fmtCooldown(rebindCooldownLeft(q))}后可换`,
                title: q.rebind_error || "官方限制单个账号 24 小时内的换绑次数，换目标邮箱/换出口都没用",
                ok: false,
            };
        }
        return {text: q.rebind_error || "失败", title: q.rebind_error || "", ok: false};
    }
    if (q.rebind_status === "skipped") return {text: "无需换绑", title: "", ok: false};
    return {text: "—", title: "", ok: false};
}

export function RechargePanel({notify}: {notify?: (m: string, ms?: number) => void}) {
    // 队列：未交付=作业中；失败=标失败/预检失败；已交付=移除后的历史
    const [deliveryTab, setDeliveryTab] = useState<"undelivered" | "ready" | "error" | "delivered">("undelivered");
    const deliveryTabRef = useRef<"undelivered" | "ready" | "error" | "delivered">("undelivered");
    deliveryTabRef.current = deliveryTab;
    const [queue, setQueue] = useState<RechargeQueueItem[]>([]);
    const [qStats, setQStats] = useState<RechargeQueueStats>(EMPTY_Q);
    const [qSel, setQSel] = useState<Set<number>>(new Set());
    const [qFilter, setQFilter] = useState("all");
    const [qBatchFilter, setQBatchFilter] = useState("");
    const [qMailboxType, setQMailboxType] = useState("");
    const [qRebindFilter, setQRebindFilter] = useState("");
    const [qEmailFilter, setQEmailFilter] = useState("");
    const [qBatches, setQBatches] = useState<{name: string; n: number}[]>([]);
    // 卡密
    const [cards, setCards] = useState<RechargeCard[]>([]);
    const [cStats, setCStats] = useState<RechargeCardStats>(EMPTY_C);
    const [cSel, setCSel] = useState<Set<number>>(new Set());
    // 配置
    const [configBase, setConfigBase] = useState("");
    const [configAppId, setConfigAppId] = useState("");
    const [configKey, setConfigKey] = useState("");
    const [configIp, setConfigIp] = useState("");
    const [configConcurrency, setConfigConcurrency] = useState(3);
    const [configRebindConcurrency, setConfigRebindConcurrency] = useState(3);
    const [configInterval, setConfigInterval] = useState(3);
    const [configRtProxy, setConfigRtProxy] = useState("");
    const [configRtConcurrency, setConfigRtConcurrency] = useState(4);
    const [configRebindAfterPaid, setConfigRebindAfterPaid] = useState<"off" | "gmail" | "mailcom">("gmail");
    const [configRebindGmailProbeLogin, setConfigRebindGmailProbeLogin] = useState(false);
    const [gmailFreeImap, setGmailFreeImap] = useState(0);
    const [mailcomFree, setMailcomFree] = useState(0);
    const [hasKey, setHasKey] = useState(false);
    const [instanceId, setInstanceId] = useState("");
    const [showConfig, setShowConfig] = useState(false);
    // 弹窗
    const [showImport, setShowImport] = useState(false);
    const [importText, setImportText] = useState("");
    const [importBatch, setImportBatch] = useState("");
    const [showPicker, setShowPicker] = useState(false);
    const [accounts, setAccounts] = useState<Account[]>([]);
    const [pickerSearch, setPickerSearch] = useState("");
    const [pickerBatch, setPickerBatch] = useState("");
    const [pickerSel, setPickerSel] = useState<Set<number>>(new Set());
    const [rechargeBatch, setRechargeBatch] = useState("");
    const [rechargeGrpNew, setRechargeGrpNew] = useState("");
    const [inheritSourceBatch, setInheritSourceBatch] = useState(true);
    const [queueGroups, setQueueGroups] = useState<{name: string; n: number}[]>([]);
    const [showSetBatch, setShowSetBatch] = useState(false);
    const [batchInput, setBatchInput] = useState("");
    const [showTestSend, setShowTestSend] = useState(false);
    const [testSendTo, setTestSendTo] = useState(TEST_SEND_TO);
    const [testSendPreview, setTestSendPreview] = useState<{id: number; from: string; queueEmail: string; rebound: boolean; subject: string; text: string; canSend: boolean; reason: string; group: string; via?: string}[]>([]);
    const [testSendResult, setTestSendResult] = useState("");
    const [testSendBusy, setTestSendBusy] = useState(false);
    const testSendBusyRef = useRef(false);
    testSendBusyRef.current = testSendBusy;
    const [exportRtRunning, setExportRtRunning] = useState(false);
    const [sub2jsonConc, setSub2jsonConc] = useState(2);
    const [jobSubmit, setJobSubmit] = useState(false);
    const [jobReloginSubmit, setJobReloginSubmit] = useState(false);
    const [showExportMenu, setShowExportMenu] = useState(false);
    const exportMenuRef = useRef<HTMLDivElement>(null);
    // 导出 sub2json
    const [showSub2json, setShowSub2json] = useState(false);
    const [sub2jsonInput, setSub2jsonInput] = useState("");
    const [sub2jsonRefreshing, setSub2jsonRefreshing] = useState(false);
    const [sub2jsonResults, setSub2jsonResults] = useState<{email: string; password?: string; ok: boolean; reason?: string; tokens?: {access_token: string; refresh_token: string; id_token?: string; account_id?: string}}[]>([]);
    // 批量获取 RT
    const [showBatchRt, setShowBatchRt] = useState(false);
    const [batchRtInput, setBatchRtInput] = useState("");
    const [batchRtResults, setBatchRtResults] = useState<{email: string; password?: string; rt?: string; accessToken?: string; ok: boolean; reason?: string; status: "pending"|"running"|"done"}[]>([]);
    const [batchRtRunning, setBatchRtRunning] = useState(false);
    const [trackedOperation, setTrackedOperation] = useState<TrackedOperation | null>(null);
    // 状态
    const [busy, setBusy] = useState(false);
    const [logs, setLogs] = useState<RechargeLogEntry[]>([]);
    const [detailItem, setDetailItem] = useState<RechargeQueueItem | null>(null);
    const [detailLogs, setDetailLogs] = useState<RechargeLogEntry[]>([]);
    const [detailLoading, setDetailLoading] = useState(false);
    const detailItemRef = useRef<RechargeQueueItem | null>(null);
    const detailRequestRef = useRef(0);
    detailItemRef.current = detailItem;
    const logBoxRef = useRef<HTMLDivElement>(null);
    const logStickBottomRef = useRef(true);
    const streamConnectedRef = useRef(false);
    const [showRebindGmail, setShowRebindGmail] = useState(false);
    const [rebindIds, setRebindIds] = useState<number[]>([]);
    /** 验证区分组；换绑只从「换绑池」ready 列表选 */
    const [stageGrp, setStageGrp] = useState("");
    const [stagePick, setStagePick] = useState<Set<number>>(new Set());
    const [readyPick, setReadyPick] = useState<Set<number>>(new Set());
    const [stageSearch, setStageSearch] = useState("");
    const [readySearch, setReadySearch] = useState("");
    const [rebindPool, setRebindPool] = useState<{
        poolGrp: string;
        staging: RebindGmailPoolItem[];
        ready: RebindGmailPoolItem[];
        groups: {grp: string; n: number}[];
        stagingCount: number;
        readyCount: number;
    }>({poolGrp: "换绑池", staging: [], ready: [], groups: [], stagingCount: 0, readyCount: 0});

    const toast = (m: string, ms?: number) => notify?.(m, ms);
    const isDeliveredTab = deliveryTab === "delivered";
    const isFailedTab = deliveryTab === "error";
    const isReadyTab = deliveryTab === "ready";
    const isWorkingTab = deliveryTab === "undelivered";
    /** SSE 异步导出 RT 完成后回调（ref 避免 effect 闭包拿不到最新 deliver） */
    const deliverExportTextRef = useRef<(text: string, format: "account" | "full" | "card" | "session") => Promise<void>>(async () => {});

    const loadQueue = () => {
        const d = deliveryTabRef.current;
        api.rechargeQueue(d).then((r) => { setQueue(r.list); setQStats(r.stats); }).catch(() => {});
        api.rechargeQueueBatches(d).then(setQBatches).catch(() => {});
    };
    const loadCards = () => api.rechargeCards().then((r) => { setCards(r.list); setCStats(r.stats); }).catch(() => {});
    const applyRebindCounts = (c: {gmailFreeImap?: number; mailcomFree?: number; rebindAfterPaid?: string; rebindGmailAfterPaid?: boolean; rebindGmailProbeLogin?: boolean; rebindConcurrency?: number}) => {
        if (typeof c.gmailFreeImap === "number") setGmailFreeImap(c.gmailFreeImap);
        if (typeof c.mailcomFree === "number") setMailcomFree(c.mailcomFree);
        if (c.rebindAfterPaid === "off" || c.rebindAfterPaid === "gmail" || c.rebindAfterPaid === "mailcom") setConfigRebindAfterPaid(c.rebindAfterPaid);
        else if (typeof c.rebindGmailAfterPaid === "boolean") setConfigRebindAfterPaid(c.rebindGmailAfterPaid ? "gmail" : "off");
        if (typeof c.rebindGmailProbeLogin === "boolean") setConfigRebindGmailProbeLogin(c.rebindGmailProbeLogin);
        if (Number.isFinite(Number(c.rebindConcurrency)) && Number(c.rebindConcurrency) > 0) setConfigRebindConcurrency(Math.floor(Number(c.rebindConcurrency)));
    };
    const applyJobs = (j?: {submit?: boolean; reloginSubmit?: boolean; relogin?: boolean; exportRt?: boolean}) => {
        if (!j) return;
        setJobSubmit(!!j.submit);
        setJobReloginSubmit(!!(j.reloginSubmit || j.relogin));
        setExportRtRunning(!!j.exportRt);
    };
    const refreshJobs = () => api.rechargeJobs().then(applyJobs).catch(() => {});
    const loadConfig = () => api.rechargeConfig().then((c) => { setConfigBase(c.baseUrl); setConfigAppId(c.appId || ""); setConfigKey(c.apiKey); setConfigIp(c.forwardIp); setConfigConcurrency(c.concurrency || 3); setConfigRebindConcurrency(c.rebindConcurrency || 3); setConfigInterval(c.interval ?? 3); setConfigRtProxy(c.rtProxy || ""); setConfigRtConcurrency(c.rtConcurrency || 4); applyRebindCounts(c); setHasKey(!!c.hasKey); setInstanceId(c.instanceId || ""); applyJobs(c.jobs); }).catch(() => {});
    const loadLogs = () => api.rechargeLogs().then((rows) => setLogs(Array.isArray(rows) ? rows.slice(-5000) : [])).catch(() => {});
    const trackedProgress = useMemo(() => {
        const operation = trackedOperation;
        if (!operation) return null;
        if (operation.final) {
            const total = Math.max(1, operation.final.total || operation.total);
            const done = Math.min(total, Math.max(0, operation.final.done));
            const failed = Math.min(total - done, Math.max(0, operation.final.failed));
            return {label: operation.label, total, done, success: Math.max(0, done - failed), failed, waiting: Math.max(0, total - done), percent: Math.round((done / total) * 100), active: false};
        }
        if (operation.kind === "rtExport" || operation.kind === "reloginRt" || operation.kind === "sub2json") {
            const terminal = new Map<string, boolean>();
            for (const entry of logs) {
                if (Number(entry.ts) < operation.startedAt) continue;
                const line = String(entry.line || "");
                const distributed = line.match(/RT任务\s+([^\s]+)\s+→\s+(success|failed|canceled)/i);
                if (distributed) terminal.set(distributed[1], distributed[2].toLowerCase() !== "success");
                const indexed = line.match(/\[(\d+)\/\d+\].*(?:✓|✗|失败|成功)/);
                if (indexed) terminal.set(`index:${indexed[1]}`, /✗|失败/.test(line));
            }
            const failed = [...terminal.values()].filter(Boolean).length;
            const done = Math.min(operation.total, terminal.size);
            return {label: operation.label, total: operation.total, done, success: Math.max(0, done - failed), failed, waiting: Math.max(0, operation.total - done), percent: operation.total ? Math.round((done / operation.total) * 100) : 0, active: true};
        }
        const rows = operation.ids.map((id) => queue.find((item) => item.id === id)).filter(Boolean) as RechargeQueueItem[];
        let success = 0;
        let observedFailed = 0;
        if (operation.kind === "rebind") {
            success = rows.filter((item) => item.rebind_status === "ok").length;
            observedFailed = rows.filter((item) => item.rebind_status === "fail").length;
        } else {
            success = rows.filter((item) => item.status === "done" || item.task_status === "paid").length;
            observedFailed = rows.filter((item) => item.status === "error" || /failed|error/i.test(String(item.task_status || ""))).length;
        }
        const failed = Math.min(operation.total - success, Math.max(operation.skipped, observedFailed));
        const done = Math.min(operation.total, success + failed);
        return {label: operation.label, total: operation.total, done, success, failed, waiting: Math.max(0, operation.total - done), percent: operation.total ? Math.round((done / operation.total) * 100) : 0, active: true};
    }, [trackedOperation, queue, logs]);
    const detailLogKeys = (item: RechargeQueueItem) => {
        const card = String(item.card_code || "").trim();
        return [...new Set([
            item.email,
            item.rebind_from,
            item.rebind_email,
            item.rebind_attempt_email,
            item.task_no,
            card,
            card.length >= 8 ? card.slice(0, 8) : "",
        ].map((value) => String(value || "").trim()).filter((value) => value.length >= 3))];
    };
    const refreshDetailLogs = async (item: RechargeQueueItem) => {
        const requestId = ++detailRequestRef.current;
        setDetailLoading(true);
        try {
            const rows = await api.rechargeLogs();
            if (requestId !== detailRequestRef.current) return;
            const keys = detailLogKeys(item);
            setDetailLogs((Array.isArray(rows) ? rows : []).filter((entry) => {
                const line = String(entry?.line || "");
                return keys.some((key) => line.includes(key));
            }));
        } catch (error: any) {
            if (requestId === detailRequestRef.current) {
                setDetailLogs([]);
                toast(`读取详细日志失败: ${error?.message || error}`);
            }
        } finally {
            if (requestId === detailRequestRef.current) setDetailLoading(false);
        }
    };
    const openDetailLogs = (item: RechargeQueueItem) => {
        setDetailItem(item);
        setDetailLogs([]);
        void refreshDetailLogs(item);
    };

    useEffect(() => {
        loadQueue(); loadCards(); loadConfig(); loadLogs();
        const off = connectStream((ev, data: any) => {
            if (ev === "rechargeQueue") {
                setQStats(data.stats || EMPTY_Q);
                if (deliveryTabRef.current === "undelivered") setQueue(data.list || []);
                else loadQueue();
            }
            if (ev === "recharge") { setCards(data.list || []); setCStats(data.stats || EMPTY_C); }
            if (ev === "rechargeLog") {
                setLogs((prev) => [...prev.slice(-5000), data]);
                const currentDetail = detailItemRef.current;
                if (currentDetail && detailLogKeys(currentDetail).some((key) => String(data?.line || "").includes(key))) {
                    setDetailLogs((prev) => prev.some((entry) => entry.ts === data.ts && entry.line === data.line) ? prev : [...prev, data]);
                }
                if (/^换绑 [✓✗]/.test(String(data?.line || ""))) loadConfig();
            }
            if (ev === "batchRtAcquire") { setBatchRtResults(data.results.map((r: any) => ({...r, status: r.status || "done"}))); if (data.done) setBatchRtRunning(false); }
            if (ev === "rechargeJobs") applyJobs(data);
            if (ev === "rechargeExportReady") {
                setExportRtRunning(false);
                setTrackedOperation((previous) => {
                    if (!previous || !["rtExport", "reloginRt", "sub2json"].includes(previous.kind)) return previous;
                    return {...previous, final: {done: (Number(data.ok) || 0) + (Number(data.fail) || 0), failed: Number(data.fail) || 0, total: Number(data.total) || previous.total}};
                });
                void refreshJobs();
                if (data?.stopped) toast("导出已停止");
                else if (data?.format === "sub2json" && data?.text) {
                    const n = Number(data.ok) || 0;
                    const blob = new Blob([String(data.text)], {type: "application/json;charset=utf-8"});
                    const a = document.createElement("a");
                    a.href = URL.createObjectURL(blob);
                    a.download = `sub2api-import-${n}.json`;
                    a.click();
                    URL.revokeObjectURL(a.href);
                    toast(`已导出 sub2json ${n}/${data.total || n}（失败 ${data.fail || 0}），一个 JSON`);
                }
                else if (data?.text) void deliverExportTextRef.current(String(data.text), "full");
                else if (data?.relogin) toast("重登取 RT 完成，但没有可复制内容");
            }
            if (ev === "rechargeSendDone") {
                setTestSendBusy(false);
                const line = data?.error && !data?.sent
                    ? `发送失败: ${data.error}`
                    : `发出 ${data?.sent || 0} · 失败 ${data?.failed || 0} · 跳过 ${data?.skipped || 0} → ${data?.to || ""}`;
                setTestSendResult(line);
                toast(data?.ok ? `测试邮件已发 ${data.sent} 封` : (data?.error || line), 6000);
            }
        }, (connected) => { streamConnectedRef.current = connected; });
        // SSE 重连会丢中间事件；换绑卡在 mail.com 时也要靠轮询把磁盘日志刷出来
        const poll = setInterval(() => {
            // 任务状态是轻量内存状态；即使 SSE 丢了完成事件，也不能让停止按钮永久残留。
            refreshJobs();
            // 操作日志来自共享 PostgreSQL，SSE 只覆盖本实例；定时拉取可看到其他实例的新日志。
            loadLogs();
            if (!streamConnectedRef.current) loadQueue();
            if (!testSendBusyRef.current) return;
            api.rechargeTestSendStatus().then((s) => {
                if (!testSendBusyRef.current || s.running || !s.finishedAt) return;
                setTestSendBusy(false);
                setTestSendResult(s.error && !s.sent
                    ? `发送失败: ${s.error}`
                    : `发出 ${s.sent} · 失败 ${s.failed} · 跳过 ${s.skipped} → ${s.to}`);
            }).catch(() => {});
        }, 4000);
        return () => { off(); clearInterval(poll); };
    }, []);

    // 切换 未交付/已交付 时重新拉列表
    useEffect(() => {
        setQSel(new Set());
        setQFilter("all");
        setQBatchFilter("");
        loadQueue();
    }, [deliveryTab]);

    const onLogBoxScroll = () => {
        const el = logBoxRef.current;
        if (!el) return;
        logStickBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
    };
    useEffect(() => {
        const el = logBoxRef.current;
        if (!el || !logStickBottomRef.current) return;
        el.scrollTop = el.scrollHeight;
    }, [logs]);
    useEffect(() => {
        if (!showExportMenu) return;
        const onDoc = (e: MouseEvent) => {
            if (!exportMenuRef.current?.contains(e.target as Node)) setShowExportMenu(false);
        };
        document.addEventListener("mousedown", onDoc);
        return () => document.removeEventListener("mousedown", onDoc);
    }, [showExportMenu]);

    // 队列筛选
    const filteredQueue = useMemo(() => {
        return filterRechargeQueue(queue, {
            status: qFilter,
            batch: qBatchFilter,
            mailboxType: qMailboxType,
            rebind: qRebindFilter,
            email: qEmailFilter,
        });
    }, [queue, qFilter, qBatchFilter, qMailboxType, qRebindFilter, qEmailFilter]);

    const toggleQSel = (id: number) => setQSel((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
    const fqIds = useMemo(() => filteredQueue.map((q) => q.id), [filteredQueue]);
    const fqIdSet = useMemo(() => new Set(fqIds), [fqIds]);
    const selectedQueueIds = useMemo(() => [...qSel].filter((id) => fqIdSet.has(id)), [qSel, fqIdSet]);
    const allQSel = fqIds.length > 0 && fqIds.every((id) => qSel.has(id));
    const toggleAllQ = () => setQSel(allQSel ? new Set() : new Set(fqIds));
    const selQIds = () => selectedQueueIds;

    // 卡密列表(简化显示)
    const toggleCSel = (id: number) => setCSel((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });

    // ---- 操作 ----
    const doSaveConfig = async () => {
        setBusy(true);
        try {
            const body: any = {baseUrl: configBase, appId: configAppId, forwardIp: configIp, concurrency: configConcurrency, rebindConcurrency: configRebindConcurrency, interval: configInterval, rtProxy: configRtProxy, rtConcurrency: configRtConcurrency, rebindAfterPaid: configRebindAfterPaid, rebindGmailProbeLogin: configRebindGmailProbeLogin};
            if (configKey && !configKey.includes("****")) body.apiKey = configKey;
            await api.setRechargeConfig(body);
            loadConfig(); toast("配置已保存"); setShowConfig(false);
        } catch (e: any) { toast("保存失败: " + e.message); } finally { setBusy(false); }
    };

    // 选号入队(搬 GPT 面板筛选条件:批次 + 质量 facet)
    const [pickerFacets, setPickerFacets] = useState<Set<string>>(new Set());
    const [pickerTakeN, setPickerTakeN] = useState("20");
    const togglePickerFacet = (k: string) => setPickerFacets((s) => { const n = new Set(s); n.has(k) ? n.delete(k) : n.add(k); return n; });

    const isGmailAcc = (a: Account) => a.provider === "google" || /@(gmail|googlemail)\.com$/i.test(a.email || "");
    const isMailcomAcc = (a: Account) => !isGmailAcc(a) && (a.provider === "mailcom" || a.provider === "mail.com" || /@mail\.com$/i.test(a.email || ""));
    const accKindLabel = (a: Account) => isGmailAcc(a) ? "Gmail" : isMailcomAcc(a) ? "mail.com" : (a.provider || "其他");

    const PICKER_FACETS: Record<string, {group: string; label: string; pred: (a: Account) => boolean}> = useMemo(() => ({
        kindGmail: {group: "邮箱", label: "Gmail", pred: (a) => isGmailAcc(a)},
        kindMailcom: {group: "邮箱", label: "mail.com", pred: (a) => isMailcomAcc(a)},
        kindOther: {group: "邮箱", label: "其他", pred: (a) => !isGmailAcc(a) && !isMailcomAcc(a)},
        hasRt: {group: "令牌", label: "带rt", pred: (a) => !!a.rt_file},
        atOnly: {group: "令牌", label: "只有at", pred: (a) => !a.rt_file},
        atOk: {group: "AT", label: "at有效", pred: (a) => /✅/.test(a.at_status || "")},
        atFail: {group: "AT", label: "at失效", pred: (a) => /❌/.test(a.at_status || "")},
        atNone: {group: "AT", label: "未测at", pred: (a) => !a.at_status},
        pwOk: {group: "改密", label: "已改密", pred: (a) => String(a.pw_status || "").includes("✅")},
        noPw: {group: "改密", label: "未改密", pred: (a) => !String(a.pw_status || "").includes("✅")},
        has2fa: {group: "2FA", label: "带2FA", pred: (a) => !!(a.totp_secret || "").trim() || /✅/.test(a.mfa_status || "")},
        no2fa: {group: "2FA", label: "无2FA", pred: (a) => !(a.totp_secret || "").trim() && !/✅/.test(a.mfa_status || "")},
    }), []);

    const openPicker = async () => {
        try {
            const accs = await api.rechargeableAccounts();
            const grps = await api.rechargeQueueBatches("all").catch(() => []);
            setQueueGroups(Array.isArray(grps) ? grps : []);
            setAccounts(accs); setPickerSel(new Set()); setPickerSearch(""); setPickerBatch("");
            setRechargeBatch(""); setRechargeGrpNew(""); setPickerFacets(new Set()); setPickerTakeN("20"); setShowPicker(true);
        } catch (e: any) { toast("获取账号列表失败: " + e.message); }
    };

    const selectedSourceBatches = useMemo(() => [...new Set(
        [...pickerSel]
            .map((id) => accounts.find((account) => account.id === id)?.batch || "")
            .map((batch) => String(batch).trim())
            .filter(Boolean),
    )].sort(), [accounts, pickerSel]);
    const inheritedSourceBatch = pickerBatch.trim() || (selectedSourceBatches.length === 1 ? selectedSourceBatches[0] : "");
    const resolvedEnqueueGrp = () => (
        rechargeGrpNew.trim()
        || rechargeBatch.trim()
        || (inheritSourceBatch ? inheritedSourceBatch : "")
    );

    const pickerBatches = useMemo(() => {
        const map = new Map<string, number>();
        for (const a of accounts) { const b = a.batch || ""; map.set(b, (map.get(b) || 0) + 1); }
        return [...map.entries()].map(([name, n]) => ({name, n})).sort((a, b) => b.n - a.n);
    }, [accounts]);

    const pickerFacetCounts = useMemo(() => {
        const base = pickerBatch ? accounts.filter((a) => (a.batch || "") === pickerBatch) : accounts;
        const out: Record<string, number> = {};
        for (const [k, d] of Object.entries(PICKER_FACETS)) out[k] = base.filter(d.pred).length;
        return out;
    }, [accounts, pickerBatch, PICKER_FACETS]);

    const pickerFiltered = useMemo(() => {
        let list = accounts;
        if (pickerBatch) list = list.filter((a) => (a.batch || "") === pickerBatch);
        if (pickerSearch) { const q = pickerSearch.toLowerCase(); list = list.filter((a) => a.email.toLowerCase().includes(q)); }
        if (pickerFacets.size) {
            const byGroup = new Map<string, ((a: Account) => boolean)[]>();
            for (const k of pickerFacets) {
                const d = PICKER_FACETS[k]; if (!d) continue;
                if (!byGroup.has(d.group)) byGroup.set(d.group, []);
                byGroup.get(d.group)!.push(d.pred);
            }
            list = list.filter((a) => [...byGroup.values()].every((preds) => preds.some((p) => p(a))));
        }
        return list;
    }, [accounts, pickerSearch, pickerBatch, pickerFacets, PICKER_FACETS]);

    const pickerToggle = (id: number) => setPickerSel((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
    const pickerAllSel = pickerFiltered.length > 0 && pickerFiltered.every((a) => pickerSel.has(a.id));
    const pickerToggleAll = () => setPickerSel(pickerAllSel ? new Set() : new Set(pickerFiltered.map((a) => a.id)));
    const pickerSliceIds = (dir: "first" | "last") => {
        const n = Math.max(0, Math.min(pickerFiltered.length, Math.floor(Number(pickerTakeN) || 0)));
        if (!n) return [];
        const rows = dir === "first" ? pickerFiltered.slice(0, n) : pickerFiltered.slice(-n);
        return rows.map((a) => a.id);
    };
    const pickerSelectSlice = (dir: "first" | "last") => {
        const ids = pickerSliceIds(dir);
        if (!ids.length) { toast("请先填有效的 N，且当前列表不能为空"); return; }
        setPickerSel(new Set(ids));
        toast(`已勾选${dir === "first" ? "前" : "后"} ${ids.length} 个`);
    };

    const doAddToQueue = async (ids?: number[]) => {
        const pick = ids && ids.length ? ids : [...pickerSel];
        if (!pick.length) return;
        const grp = resolvedEnqueueGrp();
        const groupSource = rechargeGrpNew.trim() || rechargeBatch.trim()
            ? "手工指定充值分组"
            : grp ? "继承账号来源批次" : "未设置充值分组";
        if (!confirm(`确认将 ${pick.length} 个账号加入充值队列?\n充值/交付分组：${grp || "（无分组）"}\n分组来源：${groupSource}\n这些账号将在 GPT 面板中标记为已售出。`)) return;
        setBusy(true); setShowPicker(false);
        try {
            const r = await api.addToRechargeQueue(pick, grp);
            toast(`已入队 ${r.added} 个账号${grp ? ` · 分组 ${grp}` : ""}`);
            setDeliveryTab("undelivered");
            loadQueue();
        } catch (e: any) { toast("入队失败: " + e.message); } finally { setBusy(false); }
    };

    /** 标记已交付：从作业队列移到「已交付」tab，保留账号与换绑记录 */
    const doRemoveFromQueue = async () => {
        const ids = selQIds();
        if (!ids.length) return;
        if (!confirm(`确认将选中项里「已充上」的号标记为已交付？\n失败 / 退回 / 待提交的不会搬走。\n这些号用掉的卡密会从卡密池移除（卡号仍留在队列记录里可查）。`)) return;
        try {
            const r = await api.deliverRechargeQueue(ids);
            setQSel(new Set());
            const skip = r.skipped ? `，跳过 ${r.skipped} 个未成功` : "";
            const cards = r.cardsRemoved ? `，卡密池移除 ${r.cardsRemoved} 张已用卡` : "";
            toast(r.count ? `已交付 ${r.count} 个${skip}${cards}` : (r.skipped ? "所选都还没充上，没有搬走" : "没有可交付的"));
            loadQueue();
            loadCards();
        } catch (e: any) { toast("标记已交付失败: " + e.message); }
    };

    /** 已交付 → 退回可交付 */
    const doUndeliver = async () => {
        const ids = selQIds();
        if (!ids.length) return;
        if (!confirm(`确认将 ${ids.length} 个账号退回可交付？\n充值已完成的账号会回到「可交付」列表，不会重新进入作业中。`)) return;
        try {
            const r = await api.undeliverRechargeQueue(ids);
            setQSel(new Set()); loadQueue(); toast(`已退回可交付 ${r.count ?? ids.length} 个`);
        } catch (e: any) { toast("退回可交付失败: " + e.message); }
    };

    const doSetBatch = async () => {
        const ids = selQIds();
        if (!ids.length) { toast("请先选择队列项"); return; }
        try {
            await api.setRechargeQueueBatch(ids, batchInput);
            setShowSetBatch(false); loadQueue(); toast("充值/交付分组已设置");
        } catch (e: any) { toast("设置失败: " + e.message); }
    };

    const doSubmit = async (ids: number[]) => {
        if (!ids.length) { toast("请先选择待提交项"); return; }
        const pendingIds = ids.filter((id) => { const q = queue.find((x) => x.id === id); return q && q.status === "pending"; });
        if (!pendingIds.length) { toast("所选项中无待提交状态的账号"); return; }
        if (cStats.unused < pendingIds.length) { toast(`可用卡密不足(需 ${pendingIds.length} 个,仅有 ${cStats.unused} 个)`); return; }
        if (!confirm(`确认提交 ${pendingIds.length} 个账号充值?\n预检并发：Gmail 探 IMAP，mail.com 验密码。通过一个就立刻配卡提交，不通的不配卡。`)) return;
        setBusy(true);
        try {
            await api.submitRecharge(pendingIds);
            setTrackedOperation({kind: "submit", label: "充值提交", ids: pendingIds, total: pendingIds.length, skipped: 0, startedAt: Date.now()});
            setJobSubmit(true);
            toast(`已开始提交 ${pendingIds.length} 个充值任务`);
        } catch (e: any) { toast("提交失败: " + e.message); } finally { setBusy(false); }
    };

    const doReset = async () => {
        const ids = selQIds();
        if (!ids.length) { toast("请先选择队列项"); return; }
        try {
            const result = await api.resetRechargeQueue(ids);
            setQSel(new Set());
            loadQueue();
            loadCards();
            toast(`已重置 ${result.reset ?? 0} 项${result.skipped ? `，跳过 ${result.skipped} 项（保留待核对）` : ""}`);
        } catch (e: any) { toast(e.message); }
    };
    const doMarkError = async (ids?: number[]) => {
        const pick = ids && ids.length ? ids : selQIds();
        if (!pick.length) { toast("请先选择要标记的账号"); return; }
        const typed = window.prompt(`把选中 ${pick.length} 个标为失败，立刻移入「失败」页\n卡密放回未使用，可换号再提；已充上的不动\n原因：`, "人工标记失败");
        if (typed == null) return;
        const reason = typed.trim() || "人工标记失败";
        try {
            const r = await api.markRechargeQueueError(pick, reason);
            setQSel(new Set());
            loadQueue();
            toast(r.count ? `已标失败 ${r.count} 个，已移入失败页${r.reclaimed ? `，收回卡密 ${r.reclaimed}` : ""}${r.skipped ? `，跳过 ${r.skipped} 个已充上` : ""}` : (r.skipped ? "所选都已充上，不能改标失败" : "没有可标记的"));
        } catch (e: any) { toast(e.message); }
    };
    const doStop = async () => { try { await api.stopRecharge(); toast("已请求停止提交"); } catch (e: any) { toast(e.message); } };
    const doRecover = async () => {
        const ids = selQIds();
        if (!ids.length) { toast("请先选择要恢复的队列项"); return; }
        const picked = queue.filter((item) => ids.includes(item.id));
        const leased = picked.filter((item) => item.instance_id || item.rebind_instance).length;
        if (!confirm(
            `人工恢复选中的 ${ids.length} 项${leased ? `（检测到租约 ${leased} 项）` : ""}？\n`
            + "paired 会在队列与卡密状态一致时安全解配；submitting/submitted 不会回退，恢复后请点“刷新状态”；换绑停在 verify 会转为“待核对”。",
        )) return;
        setBusy(true);
        try {
            const result = await api.recoverRecharge(ids);
            toast(`恢复完成：租约 ${result.rechargeLeases}，解配 ${result.pairedReset}，保留待对账 ${result.preserved}，换绑租约 ${result.rebindLeases}${result.rebindUnknown ? `，待核对 ${result.rebindUnknown}` : ""}${result.review ? `，需人工检查 ${result.review}` : ""}${result.activeSkipped ? `，跳过其他活实例 ${result.activeSkipped}` : ""}`);
            loadQueue();
            loadCards();
        } catch (e: any) {
            toast(e.message);
        } finally {
            setBusy(false);
        }
    };
    const doRelogin = async () => {
        const ids = selQIds();
        if (!ids.length) { toast("请先选择队列项"); return; }
        if (!confirm(`确认对 ${ids.length} 个账号「重新登录并提交」？\n任务会进入分布式队列，由各实例按并发自动分片执行。\n会重新登录、查卡密、用原卡密再提；卡密若已被消费会跳过，避免重复扣卡。`)) return;
        try {
            const r = await api.rechargeQueueReloginSubmit(ids);
            setTrackedOperation({kind: "reloginSubmit", label: "重登提交", ids, total: (r.claimed ?? ids.length) + (r.skipped ?? 0), skipped: r.skipped ?? 0, startedAt: Date.now()});
            setJobReloginSubmit(true);
            toast(`已入队重新登录并提交 ${r.claimed ?? r.count} 个${r.skipped ? `，跳过 ${r.skipped} 个` : ""}，各实例会自动分片执行`);
        } catch (e: any) { toast(e.message); }
    };
    const doStopRelogin = async () => { try { await api.stopRechargeQueueRelogin(); toast("已请求停止重新提交"); } catch (e: any) { toast(e.message); } };
    const doReclaimCards = async () => {
        const ids = selQIds();
        if (!ids.length) { toast("请先选择队列项"); return; }
        try {
            const r = await api.reclaimCards(ids);
            toast(`回收卡密: 回收 ${r.reclaimed} / 已消费 ${r.used} / 失败 ${r.failed}`);
            loadQueue();
        } catch (e: any) { toast(e.message); }
    };
    const doPoll = async () => {
        const selected = selQIds();
        const pollable = selected.filter((id) => {
            const q = queue.find((x) => x.id === id);
            return q && q.card_code && q.status !== "done";
        });
        if (selected.length && !pollable.length) {
            const q = queue.find((x) => selected.includes(x.id));
            loadQueue();
            toast(q && !q.card_code ? `${q.email} 仍是待提交、没有卡密，刷新不到平台状态` : "选中项无需刷新");
            return;
        }
        setBusy(true);
        try {
            const r = await api.pollRecharge(selected.length ? pollable : undefined);
            toast(`已刷新 ${r.updated} 个任务状态`);
        } catch (e: any) {
            toast(e.message);
        } finally {
            loadQueue();
            setBusy(false);
        }
    };
    const doSetRebindAfterPaid = async (v: "off" | "gmail" | "mailcom") => {
        const prev = configRebindAfterPaid;
        setConfigRebindAfterPaid(v);
        try {
            const r = await api.setRechargeConfig({rebindAfterPaid: v});
            applyRebindCounts(r);
            toast(v === "off" ? "已关闭：付费后不换绑" : v === "mailcom" ? "已开启：付费后换绑 mail.com" : "已开启：付费后换绑 Gmail");
        } catch (e: any) {
            setConfigRebindAfterPaid(prev);
            toast("换绑选项保存失败: " + e.message);
        }
    };
    const loadRebindPool = async () => {
        const r = await api.rebindGmailPool();
        const next = {
            poolGrp: r.poolGrp || "换绑池",
            staging: r.staging || [],
            ready: r.ready || [],
            groups: r.groups || [],
            stagingCount: r.stagingCount ?? (r.staging || []).length,
            readyCount: r.readyCount ?? (r.ready || []).length,
        };
        setRebindPool(next);
        return next;
    };
    /**
     * 打开换绑 Gmail 弹窗。
     * - 可不勾选充值队列：只管理验证区 / 迁入换绑池（独立 Gmail，不需要 GPT 队列项）
     * - 勾选了已付费队列项：可同时「确认换绑」把池里的 Gmail 绑到这些号上
     * - 已交付页签：允许人工补做 Gmail 换绑，不改变交付状态
     */
    const openRebindGmail = async (ids?: number[]) => {
        const pick = ids && ids.length ? ids : selQIds();
        setRebindIds(pick);
        setStagePick(new Set());
        setReadyPick(new Set());
        setStageSearch("");
        setReadySearch("");
        setShowRebindGmail(true);
        try {
            const {groups} = await loadRebindPool();
            const top = [...groups].sort((a, b) => (b.n || 0) - (a.n || 0))[0];
            setStageGrp(top ? top.grp : "");
            if (!pick.length) {
                toast("已打开 Gmail 换绑池：可先迁入独立号；要对队列换绑请先勾选已付费项再点「确认换绑」");
            }
        } catch (e: any) {
            toast("加载 Gmail 池失败: " + e.message);
        }
    };
    const submitRebind = async (target: "gmail" | "mailcom", opts?: {emails?: string[]; grp?: string; text?: string}) => {
        const ids = target === "gmail" && rebindIds.length ? rebindIds : selQIds();
        if (!ids.length) { toast("请先在充值队列勾选要换绑的已付费项"); return; }
        const label = target === "mailcom" ? "mail.com" : "Gmail";
        setBusy(true);
        try {
            const r = await api.rebindGmail(ids, target, {
                ...(opts || {}),
                ...(target === "gmail" && isDeliveredTab ? {allowDelivered: true} : {}),
            });
            setTrackedOperation({kind: "rebind", label: `换绑 ${label}`, ids, total: ids.length, skipped: (r.skipped || []).length, startedAt: Date.now()});
            applyRebindCounts(r);
            const skip = (r.skipped || []).map((s) => `${s.email}: ${s.reason}`).join("；");
            toast(`换绑 ${label} 已排队 ${r.queued} 个${skip ? `，跳过 ${r.skipped.length}（${skip}）` : ""}`);
            loadQueue();
            setShowRebindGmail(false);
        } catch (e: any) { toast(e.message); } finally { setBusy(false); }
    };
    const doRebind = async (target: "gmail" | "mailcom") => {
        // Gmail：始终可开池子管理；是否执行换绑看 rebindIds
        if (target === "gmail") return openRebindGmail();
        const ids = selQIds();
        if (!ids.length) { toast("请先选择已付费的队列项"); return; }
        if (!confirm(`对选中的 ${ids.length} 项换绑 mail.com？\n只处理已付费(paid)的号，自动领取空闲 mail.com。换完旧邮箱标已售，不返还。`)) return;
        await submitRebind("mailcom");
    };
    const formatRebindCredLine = (m: RebindGmailPoolItem) =>
        [m.email, m.password || "", m.totp_secret || "", m.imap_password || ""].join("----");
    const copyRebindCreds = async (rows: RebindGmailPoolItem[], label: string) => {
        if (!rows.length) { toast("没有可复制的邮箱"); return; }
        const text = rows.map(formatRebindCredLine).join("\n");
        try {
            await navigator.clipboard.writeText(text);
            toast(`已复制 ${rows.length} 条${label}（邮箱----密码----TOTP----IMAP）`);
        } catch {
            downloadText(text, "rebind-gmail-creds.txt");
            toast(`已下载 ${rows.length} 条账密（剪贴板不可用）`);
        }
    };
    const refreshStageGrp = (groups: {grp: string; n: number}[], staging: RebindGmailPoolItem[]) => {
        if (staging.some((m) => (m.grp || "") === stageGrp)) return;
        const top = [...groups].sort((a, b) => (b.n || 0) - (a.n || 0))[0];
        setStageGrp(top ? top.grp : "");
    };
    const doMarkUnavailable = async (ids: number[]) => {
        if (!ids.length) { toast("请先勾选邮箱"); return; }
        if (!confirm(`将 ${ids.length} 个标记为「登录不可用」并踢出池？\n（标已售 + login_fail）`)) return;
        setBusy(true);
        try {
            const r = await api.markRebindGmailUnavailable(ids, "登录不可用");
            applyRebindCounts(r);
            toast(`已标记不可用 ${r.count} 个`);
            setStagePick(new Set());
            setReadyPick(new Set());
            const next = await loadRebindPool();
            refreshStageGrp(next.groups, next.staging);
        } catch (e: any) {
            toast("标记失败: " + (e?.message || e));
        } finally {
            setBusy(false);
        }
    };
    /** 验证通过 → 批量迁入换绑池（IMAP 通的立刻入池，慢号不挡已通过的） */
    const doMigrateToReady = async (ids: number[]) => {
        if (!ids.length) { toast("请先勾选验证通过的邮箱"); return; }
        if (!confirm(`将 ${ids.length} 个迁入「${rebindPool.poolGrp}」？\n最低准则：有 2FA + 有 IMAP。\n服务端并行探 IMAP，通的立刻入池；不通的拒绝/标废。\n慢号不会拖住已通过的号。`)) return;
        setBusy(true);
        // 边迁边刷：服务端是通了就改 grp，前端轮询才能看见右侧换绑池增长
        let pollTimer: ReturnType<typeof setInterval> | null = null;
        const stopPoll = () => {
            if (pollTimer != null) {
                clearInterval(pollTimer);
                pollTimer = null;
            }
        };
        pollTimer = setInterval(() => {
            loadRebindPool().then((next) => refreshStageGrp(next.groups, next.staging)).catch(() => {});
        }, 1500);
        try {
            const r = await api.migrateToRebindGmailPool(ids, {concurrency: configRebindConcurrency});
            applyRebindCounts(r);
            const rej = r.skipped?.length || 0;
            toast(rej
                ? `迁入 ${r.count} 个，拒绝 ${rej}（${(r.skipped || []).slice(0, 3).map((s) => `${s.email || s.id}:${s.reason}`).join("；")}）`
                : `已迁入换绑池 ${r.count} 个`);
            setStagePick(new Set());
            setReadyPick(new Set());
        } catch (e: any) {
            // 部分号可能已入池（边探边迁），仍提示并刷新
            toast("迁入中断: " + (e?.message || e) + "（已成功的会留在换绑池，请看右侧）");
        } finally {
            stopPoll();
            try {
                const next = await loadRebindPool();
                refreshStageGrp(next.groups, next.staging);
            } catch { /* 最终刷新失败不挡 toast */ }
            setBusy(false);
        }
    };
    /** 从换绑池移回验证区 */
    const doDemoteFromReady = async (ids: number[]) => {
        if (!ids.length) { toast("请先勾选换绑池中的邮箱"); return; }
        if (!confirm(`将 ${ids.length} 个移出「${rebindPool.poolGrp}」回到验证区？`)) return;
        setBusy(true);
        try {
            const r = await api.demoteFromRebindGmailPool(ids, stageGrp || "");
            applyRebindCounts(r);
            toast(`已移出换绑池 ${r.count} 个`);
            setReadyPick(new Set());
            await loadRebindPool();
        } catch (e: any) {
            toast("移出失败: " + (e?.message || e));
        } finally {
            setBusy(false);
        }
    };
    const doConfirmRebindGmail = async () => {
        // 仅「确认换绑」需要充值队列目标号；迁入换绑池不需要
        if (!rebindIds.length) { toast("请先在充值队列勾选要换绑的已付费项"); return; }
        if (!rebindPool.readyCount) {
            toast(`换绑池「${rebindPool.poolGrp}」为空，请先在左侧验证并迁入`);
            return;
        }
        if (readyPick.size > 0) {
            const emails = rebindPool.ready.filter((m) => readyPick.has(m.id)).map((m) => m.email);
            if (!emails.length) { toast("勾选的邮箱已不在换绑池，请刷新"); return; }
            if (!confirm(`用换绑池勾选的 ${emails.length} 个 Gmail，给 ${rebindIds.length} 个已付费号换绑？`)) return;
            await submitRebind("gmail", {emails});
            return;
        }
        if (!confirm(`从换绑池「${rebindPool.poolGrp}」自动领取（共 ${rebindPool.readyCount} 个），给 ${rebindIds.length} 个已付费号换绑？`)) return;
        await submitRebind("gmail", {grp: rebindPool.poolGrp});
    };
    const stageVisible = useMemo(() => {
        const q = stageSearch.trim().toLowerCase();
        return rebindPool.staging.filter((m) => {
            if ((m.grp || "") !== (stageGrp || "")) return false;
            if (q && !m.email.toLowerCase().includes(q)) return false;
            return true;
        });
    }, [rebindPool.staging, stageGrp, stageSearch]);
    const readyVisible = useMemo(() => {
        const q = readySearch.trim().toLowerCase();
        return rebindPool.ready.filter((m) => {
            if (q && !m.email.toLowerCase().includes(q)) return false;
            return true;
        });
    }, [rebindPool.ready, readySearch]);
    const toggleIdSet = (setter: Dispatch<SetStateAction<Set<number>>>, id: number) => {
        setter((prev) => {
            const n = new Set(prev);
            if (n.has(id)) n.delete(id); else n.add(id);
            return n;
        });
    };
    const selectAllIds = (setter: Dispatch<SetStateAction<Set<number>>>, rows: RebindGmailPoolItem[], allOn: boolean) => {
        setter((prev) => {
            const n = new Set(prev);
            for (const m of rows) {
                if (allOn) n.delete(m.id); else n.add(m.id);
            }
            return n;
        });
    };
    const stageAllSel = stageVisible.length > 0 && stageVisible.every((m) => stagePick.has(m.id));
    const readyAllSel = readyVisible.length > 0 && readyVisible.every((m) => readyPick.has(m.id));

    // 导出
    const downloadText = (text: string, filename: string) => {
        const blob = new Blob([text], {type: "text/plain;charset=utf-8"});
        const url = URL.createObjectURL(blob);
        const a = Object.assign(document.createElement("a"), {href: url, download: filename});
        a.click(); URL.revokeObjectURL(url);
    };
    /** 解析 sub2json 输入行：末段为 RT；≥5 段时 GPT 密码为倒数第 3 段（兼容含 IMAP 的 Gmail 全字段导出） */
    const parseSub2jsonLine = (l: string): {email: string; password: string; rt: string} => {
        for (const sep of ["----", "\t", "|", ";"]) {
            if (!l.includes(sep) && sep !== "\t") continue;
            const p = l.split(sep).map((s) => s.trim());
            while (p.length && p[p.length - 1] === "") p.pop();
            if (p.length < 3) continue;
            const email = p[0];
            const rt = p[p.length - 1];
            // 3 段: email----pw----rt
            // Gmail 新: email----mailPw----2fa----gptPw----gpt2fa----rt
            // 旧含 IMAP: email----mailPw----2fa----imap----gptPw----gpt2fa----rt（≥5 时 GPT 密码=倒数第 3）
            const password = p.length >= 5 ? p[p.length - 3] : p[1];
            if (email && rt) return {email, password: password || "", rt};
        }
        const cp = l.split(":").map((s) => s.trim());
        if (cp.length >= 3) {
            const email = cp[0];
            const rt = cp[cp.length - 1];
            const password = cp.length >= 5 ? cp[cp.length - 3] : cp[1];
            if (email && rt) return {email, password: password || "", rt};
        }
        return {email: "", password: "", rt: ""};
    };
    /** 从勾选队列项（否则当前筛选结果）拉取 email----gpt密码----rt，Gmail 用 gpt_password */
    const fillSub2jsonFromSelection = async (opts?: {silent?: boolean}) => {
        const picked = selQIds();
        const ids = picked.length ? picked : filteredQueue.map((item) => item.id);
        if (!ids.length) {
            if (!opts?.silent) toast("当前筛选没有可填充账号");
            return false;
        }
        try {
            const r = await api.exportRechargeQueue({
                ids,
                format: "sub2json",
            });
            if (!r.text) {
                if (!opts?.silent) toast("无可导出数据");
                return false;
            }
            setSub2jsonInput(r.text);
            setSub2jsonResults([]);
            const miss = r.missingRt || 0;
            const withRt = r.withRt ?? 0;
            const total = r.total ?? r.text.split("\n").filter(Boolean).length;
            if (!opts?.silent) {
                if (miss > 0) toast(`已填充 ${total} 行（有 RT ${withRt}，缺 RT ${miss}；缺 RT 请先「批量获取RT」）`);
                else toast(`已从${picked.length ? `勾选 ${picked.length} 项` : `当前筛选 ${ids.length} 项`}填充 ${total} 行`);
            }
            return true;
        } catch (e: any) {
            if (!opts?.silent) toast("填充失败: " + (e?.message || e));
            return false;
        }
    };
    const openSub2json = async () => {
        setShowSub2json(true);
        setSub2jsonResults([]);
        if (selQIds().length || filteredQueue.length) {
            await fillSub2jsonFromSelection({silent: false});
        }
    };
    const deliverExportText = async (text: string, format: "account" | "full" | "card" | "session") => {
        const lines = text.split("\n").filter((l) => l.trim()).length;
        if (format === "card" || format === "session" || lines < 200) {
            await navigator.clipboard.writeText(text);
            toast(`已复制 ${lines} 行到剪切板`);
        } else {
            const names: Record<string, string> = {account: "recharge-accounts.txt", full: "recharge-full.txt"};
            downloadText(text, names[format] || "recharge-export.txt");
            toast(`已导出 ${lines} 行`);
        }
    };
    deliverExportTextRef.current = deliverExportText;
    const doExportSub2json = async () => {
        const picked = selQIds();
        const ids = picked.length ? picked : filteredQueue.map((q) => q.id);
        if (!ids.length) { toast("请先勾选账号，或当前列表不能为空"); return; }
        const conc = Math.max(1, Math.floor(Number(configRtConcurrency || sub2jsonConc) || 4));
        if (!confirm(`导出 ${ids.length} 个账号的 sub2json？\n缺 RT 的会先按并发 ${conc} 获取，再刷新 token，最后下一个 JSON。`)) return;
        setTrackedOperation({kind: "sub2json", label: "sub2json", ids, total: ids.length, skipped: 0, startedAt: Date.now()});
        setExportRtRunning(true);
        try {
            const r = await api.exportRechargeSub2json({ids, concurrency: conc});
            if (r.async) {
                setExportRtRunning(true);
                void refreshJobs();
                toast(`已开始 ${r.total} 个（缺 RT ${r.needRt || 0}，并发 ${r.concurrency}），完成后自动下载`, 6000);
            } else {
                setExportRtRunning(false);
            }
        } catch (e: any) {
            setExportRtRunning(false);
            setTrackedOperation(null);
            void refreshJobs();
            toast("导出失败: " + (e?.message || e));
        }
    };
    const doExport = async (format: "account" | "full" | "card" | "session", opts?: {relogin?: boolean}) => {
        const picked = selQIds();
        const ids = picked.length ? picked : filteredQueue.map((item) => item.id);
        if (!ids.length) { toast("当前筛选没有可导出账号"); return; }
        if (format === "full" && opts?.relogin && !confirm(`处理 ${ids.length} 个账号：没有 RT 的直接获取，已有 RT 的重新登录获取新 RT，完成后复制结果。\n这会产生新的登录请求，是否继续？`)) return;
        if (format === "full" && ids.length) {
            setTrackedOperation({kind: opts?.relogin ? "reloginRt" : "rtExport", label: opts?.relogin ? "获取 / 刷新 RT" : "获取 RT", ids, total: ids.length, skipped: 0, startedAt: Date.now()});
        }
        setExportRtRunning(true);
        try {
            const r = await api.exportRechargeQueue({
                ids,
                format,
                relogin: !!opts?.relogin,
            });
            if (r.text) {
                if (format === "full") setTrackedOperation(null);
                setExportRtRunning(false);
                await deliverExportText(r.text, format);
            } else if (r.async) {
                if (format === "full") setTrackedOperation((previous) => previous ? {...previous, total: Number(r.needRt || r.total) || previous.total} : previous);
                setExportRtRunning(true);
                void refreshJobs();
                toast(opts?.relogin
                    ? `正在获取 / 刷新 RT（${r.needRt} 个），完成后自动复制/下载`
                    : `${r.needRt} 个账号缺少 RT，正在自动获取，完成后自动复制/下载`, 6000);
            }
        } catch (e: any) {
            setExportRtRunning(false);
            if (format === "full") setTrackedOperation(null);
            void refreshJobs();
            toast("导出失败: " + e.message);
        }
    };
    const openTestSend = async () => {
        let ids = selQIds();
        if (!ids.length) ids = filteredQueue.slice(0, 5).map((q) => q.id);
        setShowTestSend(true);
        setTestSendPreview([]);
        if (!ids.length) {
            setTestSendResult("已交付列表是空的");
            toast("已交付列表是空的");
            return;
        }
        setTestSendResult("正在核对发件账号（换绑号用原邮箱）…");
        setTestSendBusy(true);
        try {
            const r = await api.rechargeSendPreview(ids, testSendTo);
            setTestSendPreview(r.items || []);
            const okN = (r.items || []).filter((x) => x.canSend).length;
            setTestSendResult(okN ? `可发 ${okN} / ${r.items.length}（换绑走原邮箱）` : "这些号现在都发不了，看下表原因");
            toast(okN ? `可发 ${okN} 封，确认后点「发出测试信」` : "看弹窗里的原因（换绑必须用原邮箱）", 6000);
        } catch (e: any) {
            setTestSendResult("预览失败: " + e.message);
            toast("预览失败: " + e.message, 6000);
        } finally { setTestSendBusy(false); }
    };
    const doTestSend = async () => {
        const sendable = testSendPreview.filter((x) => x.canSend);
        if (!sendable.length) {
            toast(testSendPreview[0]?.reason || "没有可发的号", 5000);
            return;
        }
        if (!testSendTo.trim()) { toast("请填写测试收件人"); return; }
        if (!confirm(`确认向 ${testSendTo.trim()} 发送 ${sendable.length} 封测试信？\n换绑号走原 mail.com SMTP 协议。\n任务会后台执行，进度看充值日志。`)) return;
        setTestSendBusy(true);
        setTestSendResult(`已排队 ${sendable.length} 封，后台登录发送中…`);
        toast("已开始发测试信，看充值日志", 6000);
        try {
            const r = await api.rechargeTestSend(sendable.map((x) => x.id), testSendTo.trim());
            if (r.async) {
                setTestSendResult(`已开始 ${r.queued} 封 → ${r.to}（后台跑，当前这封跑完才停）`);
                return;
            }
            const line = `发出 ${r.sent} · 失败 ${r.failed} · 跳过 ${r.skipped} → ${r.to}`;
            setTestSendResult(line);
            toast(r.ok ? `测试邮件已发 ${r.sent} 封` : (r.error || line), 6000);
            setTestSendBusy(false);
        } catch (e: any) {
            setTestSendResult("发送失败: " + e.message);
            toast("测试发送失败: " + e.message, 6000);
            setTestSendBusy(false);
        }
    };
    const doStopTestSend = async () => {
        try {
            const r = await api.stopTestSend();
            toast(r.running ? "已停止测试发信，当前这封跑完就停" : "当前没有发信在跑");
            if (!r.running) setTestSendBusy(false);
        } catch (e: any) { toast(e.message); }
    };
    const doProbePlan = async () => {
        const picked = selQIds();
        const ids = picked.length ? picked : filteredQueue.map((item) => item.id);
        if (!ids.length) { toast("当前筛选没有可查询账号"); return; }
        try {
            const r = await api.probePlan(ids);
            toast(`查询套餐: ${r.count} 个账号`);
        } catch (e: any) { toast("查询失败: " + e.message); }
    };


    // 卡密操作
    const doImport = async () => {
        if (!importText.trim()) return;
        setBusy(true);
        try {
            const r = await api.importRechargeCards(importText, importBatch);
            toast(`导入: 新增 ${r.inserted} / 跳过 ${r.skipped}`);
            setImportText(""); setShowImport(false); loadCards();
        } catch (e: any) { toast("导入失败: " + e.message); } finally { setBusy(false); }
    };
    const doDeleteCards = async () => {
        const ids = [...cSel].filter((id) => cards.some((c) => c.id === id));
        if (!ids.length) return;
        if (!confirm(`删除 ${ids.length} 个卡密?`)) return;
        try { await api.deleteRechargeCards(ids); setCSel(new Set()); loadCards(); toast("已删除"); } catch (e: any) { toast(e.message); }
    };
    const doValidate = async () => {
        const ids = [...cSel].filter((id) => cards.some((c) => c.id === id));
        if (!ids.length) { toast("请先选择卡密"); return; }
        try { await api.validateRechargeCards(ids); toast(`开始验证 ${ids.length} 个卡密`); } catch (e: any) { toast(e.message); }
    };
    const doResetCards = async () => {
        const ids = [...cSel].filter((id) => cards.some((c) => c.id === id));
        if (!ids.length) { toast("请先选择卡密"); return; }
        try { await api.resetRechargeCards(ids); toast(`开始重置 ${ids.length} 张卡密（问平台后放回未使用）`); } catch (e: any) { toast(e.message); }
    };

    const Btn = ({onClick, disabled, className, title, children}: any) => (
        <button onClick={onClick} disabled={disabled || busy} title={title}
                className={`px-3 py-1.5 rounded text-xs font-medium border transition disabled:opacity-40 ${className || "bg-white border-gray-200 text-gray-700 hover:bg-gray-50"}`}>
            {children}
        </button>
    );

    return (
        <div className="flex-1 overflow-auto p-6 space-y-4">
            {/* 标题 */}
            <div className="flex items-center gap-3 flex-wrap">
                <h2 className="text-lg font-bold">💳 充值提交</h2>
                {instanceId && <span className="text-xs text-gray-400 font-mono" title="本机实例 ID，重登/提交由点按钮的这台跑">本机 {instanceId}</span>}
                <Btn onClick={() => { setShowConfig(!showConfig); if (!showConfig) loadConfig(); }}>
                    {showConfig ? "收起配置" : "⚙ API 配置"}
                </Btn>
                <label className="inline-flex items-center gap-1.5 text-xs text-gray-600 select-none px-2 py-1 rounded border border-gray-200 bg-white">
                    付费后换绑
                    <select value={configRebindAfterPaid} onChange={(e) => doSetRebindAfterPaid(e.target.value as "off" | "gmail" | "mailcom")}
                            className="text-xs border-0 bg-transparent outline-none font-medium text-gray-800">
                        <option value="off">关闭</option>
                        <option value="gmail">Gmail</option>
                        <option value="mailcom">mail.com</option>
                    </select>
                </label>
                <span className={`text-xs px-2 py-0.5 rounded ${gmailFreeImap > 0 ? "text-blue-600 bg-blue-50" : "text-amber-600 bg-amber-50"}`} title="只取邮箱管理里独立、未售、未挂 GPT/Claude、已开 IMAP 的 Gmail">
                    可换绑 Gmail {gmailFreeImap}
                </span>
                <span className={`text-xs px-2 py-0.5 rounded ${mailcomFree > 0 ? "text-blue-600 bg-blue-50" : "text-amber-600 bg-amber-50"}`} title="只取邮箱管理里独立、未售、未挂 GPT/Claude 的 mail.com">
                    可换绑 mail.com {mailcomFree}
                </span>
                {!hasKey && <span className="text-xs text-amber-600 bg-amber-50 px-2 py-0.5 rounded">未配置 API Key</span>}
            </div>

            {trackedProgress && (
                <div className="bg-white rounded-lg border border-blue-100 shadow-sm px-4 py-3 space-y-2" aria-live="polite">
                    <div className="flex items-center justify-between gap-3 flex-wrap">
                        <div className="flex items-center gap-2">
                            <span className={`h-2.5 w-2.5 rounded-full ${trackedProgress.active ? "bg-blue-500 animate-pulse" : "bg-emerald-500"}`}/>
                            <span className="font-semibold text-sm text-gray-800">{trackedProgress.label}</span>
                            <span className="text-xs text-gray-500">{trackedProgress.active ? "进行中" : "已结束"}</span>
                        </div>
                        <span className="text-lg font-bold tabular-nums text-gray-800">{trackedProgress.done} / {trackedProgress.total}</span>
                    </div>
                    <div className="h-3 rounded-full bg-gray-100 overflow-hidden" role="progressbar" aria-valuemin={0} aria-valuemax={trackedProgress.total} aria-valuenow={trackedProgress.done}>
                        <div className={`h-full transition-all ${trackedProgress.failed ? "bg-gradient-to-r from-blue-500 to-amber-400" : "bg-blue-500"}`} style={{width: `${trackedProgress.percent}%`}}/>
                    </div>
                    <div className="flex flex-wrap gap-x-5 gap-y-1 text-xs tabular-nums">
                        <span className="text-green-700">成功 {trackedProgress.success}</span>
                        <span className="text-red-600">失败 {trackedProgress.failed}</span>
                        <span className="text-gray-500">进行中 {trackedProgress.waiting}</span>
                        <span className="text-gray-400">{trackedProgress.percent}%</span>
                    </div>
                </div>
            )}

            {/* 配置区 */}
            {showConfig && (
                <div className="bg-white rounded-lg border p-4 space-y-3 shadow-sm">
                    <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
                        <label className="block"><span className="text-xs text-gray-500 mb-1 block">Base URL</span>
                            <input value={configBase} onChange={(e) => setConfigBase(e.target.value)} placeholder="https://xxx.com/api/open/v1"
                                   className="w-full px-2 py-1.5 text-sm border rounded outline-none"/></label>
                        <label className="block"><span className="text-xs text-gray-500 mb-1 block">App ID</span>
                            <input value={configAppId} onChange={(e) => setConfigAppId(e.target.value)} placeholder="ak_xxxxxxxx"
                                   className="w-full px-2 py-1.5 text-sm border rounded outline-none font-mono"/></label>
                        <label className="block"><span className="text-xs text-gray-500 mb-1 block">API Key</span>
                            <input value={configKey} onChange={(e) => setConfigKey(e.target.value)} placeholder="sk_xxxx..."
                                   className="w-full px-2 py-1.5 text-sm border rounded outline-none font-mono"/></label>
                        <label className="block"><span className="text-xs text-gray-500 mb-1 block">Forward IP (可选)</span>
                            <input value={configIp} onChange={(e) => setConfigIp(e.target.value)} placeholder="留空则用直连 IP"
                                   className="w-full px-2 py-1.5 text-sm border rounded outline-none"/></label>
                        <label className="block"><span className="text-xs text-gray-500 mb-1 block">提交间隔 (秒)</span>
                            <input type="number" value={configInterval} onChange={(e) => setConfigInterval(Math.max(0, Math.min(60, Number(e.target.value) || 3)))}
                                   min={0} max={60} className="w-full px-2 py-1.5 text-sm border rounded outline-none"/></label>
                        <label className="block"><span className="text-xs text-gray-500 mb-1 block">充值代理 (重登/RT，空=用注册代理)</span>
                            <input value={configRtProxy} onChange={(e) => setConfigRtProxy(e.target.value)}
                                   placeholder="socks5://... 或留空"
                                   className="w-full px-2 py-1.5 text-sm border rounded outline-none font-mono"/></label>
                        <label className="block"><span className="text-xs text-gray-500 mb-1 block">充值提交并发数</span>
                            <input type="number" value={configConcurrency} onChange={(e) => setConfigConcurrency(Math.max(1, Math.floor(Number(e.target.value) || 3)))}
                                   min={1} className="w-full px-2 py-1.5 text-sm border rounded outline-none"/></label>
                        <label className="block"><span className="text-xs text-gray-500 mb-1 block">Gmail 换绑并发数</span>
                            <input type="number" value={configRebindConcurrency} onChange={(e) => setConfigRebindConcurrency(Math.max(1, Math.floor(Number(e.target.value) || 3)))}
                                   min={1} className="w-full px-2 py-1.5 text-sm border rounded outline-none"/></label>
                        <label className="block"><span className="text-xs text-gray-500 mb-1 block">RT 并发数</span>
                            <input type="number" value={configRtConcurrency} onChange={(e) => setConfigRtConcurrency(Math.max(1, Math.floor(Number(e.target.value) || 4)))}
                                   min={1} className="w-full px-2 py-1.5 text-sm border rounded outline-none"/></label>
                        <label className="block col-span-2">
                            <span className="text-xs text-gray-500 mb-1 block">平台回 paid 后换绑（不在点提交时换；旧邮箱标已售、不返还）</span>
                            <select value={configRebindAfterPaid} onChange={(e) => setConfigRebindAfterPaid(e.target.value as "off" | "gmail" | "mailcom")}
                                    className="px-2 py-1.5 text-sm border rounded outline-none">
                                <option value="off">关闭</option>
                                <option value="gmail">换绑空闲 Gmail（需已开 IMAP）</option>
                                <option value="mailcom">换绑空闲 mail.com</option>
                            </select>
                        </label>
                        <label className="flex items-center gap-2 col-span-2 text-xs text-gray-600">
                            <input type="checkbox" checked={configRebindGmailProbeLogin}
                                   onChange={(e) => setConfigRebindGmailProbeLogin(e.target.checked)}/>
                            <span>
                                Gmail 换绑前开启比特网页登录探活
                                <span className="block text-[11px] text-gray-400">关闭时只依赖迁入换绑池时的 IMAP 校验，推荐关闭</span>
                            </span>
                        </label>
                    </div>
                    <div className="flex justify-end">
                        <Btn onClick={doSaveConfig} className="bg-blue-600 text-white border-blue-600 hover:bg-blue-700">保存配置</Btn>
                    </div>
                </div>
            )}

            {/* ====== 充值队列(核心) ====== */}
            <div className="bg-white rounded-lg border shadow-sm">
                {/* 未交付 / 已交付 Tab */}
                <div className="px-4 pt-3 flex items-center gap-1 border-b">
                    <button
                        type="button"
                        onClick={() => setDeliveryTab("undelivered")}
                        className={`px-3 py-2 text-sm font-medium border-b-2 -mb-px transition-colors ${
                            isWorkingTab
                                ? "border-blue-600 text-blue-700"
                                : "border-transparent text-gray-500 hover:text-gray-800"
                        }`}
                    >
                        未交付
                        <span className={`ml-1.5 text-xs tabular-nums ${isWorkingTab ? "text-blue-600" : "text-gray-400"}`}>
                            {qStats.working ?? Math.max(0, (qStats.undelivered ?? qStats.total) - (qStats.ready ?? qStats.done ?? 0))}
                        </span>
                    </button>
                    <button
                        type="button"
                        onClick={() => setDeliveryTab("ready")}
                        className={`px-3 py-2 text-sm font-medium border-b-2 -mb-px transition-colors ${
                            isReadyTab
                                ? "border-amber-500 text-amber-700"
                                : "border-transparent text-gray-500 hover:text-gray-800"
                        }`}
                    >
                        可交付
                        <span className={`ml-1.5 text-xs tabular-nums ${isReadyTab ? "text-amber-600" : "text-gray-400"}`}>
                            {qStats.ready ?? qStats.done ?? 0}
                        </span>
                    </button>
                    <button
                        type="button"
                        onClick={() => setDeliveryTab("error")}
                        className={`px-3 py-2 text-sm font-medium border-b-2 -mb-px transition-colors ${
                            isFailedTab
                                ? "border-red-600 text-red-700"
                                : "border-transparent text-gray-500 hover:text-gray-800"
                        }`}
                    >
                        失败
                        <span className={`ml-1.5 text-xs tabular-nums ${isFailedTab ? "text-red-600" : "text-gray-400"}`}>
                            {qStats.failed ?? qStats.error ?? 0}
                        </span>
                    </button>
                    <button
                        type="button"
                        onClick={() => setDeliveryTab("delivered")}
                        className={`px-3 py-2 text-sm font-medium border-b-2 -mb-px transition-colors ${
                            isDeliveredTab
                                ? "border-emerald-600 text-emerald-700"
                                : "border-transparent text-gray-500 hover:text-gray-800"
                        }`}
                    >
                        已交付
                        <span className={`ml-1.5 text-xs tabular-nums ${isDeliveredTab ? "text-emerald-600" : "text-gray-400"}`}>
                            {qStats.delivered ?? 0}
                        </span>
                    </button>
                    <div className="flex-1"/>
                    <span className="text-[11px] text-gray-400 pb-2 pr-1">
                        {isDeliveredTab ? "已交付可按分组筛选、测试发信，也可一条龙导出 sub2json"
                            : isReadyTab ? "充值完成、尚未交付；点「标记已交付」后进已交付"
                            : isFailedTab ? "只有点过「标记失败」的号；提交失败不会自动进来"
                            : "作业中；完成后会进「可交付」"}
                    </span>
                </div>

                <div className="px-4 py-3 border-b flex items-center gap-2 flex-wrap">
                    <span className="text-sm font-semibold">{isDeliveredTab ? "已交付列表" : isReadyTab ? "可交付列表" : isFailedTab ? "失败列表" : "充值队列"}</span>
                    <Btn onClick={() => { setShowSetBatch(true); setBatchInput(""); }} title="对当前页签选中的充值提交账号重新设置充值/交付分组">
                        设置分组
                    </Btn>
                    {isWorkingTab && (
                        <>
                            <Btn onClick={openPicker} className="bg-blue-600 text-white border-blue-600 hover:bg-blue-700">+ 选择账号入队</Btn>
                            <Btn onClick={doReset}>重置</Btn>
                            <Btn onClick={() => doMarkError()} className="bg-white border-red-200 text-red-600 hover:bg-red-50" title="号进失败页，卡密放回未使用，方便换号再提；已充上的不动">标记失败</Btn>
                            <Btn onClick={doReclaimCards}>回收卡密</Btn>
                            <div className="border-l mx-1 h-5"/>
                            <span className="text-xs text-gray-500 tabular-nums">已选 <b className="text-blue-600">{selQIds().length}</b> / {filteredQueue.length}</span>
                            <Btn onClick={() => doSubmit(selQIds())} disabled={!hasKey || cStats.unused === 0 || jobSubmit || jobReloginSubmit} className="bg-green-600 text-white border-green-600 hover:bg-green-700">提交选中 ({selQIds().length})</Btn>
                            <Btn onClick={() => doSubmit(filteredQueue.filter((q) => q.status === "pending").map((q) => q.id))} disabled={!hasKey || cStats.unused === 0 || jobSubmit || jobReloginSubmit}>全部提交 ({filteredQueue.filter((q) => q.status === "pending").length})</Btn>
                            {jobSubmit && (
                                <Btn onClick={doStop} className="bg-white border-red-200 text-red-600 hover:bg-red-50 animate-pulse" title="只停当前这批充值提交，不影响重新登录并提交">停止提交</Btn>
                            )}
                            <Btn onClick={doRecover} disabled={!selQIds().length || jobSubmit || jobReloginSubmit || exportRtRunning}
                                 title="人工释放崩溃残留租约；不会把可能已提交的平台任务退回重提">恢复残留</Btn>
                            <Btn onClick={doPoll}>刷新状态</Btn>
                            <Btn
                                onClick={() => doRebind("gmail")}
                                title={configRebindGmailProbeLogin
                                    ? "对已付费项换绑 Gmail（mail.com→Gmail 或 Gmail→Gmail 均可）；验证 IMAP 后额外探网页登录"
                                    : "对已付费项换绑 Gmail（mail.com→Gmail 或 Gmail→Gmail 均可）；仅验证 IMAP，不探网页登录"}
                            >换绑 Gmail</Btn>
                            <Btn onClick={() => doRebind("mailcom")} title="对已付费项手动换绑 mail.com；旧邮箱标已售">换绑 mail.com</Btn>
                            <Btn onClick={doRelogin} disabled={jobReloginSubmit || jobSubmit} title="重新登录后验卡，再用原卡密提交。卡密已消费会跳过。" className="bg-amber-500 text-white border-amber-500 hover:bg-amber-600">重新登录并提交</Btn>
                            {jobReloginSubmit && (
                                <Btn onClick={doStopRelogin} className="bg-white border-red-200 text-red-600 hover:bg-red-50 animate-pulse" title="只停重新登录并提交，不影响普通提交">停止重新提交</Btn>
                            )}
                            <div className="border-l mx-1 h-5"/>
                        </>
                    )}
                    {isFailedTab && (
                        <>
                            <Btn onClick={doReset} title="退回未交付，重新待提交">重置回队列</Btn>
                            <Btn onClick={doReclaimCards}>回收卡密</Btn>
                            <div className="border-l mx-1 h-5"/>
                        </>
                    )}
                    {isReadyTab && (
                        <>
                            <Btn onClick={doRemoveFromQueue} className="bg-emerald-600 text-white border-emerald-600 hover:bg-emerald-700" title="标记已交付：保留账号与换绑记录，移入「已交付」">标记已交付</Btn>
                            <Btn onClick={() => doRebind("gmail")} title="对已付费项换绑 Gmail">换绑 Gmail</Btn>
                            <Btn onClick={() => doRebind("mailcom")}>换绑 mail.com</Btn>
                            <span className="text-xs text-gray-500 tabular-nums">已选 <b className="text-amber-600">{selQIds().length}</b> / {filteredQueue.length}</span>
                            <div className="border-l mx-1 h-5"/>
                        </>
                    )}
                    {isDeliveredTab && (
                        <>
                            <Btn onClick={doUndeliver} title="将已交付记录退回「可交付」列表，不重新进入作业中" className="bg-white border-blue-200 text-blue-700 hover:bg-blue-50">退回可交付</Btn>
                            <Btn onClick={() => doRebind("gmail")} title="对已交付且已支付项人工换绑 Gmail">换绑 Gmail</Btn>
                            <button type="button" onClick={() => { void openTestSend(); }}
                                    className="px-3 py-1.5 rounded text-xs font-medium border bg-violet-600 text-white border-violet-600 hover:bg-violet-700">
                                测试发送（原邮箱）
                            </button>
                            <span className="text-xs text-gray-500 tabular-nums">已选 <b className="text-emerald-600">{selQIds().length}</b> / {filteredQueue.length}</span>
                            <Btn onClick={doExportSub2json} disabled={exportRtRunning} className="bg-violet-600 text-white border-violet-600 hover:bg-violet-700" title="缺 RT 先按并发获取，再刷新 token，导出一个 sub2api JSON">
                                导出 sub2json
                            </Btn>
                            <label className="inline-flex items-center gap-1 text-xs text-gray-500" title="读充值配置里的 RT 并发数">
                                并发
                                <input type="number" min={1} value={configRtConcurrency}
                                       onChange={(e) => setConfigRtConcurrency(Math.max(1, Math.floor(Number(e.target.value) || 4)))}
                                       className="w-20 px-1 py-0.5 border rounded text-xs outline-none"/>
                            </label>
                            <div className="border-l mx-1 h-5"/>
                        </>
                    )}
                    <div ref={exportMenuRef} className="relative">
                        <Btn onClick={() => setShowExportMenu((v) => !v)} title="导出账号数据、卡密或 session">导出 ▾</Btn>
                        {showExportMenu && (
                            <div className="absolute left-0 top-full mt-1 z-20 min-w-[200px] rounded-lg border border-gray-200 bg-white shadow-lg py-1 text-xs">
                                <button type="button" className="block w-full text-left px-3 py-1.5 hover:bg-gray-50" onClick={() => { setShowExportMenu(false); void doExport("account"); }}>账密</button>
                                <button type="button" className="block w-full text-left px-3 py-1.5 hover:bg-gray-50" onClick={() => { setShowExportMenu(false); void doExport("card"); }}>复制卡密</button>
                                <button type="button" className="block w-full text-left px-3 py-1.5 hover:bg-gray-50" onClick={() => { setShowExportMenu(false); void doExport("session"); }}>复制 session</button>
                                <button type="button" className="block w-full text-left px-3 py-1.5 hover:bg-gray-50" title="缺 RT 先获取，再刷新，导出一个 JSON" onClick={() => { setShowExportMenu(false); void doExportSub2json(); }}>sub2json（缺 RT 自动补）</button>
                            </div>
                        )}
                    </div>
                    <Btn onClick={() => void doExport("full", {relogin: true})} disabled={exportRtRunning} className="bg-amber-600 text-white border-amber-600 hover:bg-amber-700" title="没有 RT 的账号直接获取；已有 RT 的账号重新登录获取新 RT，完成后自动复制或下载">
                        获取 / 刷新 RT
                    </Btn>
                    {exportRtRunning && (
                        <Btn onClick={async () => {
                            try {
                                const r = await api.stopExportRt();
                                if (!r.running) setExportRtRunning(false);
                                else void refreshJobs();
                                toast(r.running ? "已请求停止导出，当前这个号跑完就停" : "当前没有导出在跑");
                            } catch (e: any) { toast(e.message); void refreshJobs(); }
                        }} className="bg-white border-red-200 text-red-600 hover:bg-red-50 animate-pulse" title="停止正在进行的含 RT / sub2json 导出">
                            停止导出
                        </Btn>
                    )}
                    {isWorkingTab && (
                        <>
                            <Btn onClick={() => setShowBatchRt(true)} className="bg-amber-600 text-white border-amber-600 hover:bg-amber-700" title="按邮箱密码文本单独获取 RT，不使用当前换绑队列">按文本获取 RT</Btn>
                            <Btn onClick={openSub2json} className="bg-violet-600 text-white border-violet-600 hover:bg-violet-700" title="勾选后打开会自动填充；支持 Gmail（用 GPT 密码 + RT）">导出sub2json</Btn>
                            <Btn onClick={doProbePlan}>查询套餐</Btn>
                        </>
                    )}
                    <div className="flex-1"/>
                    <div className="flex flex-wrap items-center justify-end gap-1 text-xs">
                        {isWorkingTab && [{k: "all", l: "全部", n: qStats.total}, {k: "undone", l: "未完成", n: qStats.pending + qStats.submitted},
                          {k: "pending", l: "待提交", n: qStats.pending},
                          {k: "submitted", l: "已提交", n: qStats.submitted},
                          {k: "done", l: "完成", n: qStats.done},
                          {k: "error", l: "提交失败", n: qStats.error}]
                          .map(({k, l, n}) => (
                            <button key={k} onClick={() => setQFilter(k)}
                                    className={`px-2 py-0.5 rounded border text-xs ${qFilter === k ? "bg-gray-800 text-white border-gray-800" : "bg-gray-50 text-gray-600 border-gray-200 hover:bg-gray-100"}`}>
                                {l} {n}
                            </button>
                        ))}
                        {(isDeliveredTab || isFailedTab) && (
                            <span className="text-gray-500 px-1">共 {queue.length} 条</span>
                        )}
                        {qBatches.length > 0 && (
                            <select value={qBatchFilter} onChange={(e) => setQBatchFilter(e.target.value)}
                                    className="px-1.5 py-0.5 border rounded text-xs outline-none ml-1">
                                <option value="">{isDeliveredTab || isReadyTab ? "全部充值/交付分组" : "全部充值批次"}</option>
                                {qBatches.map((b) => <option key={b.name} value={b.name}>{b.name} ({b.n})</option>)}
                            </select>
                        )}
                        <select value={qMailboxType} onChange={(e) => setQMailboxType(e.target.value)}
                                className="px-1.5 py-0.5 border rounded text-xs outline-none">
                            <option value="">全部邮箱类型</option>
                            <option value="gmail">Gmail</option>
                            <option value="mailcom">mail.com</option>
                            <option value="icloud">iCloud</option>
                            <option value="other">其他邮箱</option>
                        </select>
                        <select value={qRebindFilter} onChange={(e) => setQRebindFilter(e.target.value)}
                                className="px-1.5 py-0.5 border rounded text-xs outline-none">
                            <option value="">全部换绑状态</option>
                            <option value="none">未换绑</option>
                            <option value="ok">已换绑</option>
                            <option value="pending">换绑中</option>
                            <option value="unknown">待核对</option>
                            <option value="fail">换绑失败</option>
                            <option value="gmail">目标 Gmail</option>
                            <option value="mailcom">目标 mail.com</option>
                        </select>
                        <input value={qEmailFilter} onChange={(e) => setQEmailFilter(e.target.value)}
                               placeholder="筛当前/原/目标邮箱"
                               className="w-48 px-2 py-0.5 border rounded text-xs font-mono outline-none focus:border-gray-500"/>
                        {(qMailboxType || qRebindFilter || qEmailFilter) && (
                            <button type="button" onClick={() => { setQMailboxType(""); setQRebindFilter(""); setQEmailFilter(""); }}
                                    className="px-2 py-0.5 rounded border border-gray-200 bg-white text-gray-500 hover:bg-gray-50">清除</button>
                        )}
                        <span className="px-1 text-gray-400 tabular-nums">{filteredQueue.length}/{queue.length}</span>
                    </div>
                </div>

                <div className="max-h-[360px] overflow-auto">
                    <table className="w-full text-xs">
                        <thead className="bg-gray-50 sticky top-0">
                            <tr>
                                <th className="w-8 px-2 py-2"><input type="checkbox" checked={allQSel} onChange={toggleAllQ}/></th>
                                <th className="text-left px-2 py-2 font-medium text-gray-500">当前邮箱</th>
                                {isDeliveredTab && <th className="text-left px-2 py-2 font-medium text-gray-500">换绑记录</th>}
                                <th className="text-left px-2 py-2 font-medium text-gray-500">套餐</th>
                                <th className="text-left px-2 py-2 font-medium text-gray-500">{isDeliveredTab || isReadyTab ? "充值/交付分组" : "充值批次"}</th>
                                {isWorkingTab && <th className="text-left px-2 py-2 font-medium text-gray-500">实例</th>}
                                <th className="text-left px-2 py-2 font-medium text-gray-500">状态</th>
                                <th className="text-left px-2 py-2 font-medium text-gray-500">卡密</th>
                                <th className="text-left px-2 py-2 font-medium text-gray-500">提交时间</th>
                                <th className="text-left px-2 py-2 font-medium text-gray-500">完成时间</th>
                                {isDeliveredTab && <th className="text-left px-2 py-2 font-medium text-gray-500">交付时间</th>}
                                {(isWorkingTab || isFailedTab) && <th className="text-left px-2 py-2 font-medium text-gray-500">耗时</th>}
                                <th className="text-left px-2 py-2 font-medium text-gray-500">任务状态</th>
                                {(isWorkingTab || isReadyTab) && <th className="text-left px-2 py-2 font-medium text-gray-500">换绑</th>}
                                <th className="text-left px-2 py-2 font-medium text-gray-500">消息</th>
                                {(isWorkingTab || isFailedTab || isReadyTab || isDeliveredTab) && <th className="text-left px-2 py-2 font-medium text-gray-500">操作</th>}
                            </tr>
                        </thead>
                        <tbody>
                            {filteredQueue.map((q) => {
                                const rb = rebindLine(q);
                                return (
                                <tr key={q.id} className="border-t hover:bg-gray-50 cursor-pointer" onClick={() => toggleQSel(q.id)}>
                                    <td className="px-2 py-1.5 text-center" onClick={(e) => e.stopPropagation()}><input type="checkbox" checked={qSel.has(q.id)} onChange={() => toggleQSel(q.id)}/></td>
                                    <td className="px-2 py-1.5 text-gray-700">{q.email}</td>
                                    {isDeliveredTab && (
                                        <td className="px-2 py-1.5 max-w-[280px] truncate" title={rb.title || rb.text}>
                                            {rb.ok ? <span className="text-green-700 font-mono text-[11px]">{rb.text}</span>
                                                : rb.text !== "—" ? <span className="text-gray-500">{rb.text}</span>
                                                : <span className="text-gray-300">未换绑</span>}
                                        </td>
                                    )}
                                    <td className="px-2 py-1.5 text-gray-500">{q.plan_type || q.plan || "—"}</td>
                                    <td className="px-2 py-1.5 text-gray-500" title={`充值/交付分组: ${q.recharge_group || q.batch || "（无）"}\nGPT来源批次: ${q.source_batch || "（无）"}\n邮箱管理分组: ${q.mailbox_group || "（无）"}`}>
                                        <div>{q.recharge_group || q.batch || "—"}</div>
                                        {(q.source_batch || q.mailbox_group) && <div className="text-[10px] text-gray-400 truncate max-w-[180px]">来源 {q.source_batch || "—"} · 邮箱组 {q.mailbox_group || "—"}</div>}
                                    </td>
                                    {isWorkingTab && (
                                    <td className="px-2 py-1.5 text-xs font-mono" title={[q.instance_id && `充值 ${q.instance_id}`, q.rebind_instance && `换绑 ${q.rebind_instance}`].filter(Boolean).join(" · ")}>
                                        {!q.instance_id && !q.rebind_instance ? <span className="text-gray-300">—</span>
                                            : q.instance_id === instanceId || q.rebind_instance === instanceId ? <span className="text-blue-600">本机{q.rebind_instance ? "·换绑" : ""}</span>
                                            : <span className="text-amber-600">{q.instance_id || q.rebind_instance}</span>}
                                    </td>
                                    )}
                                    <td className="px-2 py-1.5">
                                        <span className="inline-flex items-center gap-1 text-xs font-medium" style={{color: Q_COLOR[q.status] || "#6b7280"}}>
                                            <span className="w-1.5 h-1.5 rounded-full" style={{background: Q_COLOR[q.status] || "#6b7280"}}/>{Q_LABEL[q.status] || q.status}
                                            {q.status === "done" && " ✓"}
                                        </span>
                                    </td>
                                    <td className="px-2 py-1.5 font-mono text-gray-800 whitespace-nowrap select-all" title={q.card_code ? "点击复制完整卡密" : ""}
                                        onClick={(e) => {
                                            if (!q.card_code) return;
                                            e.stopPropagation();
                                            navigator.clipboard?.writeText(q.card_code);
                                            toast("卡密已复制");
                                        }}>
                                        {q.card_code || <span className="text-gray-300">—</span>}
                                    </td>
                                    <td className="px-2 py-1.5 text-gray-500 text-xs whitespace-nowrap">{fmtTime(q.submitted_at)}</td>
                                    <td className="px-2 py-1.5 text-gray-500 text-xs whitespace-nowrap">{fmtTime(q.finished_at)}</td>
                                    {isDeliveredTab && (
                                        <td className="px-2 py-1.5 text-gray-500 text-xs whitespace-nowrap">{fmtTime(q.delivered_at)}</td>
                                    )}
                                    {(isWorkingTab || isFailedTab) && (
                                    <td className="px-2 py-1.5 text-gray-500 text-xs whitespace-nowrap" title={q.submitted_at && q.finished_at ? `${fmtTime(q.submitted_at)} → ${fmtTime(q.finished_at)}` : ""}>{fmtDur(q.submitted_at, q.finished_at)}</td>
                                    )}
                                    <td className="px-2 py-1.5">{q.task_status ? <span style={{color: TASK_COLOR[q.task_status] || "#6b7280"}}>{q.task_status}</span> : "—"}</td>
                                    {(isWorkingTab || isReadyTab) && (
                                    <td className="px-2 py-1.5 max-w-[200px] truncate" title={rb.title || q.rebind_error || q.rebind_email || ""}>
                                        {rb.ok ? <span className="text-green-600" title={rb.title}>{rb.text}</span>
                                            : q.rebind_status === "pending" ? <span className="text-amber-600">{rb.text}</span>
                                            : q.rebind_status === "unknown" ? <span className="text-purple-600 font-medium">{rb.text}</span>
                                            : q.rebind_status === "fail" ? <span className="text-red-500">{rb.text}</span>
                                            : q.rebind_status === "skipped" ? <span className="text-gray-400">{rb.text}</span>
                                            : <span className="text-gray-300">—</span>}
                                    </td>
                                    )}
                                    <td className="px-2 py-1.5 text-gray-500 max-w-[180px] truncate" title={q.task_message || q.error || ""}>
                                        {q.error ? <span className="text-red-500">{q.error}</span> : (q.task_message || "—")}
                                    </td>
                                    {(isWorkingTab || isFailedTab || isReadyTab || isDeliveredTab) && (
                                        <td className="px-2 py-1.5" onClick={(e) => e.stopPropagation()}>
                                        <button onClick={() => openDetailLogs(q)}
                                                className="text-gray-600 hover:text-gray-900 text-xs hover:underline">详细日志</button>
                                        {q.status !== "done" && q.status !== "pending" && q.card_code && (
                                            <button onClick={() => { api.pollRecharge([q.id]).then(() => { toast(`已刷新 ${q.email}`); loadQueue(); }).catch((e: any) => { loadQueue(); toast(e.message); }); }}
                                                    className="text-blue-500 hover:text-blue-700 text-xs hover:underline">刷新</button>
                                        )}
                                        {isWorkingTab && q.status !== "done" && q.task_status !== "paid" && (
                                            <button onClick={() => doMarkError([q.id])}
                                                    className="text-red-500 hover:text-red-700 text-xs hover:underline ml-2">标记失败</button>
                                        )}
                                        {(q.status === "error" || q.status === "paired") && (
                                            <button onClick={() => { api.resetRechargeQueue([q.id]).then(() => { loadQueue(); toast(q.status === "error" ? "已退回未交付" : "已重置"); }).catch((e: any) => toast(e.message)); }}
                                                    className="text-amber-500 hover:text-amber-700 text-xs hover:underline ml-2">{q.status === "error" ? "重置回队列" : "重置"}</button>
                                        )}
                                        {(q.status === "done" || q.task_status === "paid") && q.rebind_status === "pending" && (
                                            <button onClick={() => { api.rebindGmail([q.id], (q.rebind_target === "mailcom" ? "mailcom" : "gmail"), {allowDelivered: isDeliveredTab}).then((r) => { toast(r.queued ? "已排队换绑" : (r.skipped[0]?.reason || "已跳过")); loadQueue(); loadConfig(); }).catch((e: any) => toast(e.message)); }}
                                                    className="text-blue-500 hover:text-blue-700 text-xs hover:underline ml-2">重试换绑</button>
                                        )}
                                        {/* 待核对：官方可能已改，先对账定论，不给再换一轮的入口 */}
                                        {q.rebind_status === "unknown" && (
                                            <button onClick={() => { api.reconcileRebind([q.id]).then((r) => { toast(r.skipped?.[0]?.reason || `已对账 ${r.done || 0} 个`); loadQueue(); }).catch((e: any) => toast(e.message)); }}
                                                    className="text-purple-600 hover:text-purple-800 text-xs hover:underline ml-2">对账</button>
                                        )}
                                        {(q.status === "done" || q.task_status === "paid") && q.rebind_status !== "pending" && q.rebind_status !== "unknown" && (
                                            rebindCooldownLeft(q) > 0 ? (
                                                // 冷却里点了后端也会直接拒，给个明确原因比让人反复点好
                                                <span className="text-gray-400 text-xs ml-2"
                                                      title="官方限制单个账号 24 小时内的换绑次数。换目标邮箱、换出口、重登都没用，只能等。">
                                                    24h 上限 · {fmtCooldown(rebindCooldownLeft(q))}后可换
                                                </span>
                                            ) : (
                                            <>
                                                <button onClick={() => openRebindGmail([q.id])}
                                                        className="text-blue-500 hover:text-blue-700 text-xs hover:underline ml-2">换绑Gmail</button>
                                                {!isDeliveredTab && (
                                                    <button onClick={() => { api.rebindGmail([q.id], "mailcom").then((r) => { toast(r.queued ? "已排队换绑 mail.com" : (r.skipped[0]?.reason || "已跳过")); loadQueue(); loadConfig(); }).catch((e: any) => toast(e.message)); }}
                                                            className="text-blue-500 hover:text-blue-700 text-xs hover:underline ml-2">换绑mail</button>
                                                )}
                                            </>
                                            )
                                        )}
                                        {q.rebind_status === "pending" && (
                                            <button onClick={() => { api.cancelRebindGmail([q.id]).then(() => { toast("已取消换绑"); loadQueue(); }).catch((e: any) => toast(e.message)); }}
                                                    className="text-red-500 hover:text-red-700 text-xs hover:underline ml-2">取消换绑</button>
                                        )}
                                    </td>
                                    )}
                                </tr>
                                );
                            })}
                            {!filteredQueue.length && (
                                <tr>
                                    <td colSpan={isDeliveredTab ? 11 : isFailedTab ? 12 : isReadyTab ? 13 : 14} className="text-center py-8 text-gray-400">
                                        {isDeliveredTab ? "暂无已交付账号；在「可交付」中点「标记已交付」后会出现在这里"
                                            : isReadyTab ? "没有可交付的号。充值完成（状态=完成）后会出现在这里"
                                            : isFailedTab ? "没有人工标记失败的号。提交失败仍在「未交付」"
                                            : "队列为空，点击「选择账号入队」添加"}
                                    </td>
                                </tr>
                            )}
                        </tbody>
                    </table>
                </div>
            </div>

            {/* ====== 卡密池：仅未交付作业页显示 ====== */}
            {isWorkingTab && (
            <div className="bg-white rounded-lg border shadow-sm">
                <div className="px-4 py-3 border-b flex items-center gap-2 flex-wrap">
                    <span className="text-sm font-semibold">卡密池</span>
                    <Btn onClick={() => setShowImport(true)}>+ 导入卡密</Btn>
                    <Btn onClick={doValidate}>验证选中</Btn>
                    <Btn onClick={doResetCards} title="授权换号后点这个：再问平台，unused 的卡清本地绑定、放回未使用">重置选中</Btn>
                    <Btn onClick={doDeleteCards} className="bg-white border-red-200 text-red-600 hover:bg-red-50">删除选中</Btn>
                    <div className="flex-1"/>
                    <span className="text-xs text-gray-500">
                        总 <b>{cStats.total}</b> | 未使用 <b className="text-green-600">{cStats.unused}</b> | 已用 <b>{cStats.total - cStats.unused}</b>
                    </span>
                </div>
                <div className="max-h-[200px] overflow-auto">
                    <table className="w-full text-xs">
                        <thead className="bg-gray-50 sticky top-0">
                            <tr>
                                <th className="w-8 px-2 py-2"><input type="checkbox" checked={cards.length > 0 && cards.every((c) => cSel.has(c.id))} onChange={() => setCSel(cards.every((c) => cSel.has(c.id)) ? new Set() : new Set(cards.map((c) => c.id)))}/></th>
                                <th className="text-left px-2 py-2 font-medium text-gray-500">卡密</th>
                                <th className="text-left px-2 py-2 font-medium text-gray-500">套餐</th>
                                <th className="text-left px-2 py-2 font-medium text-gray-500">状态</th>
                                <th className="text-left px-2 py-2 font-medium text-gray-500">配对账号</th>
                            </tr>
                        </thead>
                        <tbody>
                            {cards.map((c) => (
                                <tr key={c.id} className="border-t hover:bg-gray-50 cursor-pointer" onClick={() => toggleCSel(c.id)}>
                                    <td className="px-2 py-1.5 text-center" onClick={(e) => e.stopPropagation()}><input type="checkbox" checked={cSel.has(c.id)} onChange={() => toggleCSel(c.id)}/></td>
                                    <td className="px-2 py-1.5 font-mono text-gray-800 whitespace-nowrap select-all" title="点击复制完整卡密"
                                        onClick={(e) => {
                                            e.stopPropagation();
                                            navigator.clipboard?.writeText(c.code);
                                            toast("卡密已复制");
                                        }}>{c.code}</td>
                                    <td className="px-2 py-1.5 text-gray-500">{c.plan_name || c.plan_type || "—"}</td>
                                    <td className="px-2 py-1.5"><span style={{color: Q_COLOR[c.status] || "#6b7280"}} className="text-xs">{c.status === "unused" ? "未使用" : c.status}</span></td>
                                    <td className="px-2 py-1.5 text-gray-500">{c.account_email || "—"}</td>
                                </tr>
                            ))}
                            {!cards.length && <tr><td colSpan={5} className="text-center py-6 text-gray-400">暂无卡密</td></tr>}
                        </tbody>
                    </table>
                </div>
            </div>
            )}

            {/* ====== 操作日志 ====== */}
            <div className="bg-white rounded-lg border shadow-sm">
                <div className="px-4 py-2 border-b flex items-center justify-between">
                    <span className="text-sm font-semibold">操作日志 <span className="text-xs font-normal text-gray-400">{logs.length ? `${logs.length} 条` : ""}</span></span>
                    <button onClick={() => { api.clearRechargeLogs().then(() => { setLogs([]); setDetailLogs([]); }).catch(() => { setLogs([]); setDetailLogs([]); }); }} className="text-xs text-gray-400 hover:text-gray-600">清空</button>
                </div>
                <div ref={logBoxRef} onScroll={onLogBoxScroll} className="max-h-[280px] overflow-auto bg-gray-50 p-3 font-mono text-xs text-gray-600 space-y-0.5">
                    {logs.length ? logs.map((l, i) => {
                        const line = String(l.line || "");
                        const cls = /换绑 ✗|^✗/.test(line) ? "text-red-500"
                            : /换绑 ✓|^✓/.test(line) ? "text-green-600"
                            : /换绑/.test(line) ? "text-amber-800"
                            : "";
                        return (
                        <div key={`${l.ts}-${i}`} className="flex gap-2">
                            <span className="text-gray-400 shrink-0">{fmtLogTime(l.ts)}</span>
                            {l.instance_id && <span className="text-gray-400 shrink-0" title={l.instance_id}>[{l.instance_id}]</span>}
                            <span className={cls}>{line}</span>
                        </div>
                        );
                    }) : <div className="text-gray-400">暂无日志。提交/轮询/换绑会写到这里，刷新页面也会保留。</div>}
                </div>
            </div>

            {detailItem && (
                <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4" onClick={() => setDetailItem(null)}>
                    <div className="bg-white rounded-xl shadow-xl w-[min(1000px,calc(100vw-2rem))] max-h-[88vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
                        <div className="px-5 py-3 border-b flex items-center gap-3">
                            <div className="min-w-0 flex-1">
                                <div className="font-semibold text-sm">详细日志</div>
                                <div className="text-xs text-gray-500 truncate mt-0.5" title={detailItem.email}>{detailItem.email}</div>
                            </div>
                            <button type="button" onClick={() => void refreshDetailLogs(detailItem)} disabled={detailLoading}
                                    className="px-2.5 py-1.5 rounded border text-xs text-gray-600 hover:bg-gray-50 disabled:opacity-50">
                                {detailLoading ? "读取中..." : "刷新日志"}
                            </button>
                            <button type="button" onClick={() => {
                                const text = detailLogs.map((entry) => `${fmtLogTime(entry.ts)} ${entry.line}`).join("\n");
                                if (!text) { toast("暂无可复制的详细日志"); return; }
                                navigator.clipboard?.writeText(text);
                                toast("详细日志已复制");
                            }} className="px-2.5 py-1.5 rounded border text-xs text-gray-600 hover:bg-gray-50">复制日志</button>
                            <button type="button" onClick={() => setDetailItem(null)} className="px-2.5 py-1.5 rounded border text-xs text-gray-600 hover:bg-gray-50">关闭</button>
                        </div>
                        <div className="px-5 py-3 border-b grid grid-cols-2 md:grid-cols-4 gap-x-5 gap-y-2 text-xs">
                            <div><span className="text-gray-400">队列状态</span><div className="font-medium mt-0.5" style={{color: Q_COLOR[detailItem.status] || "#6b7280"}}>{Q_LABEL[detailItem.status] || detailItem.status}</div></div>
                            <div><span className="text-gray-400">平台任务</span><div className="font-mono mt-0.5 break-all">{detailItem.task_no || "—"}</div></div>
                            <div><span className="text-gray-400">任务状态</span><div className="mt-0.5" style={{color: TASK_COLOR[detailItem.task_status] || "#6b7280"}}>{detailItem.task_status || "—"}</div></div>
                            <div><span className="text-gray-400">执行实例</span><div className="font-mono mt-0.5 break-all">{detailItem.instance_id || detailItem.rebind_instance || "—"}</div></div>
                            <div><span className="text-gray-400">卡密</span><div className="font-mono mt-0.5 break-all">{detailItem.card_code || "—"}</div></div>
                            <div><span className="text-gray-400">提交时间</span><div className="mt-0.5">{fmtTime(detailItem.submitted_at)}</div></div>
                            <div><span className="text-gray-400">完成时间</span><div className="mt-0.5">{fmtTime(detailItem.finished_at)}</div></div>
                            <div><span className="text-gray-400">充值耗时</span><div className="mt-0.5">{fmtDur(detailItem.submitted_at, detailItem.finished_at)}</div></div>
                            {(detailItem.rebind_from || detailItem.rebind_email || detailItem.rebind_attempt_email) && (
                                <div className="col-span-2 md:col-span-4"><span className="text-gray-400">换绑信息</span><div className="font-mono mt-0.5 break-all">{[detailItem.rebind_from, detailItem.rebind_email || detailItem.rebind_attempt_email].filter(Boolean).join(" → ") || "—"}{detailItem.rebind_status ? ` · ${detailItem.rebind_status}` : ""}</div></div>
                            )}
                            {(detailItem.error || detailItem.task_message) && (
                                <div className="col-span-2 md:col-span-4"><span className="text-gray-400">当前消息</span><div className="text-red-500 mt-0.5 break-all">{detailItem.error || detailItem.task_message}</div></div>
                            )}
                        </div>
                        <div className="px-5 py-2 border-b flex items-center justify-between text-xs">
                            <span className="font-semibold">执行时间线</span>
                            <span className="text-gray-400">{detailLoading ? "正在同步" : `${detailLogs.length} 条`}</span>
                        </div>
                        <div className="flex-1 min-h-0 overflow-auto bg-gray-50 px-5 py-3 font-mono text-xs text-gray-600 space-y-1">
                            {detailLogs.length ? detailLogs.map((entry, index) => {
                                const line = String(entry.line || "");
                                const cls = /换绑 ✗|^✗/.test(line) ? "text-red-500"
                                    : /换绑 ✓|^✓/.test(line) ? "text-green-600"
                                    : /换绑/.test(line) ? "text-amber-800"
                                    : "";
                                return <div key={`${entry.ts}-${index}`} className="flex gap-3 items-start"><span className="text-gray-400 shrink-0">{fmtLogTime(entry.ts)}</span><span className={cls}>{line}</span></div>;
                            }) : <div className="text-gray-400">{detailLoading ? "正在读取日志..." : "暂无该账号详细日志"}</div>}
                        </div>
                    </div>
                </div>
            )}

            {/* ====== 导入卡密弹窗 ====== */}
            {showImport && (
                <div className="fixed inset-0 bg-black/30 flex items-center justify-center z-50" onClick={() => setShowImport(false)}>
                    <div className="bg-white rounded-xl shadow-xl w-[480px] max-h-[80vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
                        <div className="px-5 py-3 border-b font-semibold text-sm">导入卡密</div>
                        <div className="p-5 space-y-3 overflow-auto">
                            <label className="block"><span className="text-xs text-gray-500 mb-1 block">批次标签(可选)</span>
                                <input value={importBatch} onChange={(e) => setImportBatch(e.target.value)} placeholder="如: batch-001"
                                       className="w-full px-2 py-1.5 text-sm border rounded outline-none"/></label>
                            <label className="block"><span className="text-xs text-gray-500 mb-1 block">卡密(一行一个)</span>
                                <textarea value={importText} onChange={(e) => setImportText(e.target.value)} rows={10}
                                          placeholder={"XXXX-XXXX-XXXX\nYYYY-YYYY-YYYY"}
                                          className="w-full px-2 py-1.5 text-sm border rounded font-mono outline-none resize-none"/></label>
                            <div className="text-xs text-gray-400">{importText.split(/[\r\n]+/).filter((l) => l.trim()).length} 个卡密待导入</div>
                        </div>
                        <div className="px-5 py-3 border-t flex justify-end gap-2">
                            <Btn onClick={() => setShowImport(false)}>取消</Btn>
                            <Btn onClick={doImport} className="bg-blue-600 text-white border-blue-600 hover:bg-blue-700">导入</Btn>
                        </div>
                    </div>
                </div>
            )}

            {/* ====== 选择账号入队弹窗 ====== */}
            {showPicker && (
                <div className="fixed inset-0 bg-black/30 flex items-center justify-center z-50" onClick={() => setShowPicker(false)}>
                    <div className="bg-white rounded-xl shadow-xl w-[780px] max-h-[80vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
                        <div className="px-5 py-3 border-b font-semibold text-sm flex items-center gap-3">
                            <span>选择账号入队</span>
                            <span className="text-xs text-gray-500 font-normal tabular-nums">
                                当前 <b className="text-gray-800">{pickerFiltered.length}</b>
                                <span className="text-gray-300 mx-1">/</span>
                                可选 {accounts.length}
                                <span className="text-gray-300 mx-1">·</span>
                                已选 <b className="text-blue-600">{pickerSel.size}</b>
                            </span>
                        </div>
                        <div className="px-5 py-2 border-b space-y-2">
                            <div className="flex items-center gap-2">
                                <input value={pickerSearch} onChange={(e) => setPickerSearch(e.target.value)} placeholder="搜索邮箱..."
                                       className="flex-1 px-2 py-1 text-xs border rounded outline-none"/>
                                <select value={pickerBatch} onChange={(e) => setPickerBatch(e.target.value)} className="px-2 py-1 text-xs border rounded outline-none">
                                    <option value="">全部 GPT 来源批次 ({accounts.length})</option>
                                    {pickerBatches.map((b) => <option key={b.name} value={b.name}>{b.name || "(无批次)"} ({b.n})</option>)}
                                </select>
                            </div>
                            <div className="flex items-center gap-2 flex-wrap">
                                <span className="text-[11px] text-gray-500 shrink-0">充值/交付分组</span>
                                <select value={rechargeGrpNew.trim() ? "" : rechargeBatch} onChange={(e) => { setRechargeBatch(e.target.value); if (e.target.value) setRechargeGrpNew(""); }}
                                        className="px-2 py-1 text-xs border rounded outline-none min-w-[160px]">
                                    <option value="">选择已有充值分组</option>
                                    {queueGroups.map((g) => <option key={g.name} value={g.name}>{g.name} ({g.n})</option>)}
                                </select>
                                <span className="text-[11px] text-gray-400">或</span>
                                <input value={rechargeGrpNew} onChange={(e) => setRechargeGrpNew(e.target.value)} placeholder="新建分组名"
                                       className="w-40 px-2 py-1 text-xs border rounded outline-none"/>
                                <label className="inline-flex items-center gap-1 text-[11px] text-gray-600" title="仅当选中账号来自同一个来源批次时自动继承">
                                    <input type="checkbox" checked={inheritSourceBatch} onChange={(e) => setInheritSourceBatch(e.target.checked)}/>
                                    来源批次自动作为充值分组
                                </label>
                                <span className="text-[11px] text-gray-400">
                                    将记为：<b className="text-gray-700">{resolvedEnqueueGrp() || "（无分组）"}</b>
                                    {inheritSourceBatch && selectedSourceBatches.length > 1 && !rechargeGrpNew.trim() && !rechargeBatch.trim() && <span className="text-amber-600">（选中了多个来源批次，请手工指定）</span>}
                                </span>
                            </div>
                            {/* facet 筛选条(同 GPT 面板逻辑:组内 OR、跨组 AND) */}
                            <div className="flex items-center gap-1.5 flex-wrap">
                                {Object.entries(
                                    Object.entries(PICKER_FACETS).reduce<Record<string, {key: string; label: string; n: number}[]>>((g, [k, d]) => {
                                        (g[d.group] = g[d.group] || []).push({key: k, label: d.label, n: pickerFacetCounts[k] || 0}); return g;
                                    }, {})
                                ).map(([group, items]) => (
                                    <span key={group} className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md bg-gray-50 border border-gray-100">
                                        <span className="text-[11px] text-gray-400 mr-0.5">{group}</span>
                                        {items.map((f) => (
                                            <button key={f.key} onClick={() => togglePickerFacet(f.key)}
                                                    className={`px-2 py-0.5 rounded-md text-xs border transition ${pickerFacets.has(f.key) ? "bg-indigo-600 text-white border-indigo-600" : f.n ? "bg-white text-gray-600 border-gray-200 hover:bg-gray-50" : "bg-white text-gray-300 border-gray-100"}`}>
                                                {f.label} <span className="font-semibold">{f.n}</span>
                                            </button>
                                        ))}
                                    </span>
                                ))}
                                {pickerFacets.size > 0 && (
                                    <button onClick={() => setPickerFacets(new Set())} className="text-xs text-blue-500 hover:underline ml-1">清除筛选</button>
                                )}
                            </div>
                            <div className="flex items-center gap-1.5 flex-wrap">
                                <span className="text-[11px] text-gray-400">按当前列表</span>
                                <span className="text-xs text-gray-500">N</span>
                                <input value={pickerTakeN} onChange={(e) => setPickerTakeN(e.target.value.replace(/[^\d]/g, ""))}
                                       className="w-14 px-1.5 py-0.5 text-xs border rounded outline-none tabular-nums" placeholder="20"/>
                                <Btn onClick={() => pickerSelectSlice("first")}>勾选前 N</Btn>
                                <Btn onClick={() => pickerSelectSlice("last")}>勾选后 N</Btn>
                                <Btn onClick={() => doAddToQueue(pickerSliceIds("first"))} disabled={!pickerSliceIds("first").length}
                                     className="bg-blue-600 text-white border-blue-600 hover:bg-blue-700">前 N 入队</Btn>
                                <Btn onClick={() => doAddToQueue(pickerSliceIds("last"))} disabled={!pickerSliceIds("last").length}
                                     className="bg-blue-600 text-white border-blue-600 hover:bg-blue-700">后 N 入队</Btn>
                                <span className="text-[11px] text-gray-400">当前 {pickerFiltered.length} 条</span>
                            </div>
                        </div>
                        <div className="flex-1 overflow-auto max-h-[400px]">
                            <table className="w-full text-xs">
                                <thead className="bg-gray-50 sticky top-0">
                                    <tr>
                                        <th className="w-8 px-2 py-2"><input type="checkbox" checked={pickerAllSel} onChange={pickerToggleAll}/></th>
                                        <th className="text-left px-2 py-2 font-medium text-gray-500">邮箱</th>
                                        <th className="text-left px-2 py-2 font-medium text-gray-500">类别</th>
                                        <th className="text-left px-2 py-2 font-medium text-gray-500">套餐</th>
                                        <th className="text-left px-2 py-2 font-medium text-gray-500">AT</th>
                                        <th className="text-left px-2 py-2 font-medium text-gray-500">改密</th>
                                        <th className="text-left px-2 py-2 font-medium text-gray-500">批次</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {pickerFiltered.map((a) => (
                                        <tr key={a.id} className="border-t hover:bg-blue-50 cursor-pointer" onClick={() => pickerToggle(a.id)}>
                                            <td className="px-2 py-1.5 text-center" onClick={(e) => e.stopPropagation()}><input type="checkbox" checked={pickerSel.has(a.id)} onChange={() => pickerToggle(a.id)}/></td>
                                            <td className="px-2 py-1.5 text-gray-700">{a.email}</td>
                                            <td className="px-2 py-1.5 text-gray-500">{accKindLabel(a)}</td>
                                            <td className="px-2 py-1.5 text-gray-500">{a.plan || "—"}</td>
                                            <td className="px-2 py-1.5">{a.at_status ? <span className={/✅/.test(a.at_status) ? "text-green-600" : /❌/.test(a.at_status) ? "text-red-500" : "text-gray-400"}>{a.at_status}</span> : <span className="text-gray-300">未测</span>}</td>
                                            <td className="px-2 py-1.5">{a.pw_status ? <span className={String(a.pw_status).includes("✅") ? "text-green-600" : "text-red-500"}>{a.pw_status}</span> : <span className="text-gray-300">—</span>}</td>
                                            <td className="px-2 py-1.5 text-gray-400">{a.batch || "—"}</td>
                                        </tr>
                                    ))}
                                    {!pickerFiltered.length && <tr><td colSpan={7} className="text-center py-8 text-gray-400">无可充值的账号</td></tr>}
                                </tbody>
                            </table>
                        </div>
                        <div className="px-5 py-3 border-t flex items-center justify-between">
                            <span className="text-xs text-gray-500 tabular-nums">当前 <b>{pickerFiltered.length}</b> · 已选 <b className="text-blue-600">{pickerSel.size}</b></span>
                            <div className="flex gap-2">
                                <Btn onClick={() => setShowPicker(false)}>取消</Btn>
                                <Btn onClick={doAddToQueue} disabled={pickerSel.size === 0} className="bg-blue-600 text-white border-blue-600 hover:bg-blue-700">
                                    确认入队 ({pickerSel.size})
                                </Btn>
                            </div>
                        </div>
                    </div>
                </div>
            )}

            {showTestSend && (
                <div className="fixed inset-0 bg-black/30 flex items-center justify-center z-50" onClick={() => setShowTestSend(false)}>
                    <div className="bg-white rounded-xl shadow-xl w-[720px] max-w-[96vw] max-h-[90vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
                        <div className="px-5 py-3 border-b font-semibold text-sm">测试发送
                            <div className="text-xs text-gray-400 font-normal mt-0.5">没勾选就发当前列表前 5 个。mail.com 和 Gmail 都走 SMTP 协议，点发送会马上返回，进度看充值日志。</div>
                        </div>
                        <div className="px-5 py-3 space-y-3 overflow-auto">
                            <label className="block text-xs text-gray-500">测试收件人
                                <input value={testSendTo} onChange={(e) => setTestSendTo(e.target.value)}
                                       className="mt-1 w-full px-2 py-1.5 text-sm border rounded outline-none font-mono"/>
                            </label>
                            {testSendPreview[0] && (
                                <div className="rounded-lg border bg-gray-50 p-3 text-xs text-gray-700 space-y-1">
                                    <div className="font-medium text-gray-800">收件内容预览</div>
                                    <div>主题：{testSendPreview[0].subject}</div>
                                    <pre className="whitespace-pre-wrap text-[11px] text-gray-600 bg-white border rounded p-2 max-h-36 overflow-auto">{testSendPreview[0].text}</pre>
                                </div>
                            )}
                            <div className="max-h-52 overflow-auto border rounded">
                                <table className="w-full text-xs">
                                    <thead className="bg-gray-50 sticky top-0">
                                        <tr>
                                            <th className="text-left px-2 py-1.5 text-gray-500">队列邮箱</th>
                                            <th className="text-left px-2 py-1.5 text-gray-500">发件（协议）</th>
                                            <th className="text-left px-2 py-1.5 text-gray-500">分组</th>
                                            <th className="text-left px-2 py-1.5 text-gray-500">状态</th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {testSendPreview.map((row) => (
                                            <tr key={row.id} className="border-t">
                                                <td className="px-2 py-1.5 font-mono">{row.queueEmail}</td>
                                                <td className="px-2 py-1.5 font-mono">{row.from}{row.rebound ? <span className="text-amber-600">（原号）</span> : ""}</td>
                                                <td className="px-2 py-1.5 text-gray-500">{row.group || "—"}</td>
                                                <td className="px-2 py-1.5">{row.canSend ? <span className="text-green-600">可发{row.via ? ` · ${row.via}` : ""}</span> : <span className="text-red-500">{row.reason || "不可发"}</span>}</td>
                                            </tr>
                                        ))}
                                    </tbody>
                                </table>
                            </div>
                            {testSendResult && <div className="text-xs text-violet-700">{testSendResult}</div>}
                        </div>
                        <div className="px-5 py-3 border-t flex justify-end gap-2">
                            <button type="button" onClick={() => setShowTestSend(false)}
                                    className="px-3 py-1.5 rounded text-xs font-medium border bg-white border-gray-200 text-gray-700 hover:bg-gray-50">关闭</button>
                            {testSendBusy && (
                                <button type="button" onClick={() => { void doStopTestSend(); }}
                                        className="px-3 py-1.5 rounded text-xs font-medium border bg-white border-red-200 text-red-600 hover:bg-red-50">
                                    停止发送
                                </button>
                            )}
                            <button type="button" disabled={testSendBusy} onClick={doTestSend}
                                    className="px-3 py-1.5 rounded text-xs font-medium border bg-violet-600 text-white border-violet-600 hover:bg-violet-700 disabled:opacity-40">
                                {testSendBusy ? "发送中…" : "发出测试信"}
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {/* ====== 换绑 Gmail：验证区分组 → 迁入换绑池 → 从换绑池换绑 ====== */}
            {showRebindGmail && (
                <div className="fixed inset-0 bg-black/30 flex items-center justify-center z-50" onClick={() => !busy && setShowRebindGmail(false)}>
                    <div className="bg-white rounded-xl shadow-xl w-[960px] max-w-[96vw] max-h-[92vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
                        <div className="px-5 py-3 border-b font-semibold text-sm flex items-start gap-3">
                            <div className="flex-1 min-w-0">
                                换绑 Gmail
                                <div className="text-xs text-gray-400 font-normal mt-0.5">
                                    给 <b className="text-gray-600">{rebindIds.length}</b> 个{isDeliveredTab ? "已交付且已支付号人工换绑 Gmail" : "已付费号（支持 mail.com→Gmail，也支持 Gmail→Gmail 再换一把）"}。
                                    流程：① 左侧按分组选号 → ② 迁入「{rebindPool.poolGrp}」时并行探 IMAP（只探一次）
                                    → ③ 换绑前{configRebindGmailProbeLogin ? "探网页登录" : "跳过网页登录探活"}。
                                </div>
                            </div>
                            <button type="button" disabled={busy}
                                    onClick={() => loadRebindPool().then(() => toast("已刷新")).catch((e: any) => toast(e.message))}
                                    className="text-xs px-2 py-1 border rounded text-gray-500 hover:bg-gray-50 disabled:opacity-40 shrink-0">
                                刷新
                            </button>
                        </div>
                        <div className="px-4 py-3 grid grid-cols-1 md:grid-cols-2 gap-3 min-h-0 flex-1 overflow-hidden text-xs">
                            {/* —— 左：验证区 —— */}
                            <div className="border rounded-lg flex flex-col min-h-0 overflow-hidden">
                                <div className="px-3 py-2 bg-violet-50 border-b font-medium text-violet-900">
                                    ① 验证区 <span className="font-normal text-violet-600">（需 2FA+IMAP；迁入并行探 IMAP）</span>
                                    <span className="float-right text-violet-500 font-normal">{rebindPool.stagingCount} 个</span>
                                </div>
                                <div className="px-2 py-2 flex flex-wrap gap-1.5 border-b max-h-20 overflow-auto">
                                    {rebindPool.groups.length === 0 && <span className="text-gray-400 px-1">暂无待验证 Gmail</span>}
                                    {rebindPool.groups.map((g) => (
                                        <button key={g.grp || "__EMPTY__"} type="button"
                                                onClick={() => { setStageGrp(g.grp); setStagePick(new Set()); }}
                                                className={`px-2 py-0.5 rounded border max-w-[140px] truncate ${stageGrp === g.grp ? "bg-violet-600 text-white border-violet-600" : "bg-white text-gray-600 border-gray-200"}`}
                                                title={g.grp || "(无分组)"}>
                                            {g.grp || "(无分组)"} ({g.n})
                                        </button>
                                    ))}
                                </div>
                                <div className="px-2 py-1.5 flex flex-wrap gap-1.5 border-b bg-gray-50/80">
                                    <button type="button" disabled={!stageVisible.length}
                                            onClick={() => copyRebindCreds(stageVisible, "（本组）")}
                                            className="px-2 py-1 rounded border border-violet-300 text-violet-700 bg-white hover:bg-violet-50 disabled:opacity-40">
                                        复制本组 ({stageVisible.length})
                                    </button>
                                    <button type="button" disabled={!stagePick.size}
                                            onClick={() => copyRebindCreds(rebindPool.staging.filter((m) => stagePick.has(m.id)), "（勾选）")}
                                            className="px-2 py-1 rounded border border-violet-300 text-violet-700 bg-white hover:bg-violet-50 disabled:opacity-40">
                                        复制勾选 ({stagePick.size})
                                    </button>
                                    <button type="button" disabled={busy || !stagePick.size}
                                            onClick={() => doMigrateToReady([...stagePick])}
                                            className="px-2 py-1 rounded border border-emerald-400 text-emerald-800 bg-emerald-50 hover:bg-emerald-100 disabled:opacity-40 font-medium">
                                        迁入换绑池 ({stagePick.size})
                                    </button>
                                    <button type="button" disabled={busy || !stagePick.size}
                                            onClick={() => doMarkUnavailable([...stagePick])}
                                            className="px-2 py-1 rounded border border-red-300 text-red-700 bg-red-50 hover:bg-red-100 disabled:opacity-40">
                                        不可用 ({stagePick.size})
                                    </button>
                                </div>
                                <input value={stageSearch} onChange={(e) => setStageSearch(e.target.value)} placeholder="搜索本组邮箱"
                                       className="mx-2 mt-2 px-2 py-1 border rounded outline-none"/>
                                <div className="flex-1 min-h-[180px] max-h-[340px] overflow-auto m-2 border rounded">
                                    <table className="w-full">
                                        <thead className="bg-gray-50 text-gray-500 sticky top-0">
                                            <tr>
                                                <th className="w-8 px-1 py-1">
                                                    <input type="checkbox" checked={stageAllSel} disabled={!stageVisible.length}
                                                           onChange={() => selectAllIds(setStagePick, stageVisible, stageAllSel)}/>
                                                </th>
                                                <th className="text-left px-1 py-1">邮箱</th>
                                                <th className="w-10 px-1 py-1"></th>
                                            </tr>
                                        </thead>
                                        <tbody>
                                            {stageVisible.map((m) => (
                                                <tr key={m.id} className="border-t hover:bg-violet-50/50">
                                                    <td className="px-1 py-1 text-center">
                                                        <input type="checkbox" checked={stagePick.has(m.id)}
                                                               onChange={() => toggleIdSet(setStagePick, m.id)}/>
                                                    </td>
                                                    <td className="px-1 py-1 font-mono break-all">{m.email}</td>
                                                    <td className="px-1 py-1 text-center">
                                                        <button type="button" className="text-violet-600 hover:underline"
                                                                onClick={() => copyRebindCreds([m], "")}>复制</button>
                                                    </td>
                                                </tr>
                                            ))}
                                        </tbody>
                                    </table>
                                    {!stageVisible.length && <div className="py-8 text-center text-gray-400">本组无待验证号</div>}
                                </div>
                                <div className="px-2 pb-2 text-gray-400">格式 邮箱----密码----TOTP----IMAP · 全选后可批量迁入</div>
                            </div>

                            {/* —— 右：换绑池 —— */}
                            <div className="border rounded-lg flex flex-col min-h-0 overflow-hidden border-emerald-200">
                                <div className="px-3 py-2 bg-emerald-50 border-b border-emerald-200 font-medium text-emerald-900">
                                    ② {rebindPool.poolGrp} <span className="font-normal text-emerald-700">（已验证，换绑只从这里领）</span>
                                    <span className="float-right text-emerald-600 font-normal">{rebindPool.readyCount} 个</span>
                                </div>
                                <div className="px-2 py-1.5 flex flex-wrap gap-1.5 border-b bg-gray-50/80">
                                    <button type="button" disabled={!readyVisible.length}
                                            onClick={() => copyRebindCreds(readyVisible, "（换绑池）")}
                                            className="px-2 py-1 rounded border border-emerald-300 text-emerald-800 bg-white hover:bg-emerald-50 disabled:opacity-40">
                                        复制全部 ({readyVisible.length})
                                    </button>
                                    <button type="button" disabled={!readyPick.size}
                                            onClick={() => copyRebindCreds(rebindPool.ready.filter((m) => readyPick.has(m.id)), "（勾选）")}
                                            className="px-2 py-1 rounded border border-emerald-300 text-emerald-800 bg-white hover:bg-emerald-50 disabled:opacity-40">
                                        复制勾选 ({readyPick.size})
                                    </button>
                                    <button type="button" disabled={busy || !readyPick.size}
                                            onClick={() => doDemoteFromReady([...readyPick])}
                                            className="px-2 py-1 rounded border border-gray-300 text-gray-600 bg-white hover:bg-gray-50 disabled:opacity-40">
                                        移回验证区 ({readyPick.size})
                                    </button>
                                    <button type="button" disabled={busy || !readyPick.size}
                                            onClick={() => doMarkUnavailable([...readyPick])}
                                            className="px-2 py-1 rounded border border-red-300 text-red-700 bg-red-50 hover:bg-red-100 disabled:opacity-40">
                                        不可用 ({readyPick.size})
                                    </button>
                                </div>
                                <input value={readySearch} onChange={(e) => setReadySearch(e.target.value)} placeholder="搜索换绑池邮箱"
                                       className="mx-2 mt-2 px-2 py-1 border rounded outline-none"/>
                                <div className="flex-1 min-h-[180px] max-h-[340px] overflow-auto m-2 border rounded border-emerald-100">
                                    <table className="w-full">
                                        <thead className="bg-emerald-50/80 text-gray-500 sticky top-0">
                                            <tr>
                                                <th className="w-8 px-1 py-1">
                                                    <input type="checkbox" checked={readyAllSel} disabled={!readyVisible.length}
                                                           onChange={() => selectAllIds(setReadyPick, readyVisible, readyAllSel)}/>
                                                </th>
                                                <th className="text-left px-1 py-1">邮箱</th>
                                                <th className="w-10 px-1 py-1"></th>
                                            </tr>
                                        </thead>
                                        <tbody>
                                            {readyVisible.map((m) => (
                                                <tr key={m.id} className="border-t hover:bg-emerald-50/60">
                                                    <td className="px-1 py-1 text-center">
                                                        <input type="checkbox" checked={readyPick.has(m.id)}
                                                               onChange={() => toggleIdSet(setReadyPick, m.id)}/>
                                                    </td>
                                                    <td className="px-1 py-1 font-mono break-all">{m.email}</td>
                                                    <td className="px-1 py-1 text-center">
                                                        <button type="button" className="text-emerald-700 hover:underline"
                                                                onClick={() => copyRebindCreds([m], "")}>复制</button>
                                                    </td>
                                                </tr>
                                            ))}
                                        </tbody>
                                    </table>
                                    {!readyVisible.length && (
                                        <div className="py-8 text-center text-gray-400 px-3">
                                            换绑池为空。请在左侧勾选后「迁入换绑池」（服务端并行探 IMAP）。
                                        </div>
                                    )}
                                </div>
                                <div className="px-2 pb-2 text-gray-400">
                                    {readyPick.size
                                        ? `已勾选 ${readyPick.size}，确认换绑将只用勾选`
                                        : `未勾选则从整池 ${rebindPool.readyCount} 个里自动领`}
                                </div>
                            </div>
                        </div>
                        <div className="px-5 py-3 border-t flex flex-wrap justify-end gap-2">
                            <Btn onClick={() => setShowRebindGmail(false)} disabled={busy}>取消</Btn>
                            <Btn onClick={doConfirmRebindGmail} disabled={busy || !rebindPool.readyCount}
                                 className="bg-emerald-600 text-white border-emerald-600 hover:bg-emerald-700 disabled:opacity-40">
                                {readyPick.size
                                    ? `确认换绑（池内勾选 ${readyPick.size}）`
                                    : `确认换绑（换绑池 ${rebindPool.readyCount}）`}
                            </Btn>
                        </div>
                    </div>
                </div>
            )}

            {/* ====== 设置充值/交付分组弹窗 ====== */}
            {showSetBatch && (
                <div className="fixed inset-0 bg-black/30 flex items-center justify-center z-50" onClick={() => setShowSetBatch(false)}>
                    <div className="bg-white rounded-xl shadow-xl w-[360px] flex flex-col" onClick={(e) => e.stopPropagation()}>
                        <div className="px-5 py-3 border-b font-semibold text-sm">设置充值/交付分组</div>
                        <div className="p-5">
                            <input value={batchInput} onChange={(e) => setBatchInput(e.target.value)} placeholder="输入充值/交付分组名"
                                   className="w-full px-2 py-1.5 text-sm border rounded outline-none" autoFocus/>
                            <div className="text-xs text-gray-400 mt-2">将为当前页签选中的 {selQIds().length} 项设置分组(留空则清除)</div>
                        </div>
                        <div className="px-5 py-3 border-t flex justify-end gap-2">
                            <Btn onClick={() => setShowSetBatch(false)}>取消</Btn>
                            <Btn onClick={doSetBatch} className="bg-blue-600 text-white border-blue-600 hover:bg-blue-700">确定</Btn>
                        </div>
                    </div>
                </div>
            )}

            {/* ====== 批量获取 RT 弹窗 ====== */}
            {showBatchRt && (
                <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-30" onClick={() => !batchRtRunning && setShowBatchRt(false)}>
                    <div className="bg-white rounded-xl w-[700px] max-h-[85vh] flex flex-col shadow-2xl" onClick={(e) => e.stopPropagation()}>
                        <div className="px-5 py-3 border-b flex items-center justify-between">
                            <span className="font-medium text-sm">批量获取 RefreshToken <span className="text-xs text-gray-400 font-normal">走 OAuth 登录（Pro号无需接码）</span></span>
                            <button onClick={() => !batchRtRunning && setShowBatchRt(false)} disabled={batchRtRunning} className="text-gray-400 hover:text-gray-700 text-lg leading-none disabled:opacity-40">&times;</button>
                        </div>
                        <div className="px-5 py-4 space-y-3 text-sm overflow-auto">
                            <div className="text-xs text-gray-500">每行 <span className="font-mono">邮箱----密码</span> 或 <span className="font-mono">邮箱:密码</span>，走 codex OAuth 登录获取 refresh_token。</div>
                            <textarea value={batchRtInput} onChange={(e) => setBatchRtInput(e.target.value)} placeholder={"a@mail.com----password1\nb@mail.com:password2"} disabled={batchRtRunning}
                                      className="w-full h-24 px-2 py-1.5 border rounded text-xs font-mono resize-y disabled:bg-gray-50"/>
                            <div className="flex items-center gap-3">
                                <button onClick={async () => {
                                    const lines = batchRtInput.split("\n").map(l => l.trim()).filter(Boolean);
                                    const emails = lines.map(l => l.split(/----| |\t|:|;|,|\|/)[0].trim().toLowerCase()).filter(Boolean);
                                    if (!emails.length) { toast("请粘贴邮箱----密码列表"); return; }
                                    setBatchRtRunning(true);
                                    setBatchRtResults(emails.map((e, i) => ({email: e, ok: false, status: i === 0 ? "running" as const : "pending" as const, reason: i === 0 ? "已提交，正在登录…" : ""})));
                                    try { await api.batchAcquireRt(batchRtInput); } catch (e: any) { toast("请求失败: " + (e as Error).message); setBatchRtRunning(false); }
                                }} disabled={batchRtRunning} className={`px-4 py-1.5 rounded text-sm font-medium text-white ${batchRtRunning ? "bg-gray-400 cursor-not-allowed" : "bg-amber-600 hover:bg-amber-700"}`}>
                                    {batchRtRunning ? "获取中(OAuth登录)…" : "开始获取"}
                                </button>
                                {batchRtRunning && <button onClick={() => { api.stopBatchAcquireRt(); setBatchRtRunning(false); }} className="px-3 py-1.5 rounded text-sm font-medium text-white bg-red-500 hover:bg-red-600">停止</button>}
                                {batchRtResults.length > 0 && (() => {
                                    const finished = batchRtResults.filter((r) => r.status === "done").length;
                                    const success = batchRtResults.filter((r) => r.status === "done" && r.ok).length;
                                    const failed = finished - success;
                                    const percent = Math.round((finished / batchRtResults.length) * 100);
                                    return <div className="min-w-[250px] flex-1 max-w-[420px] space-y-1" aria-live="polite">
                                        <div className="flex justify-between text-xs tabular-nums"><span className="font-semibold text-gray-700">已完成 {finished}/{batchRtResults.length}</span><span className="text-gray-500">成功 {success} · 失败 {failed} · 进行中 {batchRtResults.length - finished}</span></div>
                                        <div className="h-2.5 rounded-full bg-gray-100 overflow-hidden"><div className="h-full bg-amber-500 transition-all" style={{width: `${percent}%`}}/></div>
                                    </div>;
                                })()}
                            </div>
                            {batchRtResults.length > 0 && (
                                <>
                                    <div className="max-h-52 overflow-auto border rounded">
                                        <table className="w-full text-xs">
                                            <thead className="bg-gray-100 text-gray-500 sticky top-0"><tr><th className="text-left px-2 py-1 w-8">#</th><th className="text-left px-2 py-1">邮箱</th><th className="text-left px-2 py-1">结果</th></tr></thead>
                                            <tbody>
                                                {batchRtResults.map((r, i) => (
                                                    <tr key={i} className="border-t">
                                                        <td className="px-2 py-1 text-gray-400">{i + 1}</td>
                                                        <td className="px-2 py-1 font-mono">{r.email}</td>
                                                        <td className="px-2 py-1">{r.status === "pending" ? <span className="text-gray-400">未开始</span> : r.status === "running" ? <span className="text-amber-600">进行中 {r.reason || ""}</span> : r.ok ? <span className="text-green-600">成功</span> : <span className="text-red-500">{r.reason || "失败"}</span>}</td>
                                                    </tr>
                                                ))}
                                            </tbody>
                                        </table>
                                    </div>
                                    <div>
                                        <span className="text-xs text-gray-500">成功项（邮箱----密码----rt，点击全选复制）:</span>
                                        <textarea readOnly value={batchRtResults.filter(r => r.ok && r.rt).map(r => `${r.email}----${r.password || ""}----${r.rt}`).join("\n")}
                                                  onClick={(e) => (e.target as HTMLTextAreaElement).select()} className="w-full h-20 px-2 py-1 border rounded text-xs font-mono bg-gray-50 select-text mt-1"/>
                                    </div>
                                </>
                            )}
                        </div>
                    </div>
                </div>
            )}

            {/* ====== 导出 sub2json 弹窗 ====== */}
            {showSub2json && (
                <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-30" onClick={() => { if (!sub2jsonRefreshing) setShowSub2json(false); }}>
                    <div className="bg-white rounded-xl w-[700px] max-h-[85vh] flex flex-col shadow-2xl" onClick={(e) => e.stopPropagation()}>
                        <div className="px-5 py-3 border-b flex items-center justify-between">
                            <span className="font-medium text-sm">导出 sub2json <span className="text-xs text-gray-400 font-normal">勾选填充 / 粘贴 → 刷新 token → sub2api JSON（Gmail 通用）</span></span>
                            <button onClick={() => { if (!sub2jsonRefreshing) setShowSub2json(false); }} className="text-gray-400 hover:text-gray-700 text-lg leading-none">&times;</button>
                        </div>
                        <div className="px-5 py-4 space-y-3 text-sm overflow-auto">
                            <div className="text-xs text-gray-500 space-y-1">
                                <div>每行 <span className="font-mono">邮箱----密码----refresh_token</span>；Gmail 全字段粘贴时末段为 RT、GPT 密码取倒数第 3 段。</div>
                                <div>也可点「从勾选填充」：用队列里的 <span className="font-mono">gpt_password</span>（Gmail）或邮箱密码 + 已存 RT。</div>
                            </div>
                            <div className="flex flex-wrap items-center gap-2">
                                <button type="button" disabled={sub2jsonRefreshing}
                                        onClick={() => fillSub2jsonFromSelection()}
                                        className="px-3 py-1 rounded text-xs font-medium border border-violet-300 text-violet-700 bg-violet-50 hover:bg-violet-100 disabled:opacity-40">
                                    从{selQIds().length ? `勾选填充 (${selQIds().length})` : `当前筛选填充 (${filteredQueue.length})`}
                                </button>
                                <span className="text-xs text-gray-400">未勾选时按当前批次/全队列导出预备行</span>
                            </div>
                            <textarea value={sub2jsonInput} onChange={(e) => setSub2jsonInput(e.target.value)}
                                      placeholder={"勾选后点「从勾选填充」，或粘贴：\na@gmail.com----gptPassword----rt_xxx\nb@mail.com----password2----rt_yyy"}
                                      className="w-full h-32 px-2 py-1.5 border rounded text-xs font-mono resize-y" disabled={sub2jsonRefreshing}/>
                            <div className="flex items-center gap-3">
                                <button disabled={sub2jsonRefreshing} onClick={async () => {
                                    const lines = sub2jsonInput.split("\n").map(l => l.trim()).filter(Boolean);
                                    const parsed = lines.map(parseSub2jsonLine);
                                    const items = parsed.filter(it => it.email && it.rt);
                                    const missingRt = parsed.filter(it => it.email && !it.rt).length;
                                    if (!items.length) {
                                        toast(missingRt ? `有 ${missingRt} 行缺 RT，请先「批量获取RT」或粘贴含 RT 的行` : "未解析到有效行(需邮箱+rt)");
                                        return;
                                    }
                                    if (missingRt) toast(`已跳过 ${missingRt} 行缺 RT`);
                                    setSub2jsonRefreshing(true);
                                    setSub2jsonResults([]);
                                    try {
                                        const resp = await api.refreshTokens(items);
                                        const results = resp.results || [];
                                        setSub2jsonResults(results);
                                        const ok = results.filter((r: any) => r.ok && r.tokens?.access_token);
                                        if (!ok.length) { toast(`全部刷新失败(${results.length}个)，无法导出`); return; }
                                        const payload = {
                                            exported_at: new Date().toISOString(),
                                            proxies: [] as any[],
                                            accounts: ok.map((r: any) => ({
                                                name: r.email,
                                                platform: "openai",
                                                type: "oauth",
                                                credentials: {
                                                    access_token: r.tokens.access_token,
                                                    refresh_token: r.tokens.refresh_token,
                                                    ...(r.tokens.id_token ? {id_token: r.tokens.id_token} : {}),
                                                    email: r.email,
                                                },
                                                concurrency: 1,
                                                priority: 0,
                                            })),
                                        };
                                        const blob = new Blob([JSON.stringify(payload, null, 2)], {type: "application/json;charset=utf-8"});
                                        const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = `sub2api-import-${ok.length}.json`; a.click(); URL.revokeObjectURL(a.href);
                                        toast(`已导出 ${ok.length}/${results.length} 个账号`);
                                    } catch (e: any) {
                                        toast("刷新请求失败: " + (e?.message || e));
                                    } finally {
                                        setSub2jsonRefreshing(false);
                                    }
                                }} className={`px-4 py-1.5 rounded text-sm font-medium text-white ${sub2jsonRefreshing ? "bg-gray-400 cursor-not-allowed" : "bg-violet-600 hover:bg-violet-700"}`}>
                                    {sub2jsonRefreshing ? "刷新 token 中..." : "刷新并导出"}
                                </button>
                                <span className="text-xs text-gray-400">
                                    {(() => {
                                        const lines = sub2jsonInput.split("\n").map(l => l.trim()).filter(Boolean);
                                        if (!lines.length) return "";
                                        const withRt = lines.map(parseSub2jsonLine).filter(it => it.email && it.rt).length;
                                        return `${lines.length} 行 / 含 RT ${withRt}`;
                                    })()}
                                </span>
                            </div>
                            {sub2jsonResults.length > 0 && (
                                <div className="border rounded p-2 max-h-40 overflow-auto text-xs space-y-0.5">
                                    {sub2jsonResults.map((r, i) => (
                                        <div key={i} className={r.ok ? "text-green-600" : "text-red-500"}>
                                            {r.email}: {r.ok ? "OK" : r.reason || "失败"}
                                        </div>
                                    ))}
                                </div>
                            )}
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}
