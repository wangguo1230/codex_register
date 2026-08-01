// Claude 注册面板(架构 v2 三模块之一,与 GPT 注册对称)。
//   - 从 free 池分配 N 个给 Claude(usage=claude,★与 GPT 物理隔离)→ pending claude_accounts
//   - 「开始注册」触发调度器认领:比特浏览器(独立指纹)+ 代理过 CF → claude.ai magic-link 注册
//   - 产出 sessionKey(sk-ant-sid02-…) + org_id + 全 cookie(auth 文件);SSE 实时刷新
//   - 注册/查订阅/养号日志独立(claude_logs),点账号邮箱名看详情抽屉
import {useEffect, useState} from "react";
import {api, connectStream, type ClaudeAccount, type Stats} from "./api";
import {ClaudeSubTool} from "./ClaudeSubTool";
import {ClaudeDetail} from "./ClaudeDetail";

const ST_COLOR: Record<string, string> = {pending: "#6b7280", running: "#2563eb", success: "#16a34a", failed: "#dc2626"};
const ST_LABEL: Record<string, string> = {total: "全部", pending: "等待", running: "运行", success: "成功", failed: "失败"};
const EMPTY: Stats = {pending: 0, running: 0, success: 0, failed: 0, total: 0};
const p2 = (n: number) => String(n).padStart(2, "0");
const fmtDateTime = (ts?: number | null) => { if (!ts) return "—"; const d = new Date(ts); return `${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}`; };
const aliveDays = (finished?: number | null, dead?: number) => { if (!finished) return null; const end = dead ? dead : Date.now(); return Math.max(0, Math.floor((end - finished) / 86400000)); };
const fmtDur = (start?: number | null, finish?: number | null) => { if (!start || !finish || finish < start) return "—"; const s = Math.round((finish - start) / 1000); return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${p2(s % 60)}s`; };

export function ClaudePanel({notify}: {notify?: (m: string) => void}) {
    const [list, setList] = useState<ClaudeAccount[]>([]);
    const [stats, setStats] = useState<Stats>(EMPTY);
    const [freeCount, setFreeCount] = useState(0);
    const [allocCount, setAllocCount] = useState(1);
    const [batch, setBatch] = useState("");
    const [busy, setBusy] = useState(false);
    const [showSub, setShowSub] = useState(false); // 订阅/套餐查询工具
    const [detailAcc, setDetailAcc] = useState<ClaudeAccount | null>(null); // 详情抽屉(独立日志)
    const [paused, setPaused] = useState(true); // Claude 域暂停态
    const [runningN, setRunningN] = useState(0); // 正在跑的 Claude worker 数
    const [claudeProxy, setClaudeProxy] = useState(""); // Claude 独立代理
    const [claudeXray, setClaudeXray] = useState<any>(null); // Claude 独立 vless xray 状态
    const [showProxy, setShowProxy] = useState(false);
    const [proxyInput, setProxyInput] = useState("");
    const [vlessInput, setVlessInput] = useState("");
    const [selected, setSelected] = useState<Set<number>>(new Set()); // 多选
    const [batches, setBatches] = useState<{name: string; n: number}[]>([]);
    const [fBatch, setFBatch] = useState(""); // 筛选:批次
    const [fEmail, setFEmail] = useState(""); // 筛选:邮箱关键词
    const [fDays, setFDays] = useState(""); // 筛选:存活满 N 天(>=)
    const [scan, setScan] = useState<{running: boolean; done: number; total: number}>({running: false, done: 0, total: 0}); // 扫邮箱检测禁用进度

    const toast = (m: string) => notify?.(m);
    const load = () => {
        api.listClaudeAccounts().then((r) => { setList(r.list); setStats(r.stats); }).catch(() => {});
        api.listMailboxes("free").then((r) => setFreeCount(r.stats.free)).catch(() => {});
        api.claudeBatches().then(setBatches).catch(() => {});
    };
    // 筛选后的列表(批次/邮箱/存活天数)
    const filtered = list.filter((a) => {
        if (fBatch && (a.batch || "") !== fBatch) return false;
        if (fEmail && !a.email.toLowerCase().includes(fEmail.toLowerCase())) return false;
        if (fDays) { const d = aliveDays(a.finished_at, a.dead_at); if (d === null || d < Number(fDays)) return false; }
        return true;
    });
    const toggleSel = (id: number) => setSelected((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
    const fIds = filtered.map((a) => a.id);
    const allSel = fIds.length > 0 && fIds.every((id) => selected.has(id));
    const toggleAll = () => setSelected(allSel ? new Set() : new Set(fIds));
    const selIds = () => [...selected].filter((id) => filtered.some((a) => a.id === id));
    const loadState = () => api.state().then((s) => { setPaused(s.state.pausedClaude !== false); setRunningN((s.state.runningClaude || []).length); setClaudeProxy(s.state.claudeProxy || ""); setProxyInput(s.state.claudeProxy || ""); setClaudeXray(s.state.claudeXray || null); if (s.state.claudeXrayVless) setVlessInput(s.state.claudeXrayVless); }).catch(() => {});
    useEffect(() => {
        load(); loadState();
        const off = connectStream((ev, data: any) => {
            if (ev === "claude" || ev === "mailboxes") load();
            if (ev === "stats" || ev === "claude") loadState();
            if (ev === "claudeScan") { setScan(data); if (!data?.running) load(); } // 检测进度;跑完刷新列表(存活列/失效标记)
        });
        return off; /* eslint-disable-next-line */
    }, []);

    const doAllocate = async () => {
        if (!(allocCount > 0)) return;
        if (!confirm(`从 free 池分配 ${allocCount} 个给 Claude?分配后点「开始注册」即用比特浏览器自动注册。`)) return;
        setBusy(true);
        try {
            const r = await api.allocateMailboxes("claude", allocCount, batch);
            if (r.error) toast(r.error);
            else toast(`已分配 ${r.allocated} 个给 Claude,点「开始注册」启动`);
            load();
        } catch (e: any) { toast("分配失败:" + e.message); } finally { setBusy(false); }
    };
    const doStart = async () => {
        try { await api.registerClaude(); setPaused(false); toast("已开始:认领 pending Claude 账号逐个注册(点账号邮箱名看详情日志)"); }
        catch (e: any) { toast(e.message); }
    };
    const doPause = () => api.pauseClaude().then(() => { setPaused(true); toast("已暂停 Claude(运行中的跑完)"); }).catch((e: any) => toast(e.message));
    const doStop = () => { if (!confirm("停止 Claude 注册?会杀掉正在跑的 Claude worker(未完成的号回到 pending)。")) return; api.stopClaude().then(() => { setPaused(true); toast("已停止 Claude"); loadState(); }).catch((e: any) => toast(e.message)); };
    const saveProxy = () => api.setClaudeProxy(proxyInput.trim()).then((r) => { setClaudeProxy(r.claudeProxy); toast("已保存 Claude 代理"); }).catch((e: any) => toast(e.message));
    const startVless = () => { if (!vlessInput.trim()) return; api.startClaudeXray(vlessInput.trim()).then((r) => { setClaudeXray(r.xray); setClaudeProxy(r.claudeProxy); setProxyInput(r.claudeProxy); toast("Claude 独立 vless 已起,代理→" + r.claudeProxy); }).catch((e: any) => toast("起 vless 失败:" + e.message)); };
    const stopVless = () => api.stopClaudeXray().then((r) => { setClaudeXray(r.xray); toast("已停 Claude vless"); }).catch((e: any) => toast(e.message));
    const doBatchDelete = async () => {
        const ids = selIds(); if (!ids.length) { toast("请先勾选账号"); return; }
        if (!confirm(`删除选中 ${ids.length} 个 Claude 账号?运行中的跳过。`)) return;
        try { const r = await api.batchDeleteClaude(ids); setSelected(new Set()); toast(`已删除 ${r.count} 个${r.skipped ? `(跳过运行中 ${r.skipped})` : ""}`); load(); } catch (e: any) { toast(e.message); }
    };
    const doScanDisabled = async () => {
        const ids = selIds(); if (!ids.length) { toast("请先勾选账号"); return; }
        if (!confirm(`扫邮箱检测选中 ${ids.length} 个账号是否被禁用?先扫邮箱找 Anthropic 禁用通知,未命中再用 sessionKey 过 CF 探测存活(比特浏览器,较慢)。命中即标失效。`)) return;
        try { const r = await api.batchScanClaudeDisabled(ids); if (r.msg) toast(r.msg); else toast(`已开始检测 ${r.count} 个(进度实时刷新,明细见账号详情日志)`); }
        catch (e: any) { toast(e.message); }
    };
    const stopScan = () => api.stopScanClaudeDisabled().then(() => toast("已请求停止(当前号跑完即停)")).catch((e: any) => toast(e.message));
    const doExport = async (markSold: boolean) => {
        const ids = selIds(); if (!ids.length) { toast("请先勾选账号"); return; }
        if (markSold && !confirm(`导出并标记 ${ids.length} 个为已售出?`)) return;
        try {
            const text = await api.exportSelectedClaude(ids, markSold);
            const blob = new Blob([text], {type: "text/plain"}); const url = URL.createObjectURL(blob);
            const el = document.createElement("a"); el.href = url; el.download = `claude-export-${Date.now()}.txt`; el.click(); URL.revokeObjectURL(url);
            toast(`已导出 ${ids.length} 个${markSold ? "并标记已售出" : ""}`); if (markSold) { setSelected(new Set()); load(); }
        } catch (e: any) { toast(e.message); }
    };
    const doDelete = async (a: ClaudeAccount) => {
        if (!confirm(`删除 Claude 账号 ${a.email}?`)) return;
        try { await api.deleteClaudeAccount(a.id); toast("已删除"); load(); } catch (e: any) { toast(e.message); }
    };
    const doRetry = async (a: ClaudeAccount) => {
        try { await api.retryClaude(a.id); toast("已重置为等待，进入注册队列"); load(); } catch (e: any) { toast(e.message); }
    };
    const copy = (v: string) => { try { navigator.clipboard?.writeText(v); toast("已复制"); } catch { /* */ } };

    const card = {background: "#fff", border: "1px solid #e8eaed", borderRadius: 12, padding: 16, boxShadow: "0 1px 3px rgba(0,0,0,0.04)"};

    return (
        <div style={{padding: 18, display: "flex", flexDirection: "column", gap: 14, height: "100%", boxSizing: "border-box", background: "#f6f7f9"}}>
            {/* 统计 */}
            <div style={{display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap"}}>
                <b style={{fontSize: 15, marginRight: 4}}>🧠 Claude 账号</b>
                {(["total", "pending", "running", "success", "failed"] as const).map((k) => (
                    <span key={k} style={{padding: "4px 12px", borderRadius: 14, fontSize: 13, border: "1px solid #e5e7eb", background: "#fff"}}>
                        {ST_LABEL[k]} <b style={{color: ST_COLOR[k] || "#374151"}}>{(stats as any)[k]}</b>
                    </span>
                ))}
                <button onClick={() => setShowSub(true)} style={{marginLeft: "auto", padding: "5px 14px", borderRadius: 8, fontSize: 13, border: "1px solid #d1d5db", background: "#fff", cursor: "pointer"}} title="批量查 Claude 账号存活/套餐/Claude Code 权限">🧰 订阅/套餐查询</button>
            </div>

            {/* 分配 + 开始注册 */}
            <div style={{...card, display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap"}}>
                <span style={{fontSize: 13, color: "#374151"}}>从 <b>free 池({freeCount})</b> 分配</span>
                <input type="number" min={1} value={allocCount} onChange={(e) => setAllocCount(Math.max(1, Number(e.target.value) || 1))} style={{width: 72, padding: "6px 10px", border: "1px solid #e5e7eb", borderRadius: 8}} />
                <span style={{fontSize: 13}}>个</span>
                <input value={batch} onChange={(e) => setBatch(e.target.value)} placeholder="批次(可选)" style={{width: 150, padding: "6px 10px", border: "1px solid #e5e7eb", borderRadius: 8}} />
                <button onClick={doAllocate} disabled={busy || freeCount === 0} style={{padding: "7px 16px", background: freeCount === 0 ? "#e5e7eb" : "#d97757", color: freeCount === 0 ? "#9ca3af" : "#fff", border: "none", borderRadius: 8, cursor: freeCount === 0 ? "not-allowed" : "pointer", fontWeight: 500}}>→ 分配给 Claude</button>
                {paused
                    ? <button onClick={doStart} disabled={busy} style={{padding: "7px 16px", background: "#16a34a", color: "#fff", border: "none", borderRadius: 8, cursor: "pointer", fontWeight: 500}}>▶ 开始注册</button>
                    : <button onClick={doPause} style={{padding: "7px 16px", background: "#f59e0b", color: "#fff", border: "none", borderRadius: 8, cursor: "pointer", fontWeight: 500}}>⏸ 暂停</button>}
                <button onClick={doStop} disabled={paused && runningN === 0} style={{padding: "7px 14px", background: paused && runningN === 0 ? "#e5e7eb" : "#dc2626", color: paused && runningN === 0 ? "#9ca3af" : "#fff", border: "none", borderRadius: 8, cursor: paused && runningN === 0 ? "not-allowed" : "pointer", fontWeight: 500}}>⏹ 停止{runningN > 0 ? `(${runningN}跑)` : ""}</button>
                <button onClick={() => setShowProxy((v) => !v)} style={{padding: "7px 12px", background: "#fff", color: "#374151", border: "1px solid #d1d5db", borderRadius: 8, cursor: "pointer", fontSize: 13}}>🌐 Claude 代理{claudeXray?.running ? "(vless运行)" : claudeProxy ? "(已配)" : ""}</button>
                <span style={{fontSize: 11, color: "#9ca3af", flexBasis: "100%"}}>注册=比特浏览器(独立指纹)+ Claude 独立代理过 CF → 提交邮箱 → 收 magic link → 完成注册。暂停/停止/代理均独立于 GPT。过程日志:点账号邮箱名开详情。</span>
            </div>

            {/* Claude 独立代理设置(与 GPT 分开) */}
            {showProxy && (
                <div style={{...card, display: "flex", flexDirection: "column", gap: 10}}>
                    <div style={{fontSize: 13, fontWeight: 600, color: "#111827"}}>🌐 Claude 独立代理 <span style={{fontSize: 11, color: "#9ca3af", fontWeight: 400}}>过 claude.ai CF,与 GPT 的 regProxy 分开;空则回退 GPT 代理</span></div>
                    <div style={{display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap"}}>
                        <input value={proxyInput} onChange={(e) => setProxyInput(e.target.value)} placeholder="socks5://127.0.0.1:10810 或 http://user:pass@host:port" style={{flex: "1 1 320px", padding: "6px 10px", border: "1px solid #e5e7eb", borderRadius: 8, fontFamily: "monospace", fontSize: 12}} />
                        <button onClick={saveProxy} style={{padding: "6px 14px", background: "#4f46e5", color: "#fff", border: "none", borderRadius: 8, cursor: "pointer"}}>保存代理</button>
                    </div>
                    <div style={{display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap"}}>
                        <input value={vlessInput} onChange={(e) => setVlessInput(e.target.value)} placeholder="vless://…(起 Claude 独立 xray @10810,代理自动指向它)" style={{flex: "1 1 320px", padding: "6px 10px", border: "1px solid #e5e7eb", borderRadius: 8, fontFamily: "monospace", fontSize: 12}} />
                        <button onClick={startVless} style={{padding: "6px 14px", background: "#0891b2", color: "#fff", border: "none", borderRadius: 8, cursor: "pointer"}}>起 vless</button>
                        {claudeXray?.running && <button onClick={stopVless} style={{padding: "6px 12px", background: "#dc2626", color: "#fff", border: "none", borderRadius: 8, cursor: "pointer"}}>停 vless</button>}
                    </div>
                    <div style={{fontSize: 11, color: claudeXray?.error ? "#dc2626" : "#6b7280"}}>
                        当前:{claudeProxy || "(未配,回退 GPT 代理)"} {claudeXray?.running ? `· vless 运行中 ${claudeXray.node} @${claudeXray.port}` : claudeXray?.error ? `· ${claudeXray.error.slice(0, 60)}` : ""}
                    </div>
                </div>
            )}

            {/* 筛选 + 批量操作 */}
            <div style={{display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", fontSize: 13}}>
                <select value={fBatch} onChange={(e) => setFBatch(e.target.value)} style={{padding: "5px 8px", border: "1px solid #e5e7eb", borderRadius: 8}}>
                    <option value="">全部批次</option>
                    {batches.map((b) => <option key={b.name} value={b.name}>{b.name}({b.n})</option>)}
                </select>
                <input value={fEmail} onChange={(e) => setFEmail(e.target.value)} placeholder="邮箱关键词" style={{width: 150, padding: "5px 8px", border: "1px solid #e5e7eb", borderRadius: 8}} />
                <span style={{color: "#6b7280"}}>存活≥</span>
                <input type="number" min={0} value={fDays} onChange={(e) => setFDays(e.target.value)} placeholder="天" style={{width: 64, padding: "5px 8px", border: "1px solid #e5e7eb", borderRadius: 8}} />
                <span style={{color: "#9ca3af", fontSize: 12}}>共 {filtered.length}{selIds().length ? ` · 已选 ${selIds().length}` : ""}</span>
                {selIds().length > 0 && <>
                    <button onClick={() => doExport(false)} style={{padding: "5px 12px", background: "#0ea5e9", color: "#fff", border: "none", borderRadius: 8, cursor: "pointer"}}>📥 导出选中</button>
                    <button onClick={() => doExport(true)} style={{padding: "5px 12px", background: "#f59e0b", color: "#fff", border: "none", borderRadius: 8, cursor: "pointer"}}>💰 导出+已售出</button>
                    <button onClick={doScanDisabled} disabled={scan.running} style={{padding: "5px 12px", background: scan.running ? "#93c5fd" : "#0d9488", color: "#fff", border: "none", borderRadius: 8, cursor: scan.running ? "not-allowed" : "pointer"}} title="扫邮箱找 Anthropic 禁用通知,未命中再 API 探测存活;命中即标失效">🔍 扫描禁用</button>
                    <button onClick={doBatchDelete} style={{padding: "5px 12px", background: "#dc2626", color: "#fff", border: "none", borderRadius: 8, cursor: "pointer"}}>🗑 批量删除</button>
                    <button onClick={() => setSelected(new Set())} style={{padding: "5px 10px", color: "#6b7280"}}>清空</button>
                </>}
                {scan.running && <span style={{display: "inline-flex", gap: 8, alignItems: "center", fontSize: 12, color: "#0d9488"}}>
                    🔍 检测中… {scan.done}/{scan.total}
                    <button onClick={stopScan} style={{padding: "4px 10px", background: "#dc2626", color: "#fff", border: "none", borderRadius: 8, cursor: "pointer"}}>⏹ 停止</button>
                </span>}
            </div>

            {/* 列表 */}
            <div style={{flex: 1, overflow: "auto", ...card, padding: 0}}>
                <table style={{width: "100%", borderCollapse: "collapse", fontSize: 13}}>
                    <thead style={{position: "sticky", top: 0, background: "#f9fafb"}}>
                        <tr style={{textAlign: "left", color: "#6b7280"}}>
                            <th style={{padding: "8px 12px", width: 32}}><input type="checkbox" checked={allSel} onChange={toggleAll} title="全选/取消(当前筛选)"/></th>
                            <th style={{padding: "8px 12px"}}>邮箱</th>
                            <th style={{padding: "8px 12px"}}>状态</th>
                            <th style={{padding: "8px 12px"}}>sessionKey</th>
                            <th style={{padding: "8px 12px"}}>套餐/CC</th>
                            <th style={{padding: "8px 12px"}}>注册时间</th>
                            <th style={{padding: "8px 12px"}}>存活</th>
                            <th style={{padding: "8px 12px"}}>耗时</th>
                            <th style={{padding: "8px 12px"}}>批次</th>
                            <th style={{padding: "8px 12px"}}>操作</th>
                        </tr>
                    </thead>
                    <tbody>
                        {filtered.map((a) => (
                            <tr key={a.id} style={{borderTop: "1px solid #f3f4f6", background: selected.has(a.id) ? "#fdf3ee" : a.sold_at ? "#fafafa" : undefined}}>
                                <td style={{padding: "6px 12px"}}><input type="checkbox" checked={selected.has(a.id)} onChange={() => toggleSel(a.id)}/></td>
                                <td style={{padding: "6px 12px", fontFamily: "monospace"}}>
                                    <span onClick={() => setDetailAcc(a)} title="点击看注册/查订阅/养号日志(独立)" style={{cursor: "pointer", color: detailAcc?.id === a.id ? "#4f46e5" : "#374151", textDecoration: "underline", textDecorationColor: detailAcc?.id === a.id ? "#4f46e5" : "#cbd5e1", textUnderlineOffset: 3}}>{a.email}</span>
                                    {a.sold_at ? <span style={{marginLeft: 6, fontSize: 11, color: "#f59e0b"}}>已售</span> : null}
                                </td>
                                <td style={{padding: "6px 12px"}}>
                                    <span style={{padding: "1px 8px", borderRadius: 10, fontSize: 12, color: "#fff", background: ST_COLOR[a.status] || "#6b7280"}}>{a.status}</span>
                                    {a.status === "failed" && a.error ? <span style={{marginLeft: 6, fontSize: 11, color: "#dc2626"}} title={a.error}>{a.error.slice(0, 24)}</span> : null}
                                </td>
                                <td style={{padding: "6px 12px", color: "#374151", fontFamily: "monospace"}}>
                                    {a.session_key ? <span onClick={() => copy(a.session_key!)} title="点击复制完整 sessionKey" style={{cursor: "pointer"}}>{a.session_key.slice(0, 18)}… <span style={{color: "#4f46e5", fontFamily: "sans-serif"}}>复制</span></span> : <span style={{color: "#9ca3af"}}>—</span>}
                                </td>
                                <td style={{padding: "6px 12px"}}>
                                    {a.plan ? <span style={{color: a.plan === "Free" ? "#6b7280" : "#d97757", fontWeight: a.plan === "Free" ? 400 : 600}}>{a.plan}</span> : <span style={{color: "#9ca3af"}}>—</span>}
                                    {a.claude_code ? <span style={{marginLeft: 6, fontSize: 11, color: a.claude_code === "available" ? "#16a34a" : "#9ca3af"}}>{a.claude_code === "available" ? "CC✓" : "CC🔒"}</span> : null}
                                </td>
                                <td style={{padding: "6px 12px", color: "#6b7280", whiteSpace: "nowrap"}}>{fmtDateTime(a.finished_at)}</td>
                                <td style={{padding: "6px 12px", whiteSpace: "nowrap"}}>{(() => { const d = aliveDays(a.finished_at, a.dead_at); return d === null ? <span style={{color: "#9ca3af"}}>—</span> : <span style={{color: a.dead_at ? "#dc2626" : "#374151"}}>{d}天{a.dead_at ? "(已失效)" : ""}</span>; })()}</td>
                                <td style={{padding: "6px 12px", color: "#6b7280", whiteSpace: "nowrap"}}>{fmtDur(a.started_at, a.finished_at)}</td>
                                <td style={{padding: "6px 12px", color: "#6b7280"}}>{a.batch || "—"}</td>
                                <td style={{padding: "6px 12px", whiteSpace: "nowrap"}}>
                                    {a.status === "failed" ? <button onClick={() => doRetry(a)} style={{fontSize: 12, color: "#2563eb", marginRight: 10}}>重跑</button> : null}
                                    <button onClick={() => doDelete(a)} style={{fontSize: 12, color: "#dc2626"}}>删除</button>
                                </td>
                            </tr>
                        ))}
                        {filtered.length === 0 && (
                            <tr><td colSpan={10} style={{padding: 24, textAlign: "center", color: "#9ca3af"}}>{list.length ? "无匹配筛选的账号" : "暂无 Claude 账号。从上方 free 池分配后点「开始注册」。"}</td></tr>
                        )}
                    </tbody>
                </table>
            </div>

            {showSub && <ClaudeSubTool onClose={() => setShowSub(false)} notify={notify}/>}
            {detailAcc && <ClaudeDetail account={detailAcc} onClose={() => setDetailAcc(null)}/>}
        </div>
    );
}
