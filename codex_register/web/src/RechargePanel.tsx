import {useEffect, useState, useMemo} from "react";
import {api, connectStream, type Account, type RechargeCard, type RechargeCardStats, type RechargeQueueItem, type RechargeQueueStats} from "./api";

const p2 = (n: number) => String(n).padStart(2, "0");
const fmtTime = (ts?: number) => { if (!ts) return "—"; const d = new Date(ts); return `${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}`; };

const Q_LABEL: Record<string, string> = {pending: "待提交", paired: "已配对", submitting: "提交中", submitted: "已提交", done: "完成", error: "失败"};
const Q_COLOR: Record<string, string> = {pending: "#6b7280", paired: "#2563eb", submitting: "#f59e0b", submitted: "#8b5cf6", done: "#16a34a", error: "#dc2626"};
const TASK_COLOR: Record<string, string> = {pending: "#6b7280", leased: "#2563eb", running: "#2563eb", paid: "#16a34a", failed: "#dc2626", canceled: "#dc2626", returned: "#f59e0b", manual_review: "#f59e0b"};
const EMPTY_Q: RechargeQueueStats = {pending: 0, paired: 0, submitting: 0, submitted: 0, done: 0, error: 0, total: 0};
const EMPTY_C: RechargeCardStats = {unused: 0, paired: 0, submitting: 0, submitted: 0, done: 0, error: 0, total: 0};

export function RechargePanel({notify}: {notify?: (m: string) => void}) {
    // 队列
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
    const [hasKey, setHasKey] = useState(false);
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
    // 状态
    const [busy, setBusy] = useState(false);
    const [logs, setLogs] = useState<{ts: number; line: string}[]>([]);

    const toast = (m: string) => notify?.(m);

    const loadQueue = () => { api.rechargeQueue().then((r) => { setQueue(r.list); setQStats(r.stats); }).catch(() => {}); api.rechargeQueueBatches().then(setQBatches).catch(() => {}); };
    const loadCards = () => api.rechargeCards().then((r) => { setCards(r.list); setCStats(r.stats); }).catch(() => {});
    const loadConfig = () => api.rechargeConfig().then((c) => { setConfigBase(c.baseUrl); setConfigAppId(c.appId || ""); setConfigKey(c.apiKey); setConfigIp(c.forwardIp); setConfigConcurrency(c.concurrency || 3); setConfigInterval(c.interval || 3); setHasKey(!!c.hasKey); }).catch(() => {});

    useEffect(() => {
        loadQueue(); loadCards(); loadConfig();
        const off = connectStream((ev, data: any) => {
            if (ev === "rechargeQueue") { setQueue(data.list || []); setQStats(data.stats || EMPTY_Q); }
            if (ev === "recharge") { setCards(data.list || []); setCStats(data.stats || EMPTY_C); }
            if (ev === "rechargeLog") setLogs((prev) => [...prev.slice(-500), data]);
            if (ev === "rechargeExportReady" && data?.text) {
                const blob = new Blob([data.text], {type: "text/plain;charset=utf-8"});
                const url = URL.createObjectURL(blob);
                const a = Object.assign(document.createElement("a"), {href: url, download: "recharge-full.txt"});
                a.click(); URL.revokeObjectURL(url);
            }
        });
        return off;
    }, []);

    // 队列筛选
    const filteredQueue = useMemo(() => {
        return queue.filter((q) => {
            if (qFilter === "undone") { if (q.status === "done" || q.status === "error") return false; }
            else if (qFilter === "finished") { if (q.status !== "done" && q.status !== "error") return false; }
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
            const body: any = {baseUrl: configBase, appId: configAppId, forwardIp: configIp, concurrency: configConcurrency, interval: configInterval};
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

    const doRemoveFromQueue = async () => {
        const ids = selQIds();
        if (!ids.length) return;
        if (!confirm(`确认移出 ${ids.length} 个账号?\n对应 GPT 账号将恢复为未售出。`)) return;
        try {
            await api.removeFromRechargeQueue(ids);
            setQSel(new Set()); loadQueue(); toast(`已移出 ${ids.length} 个`);
        } catch (e: any) { toast("移出失败: " + e.message); }
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
        if (!confirm(`确认提交 ${pendingIds.length} 个账号充值?\n将自动配对 ${pendingIds.length} 个卡密。`)) return;
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
    const doStop = async () => { try { await api.stopRecharge(); toast("已发送停止信号"); } catch (e: any) { toast(e.message); } };
    const doPoll = async () => {
        const ids = selQIds().filter((id) => { const q = queue.find((x) => x.id === id); return q && q.card_code && q.status !== "done" && q.status !== "pending"; });
        setBusy(true);
        try { const r = await api.pollRecharge(ids.length ? ids : undefined); toast(`已刷新 ${r.updated} 个任务状态`); loadQueue(); }
        catch (e: any) { toast(e.message); } finally { setBusy(false); }
    };

    // 导出
    const downloadText = (text: string, filename: string) => {
        const blob = new Blob([text], {type: "text/plain;charset=utf-8"});
        const url = URL.createObjectURL(blob);
        const a = Object.assign(document.createElement("a"), {href: url, download: filename});
        a.click(); URL.revokeObjectURL(url);
    };
    const doExport = async (format: "account" | "full") => {
        const ids = selQIds();
        try {
            const r = await api.exportRechargeQueue({ids: ids.length ? ids : undefined, batch: qBatchFilter || undefined, format});
            if (r.text) {
                downloadText(r.text, format === "full" ? "recharge-full.txt" : "recharge-accounts.txt");
                toast("导出完成");
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

    const Btn = ({onClick, disabled, className, children}: any) => (
        <button onClick={onClick} disabled={disabled || busy}
                className={`px-3 py-1.5 rounded text-xs font-medium border transition disabled:opacity-40 ${className || "bg-white border-gray-200 text-gray-700 hover:bg-gray-50"}`}>
            {children}
        </button>
    );

    return (
        <div className="flex-1 overflow-auto p-6 space-y-4">
            {/* 标题 */}
            <div className="flex items-center gap-3 flex-wrap">
                <h2 className="text-lg font-bold">💳 充值提交</h2>
                <Btn onClick={() => { setShowConfig(!showConfig); if (!showConfig) loadConfig(); }}>
                    {showConfig ? "收起配置" : "⚙ API 配置"}
                </Btn>
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
                    </div>
                    <div className="flex justify-end">
                        <Btn onClick={doSaveConfig} className="bg-blue-600 text-white border-blue-600 hover:bg-blue-700">保存配置</Btn>
                    </div>
                </div>
            )}

            {/* ====== 充值队列(核心) ====== */}
            <div className="bg-white rounded-lg border shadow-sm">
                <div className="px-4 py-3 border-b flex items-center gap-2 flex-wrap">
                    <span className="text-sm font-semibold">充值队列</span>
                    <Btn onClick={openPicker} className="bg-blue-600 text-white border-blue-600 hover:bg-blue-700">+ 选择账号入队</Btn>
                    <Btn onClick={() => { setShowSetBatch(true); setBatchInput(""); }}>设置批次</Btn>
                    <Btn onClick={doReset}>重置</Btn>
                    <Btn onClick={doRemoveFromQueue} className="bg-white border-red-200 text-red-600 hover:bg-red-50">移出队列</Btn>
                    <div className="border-l mx-1 h-5"/>
                    <Btn onClick={() => doSubmit(selQIds())} disabled={!hasKey || cStats.unused === 0} className="bg-green-600 text-white border-green-600 hover:bg-green-700">提交选中</Btn>
                    <Btn onClick={() => doSubmit(filteredQueue.filter((q) => q.status === "pending").map((q) => q.id))} disabled={!hasKey || cStats.unused === 0}>全部提交</Btn>
                    <Btn onClick={doPoll}>刷新状态</Btn>
                    <Btn onClick={doStop} className="bg-white border-red-200 text-red-600 hover:bg-red-50">停止</Btn>
                    <div className="border-l mx-1 h-5"/>
                    <Btn onClick={() => doExport("account")}>导出账密</Btn>
                    <Btn onClick={() => doExport("full")}>导出含RT</Btn>
                    <Btn onClick={doProbePlan}>查询套餐</Btn>
                    <div className="flex-1"/>
                    {/* 筛选 */}
                    <div className="flex items-center gap-1 text-xs">
                        {[{k: "all", l: "全部", n: qStats.total}, {k: "undone", l: "未完成", n: qStats.pending + qStats.submitted},
                          {k: "finished", l: "已完成", n: qStats.done + qStats.error},
                          {k: "pending", l: "待提交", n: qStats.pending},
                          {k: "submitted", l: "已提交", n: qStats.submitted}, {k: "done", l: "完成", n: qStats.done}, {k: "error", l: "失败", n: qStats.error}]
                          .map(({k, l, n}) => (
                            <button key={k} onClick={() => setQFilter(k)}
                                    className={`px-2 py-0.5 rounded border text-xs ${qFilter === k ? "bg-gray-800 text-white border-gray-800" : "bg-gray-50 text-gray-600 border-gray-200 hover:bg-gray-100"}`}>
                                {l} {n}
                            </button>
                        ))}
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
                                <th className="text-left px-2 py-2 font-medium text-gray-500">邮箱</th>
                                <th className="text-left px-2 py-2 font-medium text-gray-500">套餐</th>
                                <th className="text-left px-2 py-2 font-medium text-gray-500">批次</th>
                                <th className="text-left px-2 py-2 font-medium text-gray-500">状态</th>
                                <th className="text-left px-2 py-2 font-medium text-gray-500">卡密</th>
                                <th className="text-left px-2 py-2 font-medium text-gray-500">任务状态</th>
                                <th className="text-left px-2 py-2 font-medium text-gray-500">消息</th>
                                <th className="text-left px-2 py-2 font-medium text-gray-500">操作</th>
                            </tr>
                        </thead>
                        <tbody>
                            {filteredQueue.map((q) => (
                                <tr key={q.id} className="border-t hover:bg-gray-50 cursor-pointer" onClick={() => toggleQSel(q.id)}>
                                    <td className="px-2 py-1.5 text-center" onClick={(e) => e.stopPropagation()}><input type="checkbox" checked={qSel.has(q.id)} onChange={() => toggleQSel(q.id)}/></td>
                                    <td className="px-2 py-1.5 text-gray-700">{q.email}</td>
                                    <td className="px-2 py-1.5 text-gray-500">{q.plan_type || q.plan || "—"}</td>
                                    <td className="px-2 py-1.5 text-gray-500">{q.batch || "—"}</td>
                                    <td className="px-2 py-1.5">
                                        <span className="inline-flex items-center gap-1 text-xs font-medium" style={{color: Q_COLOR[q.status] || "#6b7280"}}>
                                            <span className="w-1.5 h-1.5 rounded-full" style={{background: Q_COLOR[q.status] || "#6b7280"}}/>{Q_LABEL[q.status] || q.status}
                                            {q.status === "done" && " ✓"}
                                        </span>
                                    </td>
                                    <td className="px-2 py-1.5 font-mono text-gray-500">{q.card_code ? (q.card_code.length > 16 ? q.card_code.slice(0, 8) + "…" : q.card_code) : "—"}</td>
                                    <td className="px-2 py-1.5">{q.task_status ? <span style={{color: TASK_COLOR[q.task_status] || "#6b7280"}}>{q.task_status}</span> : "—"}</td>
                                    <td className="px-2 py-1.5 text-gray-500 max-w-[180px] truncate" title={q.task_message || q.error || ""}>
                                        {q.error ? <span className="text-red-500">{q.error}</span> : (q.task_message || "—")}
                                    </td>
                                    <td className="px-2 py-1.5" onClick={(e) => e.stopPropagation()}>
                                        {q.status !== "done" && q.status !== "pending" && q.card_code && (
                                            <button onClick={() => { api.pollRecharge([q.id]).then(() => { toast(`已刷新 ${q.email}`); loadQueue(); }).catch((e: any) => toast(e.message)); }}
                                                    className="text-blue-500 hover:text-blue-700 text-xs hover:underline">刷新</button>
                                        )}
                                        {(q.status === "error" || q.status === "paired") && (
                                            <button onClick={() => { api.resetRechargeQueue([q.id]).then(() => { loadQueue(); toast("已重置"); }).catch((e: any) => toast(e.message)); }}
                                                    className="text-amber-500 hover:text-amber-700 text-xs hover:underline ml-2">重置</button>
                                        )}
                                    </td>
                                </tr>
                            ))}
                            {!filteredQueue.length && <tr><td colSpan={9} className="text-center py-8 text-gray-400">队列为空，点击「选择账号入队」添加</td></tr>}
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
                                    <td className="px-2 py-1.5 font-mono text-gray-700">{c.code.length > 20 ? c.code.slice(0, 8) + "…" + c.code.slice(-4) : c.code}</td>
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
            {logs.length > 0 && (
                <div className="bg-white rounded-lg border shadow-sm">
                    <div className="px-4 py-2 border-b flex items-center justify-between">
                        <span className="text-sm font-semibold">操作日志</span>
                        <button onClick={() => setLogs([])} className="text-xs text-gray-400 hover:text-gray-600">清空</button>
                    </div>
                    <div className="max-h-[200px] overflow-auto bg-gray-50 p-3 font-mono text-xs text-gray-600 space-y-0.5">
                        {logs.map((l, i) => (
                            <div key={i} className="flex gap-2">
                                <span className="text-gray-400 shrink-0">{fmtTime(l.ts)}</span>
                                <span className={l.line.startsWith("✗") ? "text-red-500" : l.line.startsWith("✓") ? "text-green-600" : ""}>{l.line}</span>
                            </div>
                        ))}
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
                    <div className="bg-white rounded-xl shadow-xl w-[700px] max-h-[80vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
                        <div className="px-5 py-3 border-b font-semibold text-sm flex items-center gap-3">
                            <span>选择账号入队</span>
                            <span className="text-xs text-gray-400 font-normal">可选: {accounts.length} 个 (成功+未售出+有session)</span>
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
                            <span className="text-xs text-gray-500">已选 <b className="text-blue-600">{pickerSel.size}</b> 个</span>
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
        </div>
    );
}
