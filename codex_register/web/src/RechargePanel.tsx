import {useEffect, useState, useMemo, useRef, type Dispatch, type SetStateAction} from "react";
import {api, connectStream, type Account, type RebindGmailPoolItem, type RechargeCard, type RechargeCardStats, type RechargeQueueItem, type RechargeQueueStats} from "./api";

const p2 = (n: number) => String(n).padStart(2, "0");
/** 北京时间固定 Asia/Shanghai，不跟浏览器本地时区 */
const fmtBjParts = (ts: number, withSec = false) => {
    const parts = new Intl.DateTimeFormat("en-CA", {
        timeZone: "Asia/Shanghai",
        month: "2-digit", day: "2-digit",
        hour: "2-digit", minute: "2-digit",
        second: withSec ? "2-digit" : undefined,
        hour12: false,
    }).formatToParts(new Date(ts));
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
const EMPTY_Q: RechargeQueueStats = {pending: 0, paired: 0, submitting: 0, submitted: 0, done: 0, error: 0, total: 0, undelivered: 0, delivered: 0, failed: 0};
const EMPTY_C: RechargeCardStats = {unused: 0, paired: 0, submitting: 0, submitted: 0, done: 0, error: 0, total: 0};

/** 换绑展示：原邮箱 → 现邮箱 */
function rebindLine(q: RechargeQueueItem): {text: string; title: string; ok: boolean} {
    const from = String(q.rebind_from || "").trim();
    const to = String(q.rebind_email || q.email || "").trim();
    if (q.rebind_status === "ok" || (from && to && from !== to)) {
        const text = from && to && from !== to ? `${from} → ${to}` : (to || from || "已换绑");
        return {text, title: text, ok: true};
    }
    if (q.rebind_status === "pending") {
        const t = q.rebind_target === "mailcom" ? " mail.com" : q.rebind_target === "gmail" ? " Gmail" : "";
        return {text: `换绑中${t}`, title: q.rebind_error || "", ok: false};
    }
    if (q.rebind_status === "fail") return {text: q.rebind_error || "失败", title: q.rebind_error || "", ok: false};
    if (q.rebind_status === "skipped") return {text: "无需换绑", title: "", ok: false};
    return {text: "—", title: "", ok: false};
}

export function RechargePanel({notify}: {notify?: (m: string) => void}) {
    // 队列：未交付=作业中；失败=标失败/预检失败；已交付=移除后的历史
    const [deliveryTab, setDeliveryTab] = useState<"undelivered" | "error" | "delivered">("undelivered");
    const deliveryTabRef = useRef<"undelivered" | "error" | "delivered">("undelivered");
    deliveryTabRef.current = deliveryTab;
    const [queue, setQueue] = useState<RechargeQueueItem[]>([]);
    const [qStats, setQStats] = useState<RechargeQueueStats>(EMPTY_Q);
    const [qSel, setQSel] = useState<Set<number>>(new Set());
    const [qFilter, setQFilter] = useState("all");
    const [qBatchFilter, setQBatchFilter] = useState("");
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
    const [configInterval, setConfigInterval] = useState(3);
    const [configRtProxy, setConfigRtProxy] = useState("");
    const [configRtConcurrency, setConfigRtConcurrency] = useState(4);
    const [configRebindAfterPaid, setConfigRebindAfterPaid] = useState<"off" | "gmail" | "mailcom">("gmail");
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
    const [showSetBatch, setShowSetBatch] = useState(false);
    const [batchInput, setBatchInput] = useState("");
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
    // 状态
    const [busy, setBusy] = useState(false);
    const [logs, setLogs] = useState<{ts: number; line: string}[]>([]);
    const logBoxRef = useRef<HTMLDivElement>(null);
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

    const toast = (m: string) => notify?.(m);
    const isDeliveredTab = deliveryTab === "delivered";
    const isFailedTab = deliveryTab === "error";
    const isWorkingTab = deliveryTab === "undelivered";
    /** SSE 异步导出 RT 完成后回调（ref 避免 effect 闭包拿不到最新 deliver） */
    const deliverExportTextRef = useRef<(text: string, format: "account" | "full" | "card" | "session") => Promise<void>>(async () => {});

    const loadQueue = () => {
        const d = deliveryTabRef.current;
        api.rechargeQueue(d).then((r) => { setQueue(r.list); setQStats(r.stats); }).catch(() => {});
        api.rechargeQueueBatches(d).then(setQBatches).catch(() => {});
    };
    const loadCards = () => api.rechargeCards().then((r) => { setCards(r.list); setCStats(r.stats); }).catch(() => {});
    const applyRebindCounts = (c: {gmailFreeImap?: number; mailcomFree?: number; rebindAfterPaid?: string; rebindGmailAfterPaid?: boolean}) => {
        if (typeof c.gmailFreeImap === "number") setGmailFreeImap(c.gmailFreeImap);
        if (typeof c.mailcomFree === "number") setMailcomFree(c.mailcomFree);
        if (c.rebindAfterPaid === "off" || c.rebindAfterPaid === "gmail" || c.rebindAfterPaid === "mailcom") setConfigRebindAfterPaid(c.rebindAfterPaid);
        else if (typeof c.rebindGmailAfterPaid === "boolean") setConfigRebindAfterPaid(c.rebindGmailAfterPaid ? "gmail" : "off");
    };
    const loadConfig = () => api.rechargeConfig().then((c) => { setConfigBase(c.baseUrl); setConfigAppId(c.appId || ""); setConfigKey(c.apiKey); setConfigIp(c.forwardIp); setConfigConcurrency(c.concurrency || 3); setConfigInterval(c.interval || 3); setConfigRtProxy(c.rtProxy || ""); setConfigRtConcurrency(c.rtConcurrency || 4); applyRebindCounts(c); setHasKey(!!c.hasKey); setInstanceId(c.instanceId || ""); }).catch(() => {});
    const loadLogs = () => api.rechargeLogs().then((rows) => setLogs(Array.isArray(rows) ? rows.slice(-500) : [])).catch(() => {});

    useEffect(() => {
        loadQueue(); loadCards(); loadConfig(); loadLogs();
        const off = connectStream((ev, data: any) => {
            if (ev === "rechargeQueue") {
                // 服务端广播始终是未交付列表；统计含 undelivered/delivered 计数
                setQStats(data.stats || EMPTY_Q);
                if (deliveryTabRef.current === "undelivered") setQueue(data.list || []);
            }
            if (ev === "recharge") { setCards(data.list || []); setCStats(data.stats || EMPTY_C); }
            if (ev === "rechargeLog") {
                setLogs((prev) => [...prev.slice(-500), data]);
                if (/^换绑 [✓✗]/.test(String(data?.line || ""))) loadConfig();
            }
            if (ev === "batchRtAcquire") { setBatchRtResults(data.results.map((r: any) => ({...r, status: r.status || "done"}))); if (data.done) setBatchRtRunning(false); }
            if (ev === "rechargeExportReady" && data?.text) {
                void deliverExportTextRef.current(String(data.text), "full");
            }
        });
        // SSE 重连会丢中间事件；换绑卡在 mail.com 时也要靠轮询把磁盘日志刷出来
        const poll = setInterval(() => { loadLogs(); loadQueue(); }, 4000);
        return () => { off(); clearInterval(poll); };
    }, []);

    // 切换 未交付/已交付 时重新拉列表
    useEffect(() => {
        setQSel(new Set());
        setQFilter("all");
        setQBatchFilter("");
        loadQueue();
    }, [deliveryTab]);

    useEffect(() => {
        const el = logBoxRef.current;
        if (el) el.scrollTop = el.scrollHeight;
    }, [logs]);

    // 队列筛选
    const filteredQueue = useMemo(() => {
        return queue.filter((q) => {
            if (qFilter === "undone") { if (q.status === "done" || q.status === "error") return false; }
            else if (qFilter === "finished" || qFilter === "done") { if (q.status !== "done") return false; }
            else if (qFilter !== "all" && q.status !== qFilter) return false;
            if (qBatchFilter && (q.batch || "") !== qBatchFilter) return false;
            return true;
        });
    }, [queue, qFilter, qBatchFilter]);

    const toggleQSel = (id: number) => setQSel((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
    const fqIds = filteredQueue.map((q) => q.id);
    const allQSel = fqIds.length > 0 && fqIds.every((id) => qSel.has(id));
    const toggleAllQ = () => setQSel(allQSel ? new Set() : new Set(fqIds));
    const selQIds = () => [...qSel].filter((id) => filteredQueue.some((q) => q.id === id));

    // 卡密列表(简化显示)
    const toggleCSel = (id: number) => setCSel((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });

    // ---- 操作 ----
    const doSaveConfig = async () => {
        setBusy(true);
        try {
            const body: any = {baseUrl: configBase, appId: configAppId, forwardIp: configIp, concurrency: configConcurrency, interval: configInterval, rtProxy: configRtProxy, rtConcurrency: configRtConcurrency, rebindAfterPaid: configRebindAfterPaid};
            if (configKey && !configKey.includes("****")) body.apiKey = configKey;
            await api.setRechargeConfig(body);
            loadConfig(); toast("配置已保存"); setShowConfig(false);
        } catch (e: any) { toast("保存失败: " + e.message); } finally { setBusy(false); }
    };

    // 选号入队(搬 GPT 面板筛选条件:批次 + 质量 facet)
    const [pickerFacets, setPickerFacets] = useState<Set<string>>(new Set());
    const togglePickerFacet = (k: string) => setPickerFacets((s) => { const n = new Set(s); n.has(k) ? n.delete(k) : n.add(k); return n; });

    const PICKER_FACETS: Record<string, {group: string; label: string; pred: (a: Account) => boolean}> = useMemo(() => ({
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
            setAccounts(accs); setPickerSel(new Set()); setPickerSearch(""); setPickerBatch(""); setRechargeBatch(""); setPickerFacets(new Set()); setShowPicker(true);
        } catch (e: any) { toast("获取账号列表失败: " + e.message); }
    };

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

    const doAddToQueue = async () => {
        const ids = [...pickerSel];
        if (!ids.length) return;
        if (!confirm(`确认将 ${ids.length} 个账号加入充值队列?\n这些账号将在 GPT 面板中标记为已售出。`)) return;
        setBusy(true); setShowPicker(false);
        try {
            const r = await api.addToRechargeQueue(ids, rechargeBatch);
            toast(`已入队 ${r.added} 个账号`);
            loadQueue();
        } catch (e: any) { toast("入队失败: " + e.message); } finally { setBusy(false); }
    };

    /** 标记已交付：从作业队列移到「已交付」tab，保留账号与换绑记录 */
    const doRemoveFromQueue = async () => {
        const ids = selQIds();
        if (!ids.length) return;
        if (!confirm(`确认将选中项里「已充上」的号标记为已交付？\n失败 / 退回 / 待提交的不会搬走。`)) return;
        try {
            const r = await api.deliverRechargeQueue(ids);
            setQSel(new Set()); loadQueue();
            const skip = r.skipped ? `，跳过 ${r.skipped} 个未成功` : "";
            toast(r.count ? `已交付 ${r.count} 个${skip}` : (r.skipped ? "所选都还没充上，没有搬走" : "没有可交付的"));
        } catch (e: any) { toast("标记已交付失败: " + e.message); }
    };

    /** 已交付 → 退回未交付 */
    const doUndeliver = async () => {
        const ids = selQIds();
        if (!ids.length) return;
        if (!confirm(`确认将 ${ids.length} 个账号退回未交付？\n会重新出现在作业队列。`)) return;
        try {
            const r = await api.undeliverRechargeQueue(ids);
            setQSel(new Set()); loadQueue(); toast(`已退回未交付 ${r.count ?? ids.length} 个`);
        } catch (e: any) { toast("退回失败: " + e.message); }
    };

    const doSetBatch = async () => {
        const ids = selQIds();
        if (!ids.length) { toast("请先选择队列项"); return; }
        try {
            await api.setRechargeQueueBatch(ids, batchInput);
            setShowSetBatch(false); loadQueue(); toast("批次已设置");
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
            toast(`已开始提交 ${pendingIds.length} 个充值任务`);
        } catch (e: any) { toast("提交失败: " + e.message); } finally { setBusy(false); }
    };

    const doReset = async () => {
        const ids = selQIds();
        if (!ids.length) { toast("请先选择队列项"); return; }
        try { await api.resetRechargeQueue(ids); setQSel(new Set()); loadQueue(); toast("已重置为待提交"); } catch (e: any) { toast(e.message); }
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
    const doStop = async () => { try { await api.stopRecharge(); toast("已发送停止信号"); } catch (e: any) { toast(e.message); } };
    const doRelogin = async () => {
        const ids = selQIds();
        if (!ids.length) { toast("请先选择队列项"); return; }
        if (!confirm(`确认对 ${ids.length} 个账号「重登并提交」？\n由本机执行（其他实例不会抢）。\n逐个执行：浏览器重新登录取 session → 查卡密平台状态 → 重置任务 → 用原卡密重新提交。\n原卡密若在平台已被消费(可能已充值成功)会自动跳过，不会重复扣卡。`)) return;
        try {
            const r = await api.rechargeQueueReloginSubmit(ids);
            toast(`本机开始重登并提交 ${r.claimed ?? r.count} 个${r.skipped ? `，${r.skipped} 个已被其他实例占用` : ""}，进度见日志`);
        } catch (e: any) { toast(e.message); }
    };
    const doStopRelogin = async () => { try { await api.stopRechargeQueueRelogin(); toast("已发送停止信号"); } catch (e: any) { toast(e.message); } };
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
            toast(q && !q.card_code ? `${q.email} 仍是待提交、没有卡密，刷新不到平台状态` : "选中项无需刷新");
            return;
        }
        setBusy(true);
        try { const r = await api.pollRecharge(selected.length ? pollable : undefined); toast(`已刷新 ${r.updated} 个任务状态`); loadQueue(); }
        catch (e: any) { toast(e.message); } finally { setBusy(false); }
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
            const r = await api.rebindGmail(ids, target, opts);
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
            const r = await api.migrateToRebindGmailPool(ids);
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
    /** 从勾选队列项（或当前批次）拉取 email----gpt密码----rt，Gmail 用 gpt_password */
    const fillSub2jsonFromSelection = async (opts?: {silent?: boolean}) => {
        const ids = selQIds();
        try {
            const r = await api.exportRechargeQueue({
                ids: ids.length ? ids : undefined,
                batch: !ids.length && qBatchFilter ? qBatchFilter : undefined,
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
                else toast(`已从${ids.length ? `勾选 ${ids.length} 项` : qBatchFilter ? `批次 ${qBatchFilter}` : "队列"}填充 ${total} 行`);
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
        const ids = selQIds();
        if (ids.length || qBatchFilter) {
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
    const doExport = async (format: "account" | "full" | "card" | "session") => {
        const ids = selQIds();
        try {
            const r = await api.exportRechargeQueue({ids: ids.length ? ids : undefined, batch: qBatchFilter || undefined, format});
            if (r.text) {
                await deliverExportText(r.text, format);
            } else if (r.async) {
                toast(`${r.needRt} 个账号缺少 RT，正在自动获取，完成后自动下载...`);
            }
        } catch (e: any) { toast("导出失败: " + e.message); }
    };
    const doProbePlan = async () => {
        const ids = selQIds();
        try {
            const r = await api.probePlan(ids.length ? ids : undefined, qBatchFilter || undefined);
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
                        <label className="block"><span className="text-xs text-gray-500 mb-1 block">RT 并发数</span>
                            <input type="number" value={configRtConcurrency} onChange={(e) => setConfigRtConcurrency(Math.max(1, Math.min(20, Number(e.target.value) || 4)))}
                                   min={1} max={20} className="w-full px-2 py-1.5 text-sm border rounded outline-none"/></label>
                        <label className="block col-span-2">
                            <span className="text-xs text-gray-500 mb-1 block">平台回 paid 后换绑（不在点提交时换；旧邮箱标已售、不返还）</span>
                            <select value={configRebindAfterPaid} onChange={(e) => setConfigRebindAfterPaid(e.target.value as "off" | "gmail" | "mailcom")}
                                    className="px-2 py-1.5 text-sm border rounded outline-none">
                                <option value="off">关闭</option>
                                <option value="gmail">换绑空闲 Gmail（需已开 IMAP）</option>
                                <option value="mailcom">换绑空闲 mail.com</option>
                            </select>
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
                            {qStats.undelivered ?? qStats.total}
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
                        {isDeliveredTab ? "已交付可查看换绑记录；可退回未交付"
                            : isFailedTab ? "只有点过「标记失败」的号；提交失败不会自动进来"
                            : "提交失败仍留在未交付；只有点「标记失败」才进中间页"}
                    </span>
                </div>

                <div className="px-4 py-3 border-b flex items-center gap-2 flex-wrap">
                    <span className="text-sm font-semibold">{isDeliveredTab ? "已交付列表" : isFailedTab ? "失败列表" : "充值队列"}</span>
                    {isWorkingTab && (
                        <>
                            <Btn onClick={openPicker} className="bg-blue-600 text-white border-blue-600 hover:bg-blue-700">+ 选择账号入队</Btn>
                            <Btn onClick={() => { setShowSetBatch(true); setBatchInput(""); }}>设置批次</Btn>
                            <Btn onClick={doReset}>重置</Btn>
                            <Btn onClick={() => doMarkError()} className="bg-white border-red-200 text-red-600 hover:bg-red-50" title="号进失败页，卡密放回未使用，方便换号再提；已充上的不动">标记失败</Btn>
                            <Btn onClick={doReclaimCards}>回收卡密</Btn>
                            <Btn onClick={doRemoveFromQueue} className="bg-white border-emerald-200 text-emerald-700 hover:bg-emerald-50" title="标记已交付：保留账号与换绑记录，移入「已交付」">标记已交付</Btn>
                            <div className="border-l mx-1 h-5"/>
                            <span className="text-xs text-gray-500 tabular-nums">已选 <b className="text-blue-600">{selQIds().length}</b> / {filteredQueue.length}</span>
                            <Btn onClick={() => doSubmit(selQIds())} disabled={!hasKey || cStats.unused === 0} className="bg-green-600 text-white border-green-600 hover:bg-green-700">提交选中 ({selQIds().length})</Btn>
                            <Btn onClick={() => doSubmit(filteredQueue.filter((q) => q.status === "pending").map((q) => q.id))} disabled={!hasKey || cStats.unused === 0}>全部提交 ({filteredQueue.filter((q) => q.status === "pending").length})</Btn>
                            <Btn onClick={doPoll}>刷新状态</Btn>
                            <Btn onClick={() => doRebind("gmail")} title="对已付费项换绑 Gmail（mail.com→Gmail 或 Gmail→Gmail 均可）；迁入时探 IMAP，换绑领号时探网页登录">换绑 Gmail</Btn>
                            <Btn onClick={() => doRebind("mailcom")} title="对已付费项手动换绑 mail.com；旧邮箱标已售">换绑 mail.com</Btn>
                            <Btn onClick={doStop} className="bg-white border-red-200 text-red-600 hover:bg-red-50">停止</Btn>
                            <Btn onClick={doRelogin} title="重登取 session → 验卡 → 重置 → 用原卡密重提(卡密已消费则跳过)" className="bg-amber-500 text-white border-amber-500 hover:bg-amber-600">重登并提交</Btn>
                            <Btn onClick={doStopRelogin} className="bg-white border-red-200 text-red-600 hover:bg-red-50">停止登录</Btn>
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
                    {isDeliveredTab && (
                        <>
                            <Btn onClick={doUndeliver} className="bg-white border-blue-200 text-blue-700 hover:bg-blue-50">退回未交付</Btn>
                            <div className="border-l mx-1 h-5"/>
                        </>
                    )}
                    <Btn onClick={() => doExport("account")}>导出账密</Btn>
                    <Btn onClick={() => doExport("full")}>导出含RT</Btn>
                    <Btn onClick={() => doExport("card")}>复制卡密</Btn>
                    <Btn onClick={() => doExport("session")}>复制session</Btn>
                    {isWorkingTab && (
                        <>
                            <Btn onClick={() => setShowBatchRt(true)} className="bg-amber-600 text-white border-amber-600 hover:bg-amber-700">批量获取RT</Btn>
                            <Btn onClick={openSub2json} className="bg-violet-600 text-white border-violet-600 hover:bg-violet-700" title="勾选后打开会自动填充；支持 Gmail（用 GPT 密码 + RT）">导出sub2json</Btn>
                            <Btn onClick={doProbePlan}>查询套餐</Btn>
                        </>
                    )}
                    <div className="flex-1"/>
                    {/* 筛选：已交付主要看批次；未交付看作业状态 */}
                    <div className="flex items-center gap-1 text-xs">
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
                                <option value="">全部批次</option>
                                {qBatches.map((b) => <option key={b.name} value={b.name}>{b.name} ({b.n})</option>)}
                            </select>
                        )}
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
                                <th className="text-left px-2 py-2 font-medium text-gray-500">批次</th>
                                {isWorkingTab && <th className="text-left px-2 py-2 font-medium text-gray-500">实例</th>}
                                <th className="text-left px-2 py-2 font-medium text-gray-500">状态</th>
                                <th className="text-left px-2 py-2 font-medium text-gray-500">卡密</th>
                                <th className="text-left px-2 py-2 font-medium text-gray-500">提交时间</th>
                                <th className="text-left px-2 py-2 font-medium text-gray-500">完成时间</th>
                                {isDeliveredTab && <th className="text-left px-2 py-2 font-medium text-gray-500">交付时间</th>}
                                {(isWorkingTab || isFailedTab) && <th className="text-left px-2 py-2 font-medium text-gray-500">耗时</th>}
                                <th className="text-left px-2 py-2 font-medium text-gray-500">任务状态</th>
                                {isWorkingTab && <th className="text-left px-2 py-2 font-medium text-gray-500">换绑</th>}
                                <th className="text-left px-2 py-2 font-medium text-gray-500">消息</th>
                                {(isWorkingTab || isFailedTab) && <th className="text-left px-2 py-2 font-medium text-gray-500">操作</th>}
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
                                    <td className="px-2 py-1.5 text-gray-500">{q.batch || "—"}</td>
                                    {isWorkingTab && (
                                    <td className="px-2 py-1.5 text-xs font-mono" title={q.instance_id || ""}>
                                        {!q.instance_id ? <span className="text-gray-300">—</span>
                                            : q.instance_id === instanceId ? <span className="text-blue-600">本机</span>
                                            : <span className="text-amber-600">{q.instance_id}</span>}
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
                                    {isWorkingTab && (
                                    <td className="px-2 py-1.5 max-w-[200px] truncate" title={rb.title || q.rebind_error || q.rebind_email || ""}>
                                        {rb.ok ? <span className="text-green-600" title={rb.title}>{rb.text}</span>
                                            : q.rebind_status === "pending" ? <span className="text-amber-600">{rb.text}</span>
                                            : q.rebind_status === "fail" ? <span className="text-red-500">{rb.text}</span>
                                            : q.rebind_status === "skipped" ? <span className="text-gray-400">{rb.text}</span>
                                            : <span className="text-gray-300">—</span>}
                                    </td>
                                    )}
                                    <td className="px-2 py-1.5 text-gray-500 max-w-[180px] truncate" title={q.task_message || q.error || ""}>
                                        {q.error ? <span className="text-red-500">{q.error}</span> : (q.task_message || "—")}
                                    </td>
                                    {(isWorkingTab || isFailedTab) && (
                                    <td className="px-2 py-1.5" onClick={(e) => e.stopPropagation()}>
                                        {q.status !== "done" && q.status !== "pending" && q.card_code && (
                                            <button onClick={() => { api.pollRecharge([q.id]).then(() => { toast(`已刷新 ${q.email}`); loadQueue(); }).catch((e: any) => toast(e.message)); }}
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
                                            <button onClick={() => { api.rebindGmail([q.id], (q.rebind_target === "mailcom" ? "mailcom" : "gmail")).then((r) => { toast(r.queued ? "已排队换绑" : (r.skipped[0]?.reason || "已跳过")); loadQueue(); loadConfig(); }).catch((e: any) => toast(e.message)); }}
                                                    className="text-blue-500 hover:text-blue-700 text-xs hover:underline ml-2">重试换绑</button>
                                        )}
                                        {(q.status === "done" || q.task_status === "paid") && q.rebind_status !== "pending" && (
                                            <>
                                                <button onClick={() => openRebindGmail([q.id])}
                                                        className="text-blue-500 hover:text-blue-700 text-xs hover:underline ml-2">换绑Gmail</button>
                                                <button onClick={() => { api.rebindGmail([q.id], "mailcom").then((r) => { toast(r.queued ? "已排队换绑 mail.com" : (r.skipped[0]?.reason || "已跳过")); loadQueue(); loadConfig(); }).catch((e: any) => toast(e.message)); }}
                                                        className="text-blue-500 hover:text-blue-700 text-xs hover:underline ml-2">换绑mail</button>
                                            </>
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
                                    <td colSpan={isDeliveredTab ? 11 : isFailedTab ? 12 : 14} className="text-center py-8 text-gray-400">
                                        {isDeliveredTab ? "暂无已交付账号；在「未交付」中点「标记已交付」后会出现在这里"
                                            : isFailedTab ? "没有人工标记失败的号。提交失败仍在「未交付」"
                                            : "队列为空，点击「选择账号入队」添加"}
                                    </td>
                                </tr>
                            )}
                        </tbody>
                    </table>
                </div>
            </div>

            {/* ====== 卡密池 ====== */}
            <div className="bg-white rounded-lg border shadow-sm">
                <div className="px-4 py-3 border-b flex items-center gap-2 flex-wrap">
                    <span className="text-sm font-semibold">卡密池</span>
                    <Btn onClick={() => setShowImport(true)}>+ 导入卡密</Btn>
                    <Btn onClick={doValidate}>验证选中</Btn>
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

            {/* ====== 操作日志 ====== */}
            <div className="bg-white rounded-lg border shadow-sm">
                <div className="px-4 py-2 border-b flex items-center justify-between">
                    <span className="text-sm font-semibold">操作日志 <span className="text-xs font-normal text-gray-400">{logs.length ? `${logs.length} 条` : ""}</span></span>
                    <button onClick={() => { api.clearRechargeLogs().then(() => setLogs([])).catch(() => setLogs([])); }} className="text-xs text-gray-400 hover:text-gray-600">清空</button>
                </div>
                <div ref={logBoxRef} className="max-h-[280px] overflow-auto bg-gray-50 p-3 font-mono text-xs text-gray-600 space-y-0.5">
                    {logs.length ? logs.map((l, i) => {
                        const line = String(l.line || "");
                        const cls = /换绑 ✗|^✗/.test(line) ? "text-red-500"
                            : /换绑 ✓|^✓/.test(line) ? "text-green-600"
                            : /换绑/.test(line) ? "text-amber-800"
                            : "";
                        return (
                        <div key={`${l.ts}-${i}`} className="flex gap-2">
                            <span className="text-gray-400 shrink-0">{fmtLogTime(l.ts)}</span>
                            <span className={cls}>{line}</span>
                        </div>
                        );
                    }) : <div className="text-gray-400">暂无日志。提交/轮询/换绑会写到这里，刷新页面也会保留。</div>}
                </div>
            </div>

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
                    <div className="bg-white rounded-xl shadow-xl w-[700px] max-h-[80vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
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
                                    <option value="">全部批次 ({accounts.length})</option>
                                    {pickerBatches.map((b) => <option key={b.name} value={b.name}>{b.name || "(无批次)"} ({b.n})</option>)}
                                </select>
                                <input value={rechargeBatch} onChange={(e) => setRechargeBatch(e.target.value)} placeholder="充值批次名(可选)"
                                       className="w-36 px-2 py-1 text-xs border rounded outline-none"/>
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
                        </div>
                        <div className="flex-1 overflow-auto max-h-[400px]">
                            <table className="w-full text-xs">
                                <thead className="bg-gray-50 sticky top-0">
                                    <tr>
                                        <th className="w-8 px-2 py-2"><input type="checkbox" checked={pickerAllSel} onChange={pickerToggleAll}/></th>
                                        <th className="text-left px-2 py-2 font-medium text-gray-500">邮箱</th>
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
                                            <td className="px-2 py-1.5 text-gray-500">{a.plan || "—"}</td>
                                            <td className="px-2 py-1.5">{a.at_status ? <span className={/✅/.test(a.at_status) ? "text-green-600" : /❌/.test(a.at_status) ? "text-red-500" : "text-gray-400"}>{a.at_status}</span> : <span className="text-gray-300">未测</span>}</td>
                                            <td className="px-2 py-1.5">{a.pw_status ? <span className={String(a.pw_status).includes("✅") ? "text-green-600" : "text-red-500"}>{a.pw_status}</span> : <span className="text-gray-300">—</span>}</td>
                                            <td className="px-2 py-1.5 text-gray-400">{a.batch || "—"}</td>
                                        </tr>
                                    ))}
                                    {!pickerFiltered.length && <tr><td colSpan={6} className="text-center py-8 text-gray-400">无可充值的账号</td></tr>}
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

            {/* ====== 换绑 Gmail：验证区分组 → 迁入换绑池 → 从换绑池换绑 ====== */}
            {showRebindGmail && (
                <div className="fixed inset-0 bg-black/30 flex items-center justify-center z-50" onClick={() => !busy && setShowRebindGmail(false)}>
                    <div className="bg-white rounded-xl shadow-xl w-[960px] max-w-[96vw] max-h-[92vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
                        <div className="px-5 py-3 border-b font-semibold text-sm flex items-start gap-3">
                            <div className="flex-1 min-w-0">
                                换绑 Gmail
                                <div className="text-xs text-gray-400 font-normal mt-0.5">
                                    给 <b className="text-gray-600">{rebindIds.length}</b> 个已付费号（支持 mail.com→Gmail，也支持 Gmail→Gmail 再换一把）。
                                    流程：① 左侧按分组选号 → ② 迁入「{rebindPool.poolGrp}」时并行探 IMAP（只探一次）→ ③ 换绑领号时只探网页登录。
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

            {/* ====== 设置批次弹窗 ====== */}
            {showSetBatch && (
                <div className="fixed inset-0 bg-black/30 flex items-center justify-center z-50" onClick={() => setShowSetBatch(false)}>
                    <div className="bg-white rounded-xl shadow-xl w-[360px] flex flex-col" onClick={(e) => e.stopPropagation()}>
                        <div className="px-5 py-3 border-b font-semibold text-sm">设置批次</div>
                        <div className="p-5">
                            <input value={batchInput} onChange={(e) => setBatchInput(e.target.value)} placeholder="输入批次名"
                                   className="w-full px-2 py-1.5 text-sm border rounded outline-none" autoFocus/>
                            <div className="text-xs text-gray-400 mt-2">将为选中的 {selQIds().length} 项设置批次名(留空则清除)</div>
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
                                {batchRtResults.length > 0 && <span className="text-xs text-gray-500">成功 {batchRtResults.filter(r => r.ok).length}/{batchRtResults.length}</span>}
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
                                    从勾选填充{selQIds().length ? ` (${selQIds().length})` : qBatchFilter ? ` (批次)` : ""}
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
