import {useEffect, useState, useMemo, useRef} from "react";
import {api, connectStream, type Account, type RechargeCard, type RechargeCardStats, type RechargeQueueItem, type RechargeQueueStats} from "./api";

const p2 = (n: number) => String(n).padStart(2, "0");
const fmtTime = (ts?: number) => { if (!ts) return "—"; const d = new Date(ts); return `${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}`; };
const fmtLogTime = (ts?: number) => { if (!ts) return "—"; const d = new Date(ts); return `${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`; };
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
    const [rebindMode, setRebindMode] = useState<"auto" | "grp" | "emails">("auto");
    const [rebindGrp, setRebindGrp] = useState("");
    const [rebindText, setRebindText] = useState("");
    const [rebindPick, setRebindPick] = useState<Set<string>>(new Set());
    const [rebindPool, setRebindPool] = useState<{list: {id: number; email: string; grp: string}[]; groups: {grp: string; n: number}[]; count: number}>({list: [], groups: [], count: 0});
    const [rebindSearch, setRebindSearch] = useState("");

    const toast = (m: string) => notify?.(m);

    const loadQueue = () => { api.rechargeQueue().then((r) => { setQueue(r.list); setQStats(r.stats); }).catch(() => {}); api.rechargeQueueBatches().then(setQBatches).catch(() => {}); };
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
            if (ev === "rechargeQueue") { setQueue(data.list || []); setQStats(data.stats || EMPTY_Q); }
            if (ev === "recharge") { setCards(data.list || []); setCStats(data.stats || EMPTY_C); }
            if (ev === "rechargeLog") {
                setLogs((prev) => [...prev.slice(-500), data]);
                if (/^换绑 [✓✗]/.test(String(data?.line || ""))) loadConfig();
            }
            if (ev === "batchRtAcquire") { setBatchRtResults(data.results.map((r: any) => ({...r, status: r.status || "done"}))); if (data.done) setBatchRtRunning(false); }
            if (ev === "rechargeExportReady" && data?.text) {
                const blob = new Blob([data.text], {type: "text/plain;charset=utf-8"});
                const url = URL.createObjectURL(blob);
                const a = Object.assign(document.createElement("a"), {href: url, download: "recharge-full.txt"});
                a.click(); URL.revokeObjectURL(url);
            }
        });
        // SSE 重连会丢中间事件；换绑卡在 mail.com 时也要靠轮询把磁盘日志刷出来
        const poll = setInterval(() => { loadLogs(); loadQueue(); }, 4000);
        return () => { off(); clearInterval(poll); };
    }, []);

    useEffect(() => {
        const el = logBoxRef.current;
        if (el) el.scrollTop = el.scrollHeight;
    }, [logs]);

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
        if (!confirm(`确认移出 ${ids.length} 个账号?\n将同时删除对应 GPT 账号、日志及邮箱。`)) return;
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
    const openRebindGmail = async (ids?: number[]) => {
        const pick = ids && ids.length ? ids : selQIds();
        if (!pick.length) { toast("请先选择已付费的队列项"); return; }
        setRebindIds(pick);
        setRebindMode("auto");
        setRebindGrp("__PICK__");
        setRebindText("");
        setRebindPick(new Set());
        setRebindSearch("");
        setShowRebindGmail(true);
        try {
            const r = await api.rebindGmailPool();
            setRebindPool({list: r.list || [], groups: r.groups || [], count: r.count || 0});
        } catch (e: any) {
            toast("加载可换绑 Gmail 失败: " + e.message);
        }
    };
    const submitRebind = async (target: "gmail" | "mailcom", opts?: {emails?: string[]; grp?: string; text?: string}) => {
        const ids = target === "gmail" && rebindIds.length ? rebindIds : selQIds();
        if (!ids.length) { toast("请先选择已付费的队列项"); return; }
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
        if (target === "gmail") return openRebindGmail();
        const ids = selQIds();
        if (!ids.length) { toast("请先选择已付费的队列项"); return; }
        if (!confirm(`对选中的 ${ids.length} 项换绑 mail.com？\n只处理已付费(paid)的号，自动领取空闲 mail.com。换完旧邮箱标已售，不返还。`)) return;
        await submitRebind("mailcom");
    };
    const doConfirmRebindGmail = async () => {
        if (rebindMode === "grp") {
            if (rebindGrp === "__PICK__") { toast("请选择分组"); return; }
            await submitRebind("gmail", {grp: rebindGrp});
            return;
        }
        if (rebindMode === "emails") {
            const fromPick = [...rebindPick];
            const text = rebindText.trim();
            if (!fromPick.length && !text) { toast("请勾选或粘贴要换绑的 Gmail"); return; }
            await submitRebind("gmail", {emails: fromPick, text});
            return;
        }
        await submitRebind("gmail");
    };
    const rebindVisible = useMemo(() => {
        const q = rebindSearch.trim().toLowerCase();
        return rebindPool.list.filter((m) => {
            if (rebindMode === "grp" && rebindGrp !== "__PICK__" && (m.grp || "") !== rebindGrp) return false;
            if (q && !m.email.toLowerCase().includes(q) && !(m.grp || "").toLowerCase().includes(q)) return false;
            return true;
        });
    }, [rebindPool.list, rebindMode, rebindGrp, rebindSearch]);

    // 导出
    const downloadText = (text: string, filename: string) => {
        const blob = new Blob([text], {type: "text/plain;charset=utf-8"});
        const url = URL.createObjectURL(blob);
        const a = Object.assign(document.createElement("a"), {href: url, download: filename});
        a.click(); URL.revokeObjectURL(url);
    };
    const doExport = async (format: "account" | "full" | "card" | "session") => {
        const ids = selQIds();
        try {
            const r = await api.exportRechargeQueue({ids: ids.length ? ids : undefined, batch: qBatchFilter || undefined, format});
            if (r.text) {
                const lines = r.text.split("\n").filter((l: string) => l.trim()).length;
                if (format === "card" || format === "session" || lines < 200) {
                    await navigator.clipboard.writeText(r.text);
                    toast(`已复制 ${lines} 行到剪切板`);
                } else {
                    const names: Record<string, string> = {account: "recharge-accounts.txt", full: "recharge-full.txt"};
                    downloadText(r.text, names[format] || "recharge-export.txt");
                    toast(`已导出 ${lines} 行`);
                }
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
                <div className="px-4 py-3 border-b flex items-center gap-2 flex-wrap">
                    <span className="text-sm font-semibold">充值队列</span>
                    <Btn onClick={openPicker} className="bg-blue-600 text-white border-blue-600 hover:bg-blue-700">+ 选择账号入队</Btn>
                    <Btn onClick={() => { setShowSetBatch(true); setBatchInput(""); }}>设置批次</Btn>
                    <Btn onClick={doReset}>重置</Btn>
                    <Btn onClick={doReclaimCards}>回收卡密</Btn>
                    <Btn onClick={doRemoveFromQueue} className="bg-white border-red-200 text-red-600 hover:bg-red-50">移出队列</Btn>
                    <div className="border-l mx-1 h-5"/>
                    <Btn onClick={() => doSubmit(selQIds())} disabled={!hasKey || cStats.unused === 0} className="bg-green-600 text-white border-green-600 hover:bg-green-700">提交选中</Btn>
                    <Btn onClick={() => doSubmit(filteredQueue.filter((q) => q.status === "pending").map((q) => q.id))} disabled={!hasKey || cStats.unused === 0}>全部提交</Btn>
                    <Btn onClick={doPoll}>刷新状态</Btn>
                    <Btn onClick={() => doRebind("gmail")} title="对已付费项换绑 Gmail：可选分组或指定邮箱，换绑前探 IMAP">换绑 Gmail</Btn>
                    <Btn onClick={() => doRebind("mailcom")} title="对已付费项手动换绑 mail.com；旧邮箱标已售">换绑 mail.com</Btn>
                    <Btn onClick={doStop} className="bg-white border-red-200 text-red-600 hover:bg-red-50">停止</Btn>
                    <Btn onClick={doRelogin} title="重登取 session → 验卡 → 重置 → 用原卡密重提(卡密已消费则跳过)" className="bg-amber-500 text-white border-amber-500 hover:bg-amber-600">重登并提交</Btn>
                    <Btn onClick={doStopRelogin} className="bg-white border-red-200 text-red-600 hover:bg-red-50">停止登录</Btn>
                    <div className="border-l mx-1 h-5"/>
                    <Btn onClick={() => doExport("account")}>导出账密</Btn>
                    <Btn onClick={() => doExport("full")}>导出含RT</Btn>
                    <Btn onClick={() => doExport("card")}>复制卡密</Btn>
                    <Btn onClick={() => doExport("session")}>复制session</Btn>
                    <Btn onClick={() => setShowBatchRt(true)} className="bg-amber-600 text-white border-amber-600 hover:bg-amber-700">批量获取RT</Btn>
                    <Btn onClick={() => setShowSub2json(true)} className="bg-violet-600 text-white border-violet-600 hover:bg-violet-700">导出sub2json</Btn>
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
                                <th className="text-left px-2 py-2 font-medium text-gray-500">实例</th>
                                <th className="text-left px-2 py-2 font-medium text-gray-500">状态</th>
                                <th className="text-left px-2 py-2 font-medium text-gray-500">卡密</th>
                                <th className="text-left px-2 py-2 font-medium text-gray-500">提交时间</th>
                                <th className="text-left px-2 py-2 font-medium text-gray-500">完成时间</th>
                                <th className="text-left px-2 py-2 font-medium text-gray-500">耗时</th>
                                <th className="text-left px-2 py-2 font-medium text-gray-500">任务状态</th>
                                <th className="text-left px-2 py-2 font-medium text-gray-500">换绑</th>
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
                                    <td className="px-2 py-1.5 text-xs font-mono" title={q.instance_id || ""}>
                                        {!q.instance_id ? <span className="text-gray-300">—</span>
                                            : q.instance_id === instanceId ? <span className="text-blue-600">本机</span>
                                            : <span className="text-amber-600">{q.instance_id}</span>}
                                    </td>
                                    <td className="px-2 py-1.5">
                                        <span className="inline-flex items-center gap-1 text-xs font-medium" style={{color: Q_COLOR[q.status] || "#6b7280"}}>
                                            <span className="w-1.5 h-1.5 rounded-full" style={{background: Q_COLOR[q.status] || "#6b7280"}}/>{Q_LABEL[q.status] || q.status}
                                            {q.status === "done" && " ✓"}
                                        </span>
                                    </td>
                                    <td className="px-2 py-1.5 font-mono text-gray-500">{q.card_code ? (q.card_code.length > 16 ? q.card_code.slice(0, 8) + "…" : q.card_code) : "—"}</td>
                                    <td className="px-2 py-1.5 text-gray-500 text-xs whitespace-nowrap">{fmtTime(q.submitted_at)}</td>
                                    <td className="px-2 py-1.5 text-gray-500 text-xs whitespace-nowrap">{fmtTime(q.finished_at)}</td>
                                    <td className="px-2 py-1.5 text-gray-500 text-xs whitespace-nowrap" title={q.submitted_at && q.finished_at ? `${fmtTime(q.submitted_at)} → ${fmtTime(q.finished_at)}` : ""}>{fmtDur(q.submitted_at, q.finished_at)}</td>
                                    <td className="px-2 py-1.5">{q.task_status ? <span style={{color: TASK_COLOR[q.task_status] || "#6b7280"}}>{q.task_status}</span> : "—"}</td>
                                    <td className="px-2 py-1.5 max-w-[160px] truncate" title={q.rebind_error || q.rebind_email || ""}>
                                        {q.rebind_status === "ok" ? <span className="text-green-600">{q.rebind_email || "已换绑"}</span>
                                            : q.rebind_status === "pending" ? <span className="text-amber-600">换绑中{q.rebind_target === "mailcom" ? " mail.com" : q.rebind_target === "gmail" ? " Gmail" : ""}</span>
                                            : q.rebind_status === "fail" ? <span className="text-red-500">{q.rebind_error || "失败"}</span>
                                            : q.rebind_status === "skipped" ? <span className="text-gray-400">无需换绑</span>
                                            : <span className="text-gray-300">—</span>}
                                    </td>
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
                                </tr>
                            ))}
                            {!filteredQueue.length && <tr><td colSpan={14} className="text-center py-8 text-gray-400">队列为空，点击「选择账号入队」添加</td></tr>}
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

            {/* ====== 换绑 Gmail：选分组 / 选邮箱 ====== */}
            {showRebindGmail && (
                <div className="fixed inset-0 bg-black/30 flex items-center justify-center z-50" onClick={() => setShowRebindGmail(false)}>
                    <div className="bg-white rounded-xl shadow-xl w-[560px] max-h-[85vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
                        <div className="px-5 py-3 border-b font-semibold text-sm">
                            换绑 Gmail
                            <div className="text-xs text-gray-400 font-normal mt-0.5">
                                对 {rebindIds.length} 个已付费号。只领独立、未售、IMAP 通的可用 Gmail；不通换号。成功后新旧邮箱都标已售。
                            </div>
                        </div>
                        <div className="px-5 py-3 space-y-3 text-xs overflow-auto">
                            <div className="flex items-center gap-3 flex-wrap">
                                {([
                                    ["auto", "自动领取"],
                                    ["grp", "指定分组"],
                                    ["emails", "指定邮箱"],
                                ] as const).map(([k, l]) => (
                                    <label key={k} className="inline-flex items-center gap-1.5 cursor-pointer">
                                        <input type="radio" name="rebind-src" checked={rebindMode === k} onChange={() => setRebindMode(k)}/>
                                        {l}
                                    </label>
                                ))}
                                <span className="text-gray-400 ml-auto">可换绑 {rebindPool.count}</span>
                            </div>
                            {rebindMode === "grp" && (
                                <select value={rebindGrp} onChange={(e) => setRebindGrp(e.target.value)}
                                        className="w-full px-2 py-1.5 border rounded outline-none">
                                    <option value="__PICK__">选择分组</option>
                                    {rebindPool.groups.map((g) => (
                                        <option key={g.grp || "__EMPTY__"} value={g.grp}>{g.grp || "(无分组)"} ({g.n})</option>
                                    ))}
                                </select>
                            )}
                            {rebindMode === "emails" && (
                                <textarea value={rebindText} onChange={(e) => setRebindText(e.target.value)}
                                          placeholder={"粘贴 Gmail，每行一个，或 email----密码\n也可在下方列表勾选"}
                                          className="w-full h-20 px-2 py-1.5 border rounded font-mono outline-none resize-y"/>
                            )}
                            <input value={rebindSearch} onChange={(e) => setRebindSearch(e.target.value)}
                                   placeholder="搜索邮箱 / 分组"
                                   className="w-full px-2 py-1.5 border rounded outline-none"/>
                            <div className="border rounded max-h-[240px] overflow-auto">
                                {rebindVisible.map((m) => (
                                    <label key={m.id} className="flex items-center gap-2 px-2 py-1 border-b last:border-0 hover:bg-blue-50 cursor-pointer">
                                        <input type="checkbox" checked={rebindPick.has(m.email)}
                                               onChange={() => {
                                                   setRebindMode("emails");
                                                   setRebindPick((prev) => {
                                                       const n = new Set(prev);
                                                       if (n.has(m.email)) n.delete(m.email); else n.add(m.email);
                                                       return n;
                                                   });
                                               }}/>
                                        <span className="flex-1 font-mono text-gray-700 truncate">{m.email}</span>
                                        <span className="text-gray-400">{m.grp || "无分组"}</span>
                                    </label>
                                ))}
                                {!rebindVisible.length && <div className="px-3 py-6 text-center text-gray-400">没有可换绑的独立 Gmail</div>}
                            </div>
                            {rebindMode === "emails" && <div className="text-gray-400">已勾选 {rebindPick.size} 个</div>}
                        </div>
                        <div className="px-5 py-3 border-t flex justify-end gap-2">
                            <Btn onClick={() => setShowRebindGmail(false)}>取消</Btn>
                            <Btn onClick={doConfirmRebindGmail} className="bg-blue-600 text-white border-blue-600 hover:bg-blue-700">确认换绑</Btn>
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
                            <span className="font-medium text-sm">导出 sub2json <span className="text-xs text-gray-400 font-normal">粘贴账密+RT → 刷新token → 生成 sub2api 导入文件</span></span>
                            <button onClick={() => { if (!sub2jsonRefreshing) setShowSub2json(false); }} className="text-gray-400 hover:text-gray-700 text-lg leading-none">&times;</button>
                        </div>
                        <div className="px-5 py-4 space-y-3 text-sm overflow-auto">
                            <div className="text-xs text-gray-500">每行 <span className="font-mono">邮箱----密码----refresh_token</span> 或 <span className="font-mono">邮箱:密码:rt</span>，支持多种分隔符。</div>
                            <textarea value={sub2jsonInput} onChange={(e) => setSub2jsonInput(e.target.value)}
                                      placeholder={"a@mail.com----password1----rt_xxx\nb@mail.com:password2:rt_yyy"}
                                      className="w-full h-32 px-2 py-1.5 border rounded text-xs font-mono resize-y" disabled={sub2jsonRefreshing}/>
                            <div className="flex items-center gap-3">
                                <button disabled={sub2jsonRefreshing} onClick={async () => {
                                    const parseLine = (l: string) => {
                                        for (const sep of ["----", "\t", "|", ";"]) {
                                            const p = l.split(sep).map(s => s.trim()).filter(Boolean);
                                            if (p.length >= 3) return {email: p[0], password: p[1], rt: p.slice(2).join(sep)};
                                        }
                                        const cp = l.split(":");
                                        if (cp.length >= 3) return {email: cp[0].trim(), password: cp[1].trim(), rt: cp.slice(2).join(":").trim()};
                                        return {email: "", password: "", rt: ""};
                                    };
                                    const lines = sub2jsonInput.split("\n").map(l => l.trim()).filter(Boolean);
                                    const items = lines.map(parseLine).filter(it => it.email && it.rt);
                                    if (!items.length) { toast("未解析到有效行(需邮箱+密码+rt)"); return; }
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
                                    {(() => { const n = sub2jsonInput.split("\n").map(l => l.trim()).filter(Boolean).length; return n > 0 ? `${n} 行` : ""; })()}
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
