// 邮箱管理面板(架构 v2:邮箱能力唯一中心)。所有邮箱操作集中于此,GPT/Claude 只做注册。
//   - 查看全部邮箱,按 usage(free/gpt/claude)筛选;free=待分配 hold=独立(永不分配) gpt/claude=已归属
//   - 导入独立邮箱(可选「导入后自动改密」);从指定分组的 free 池分配 N 个给 GPT/Claude(★物理隔离)
//   - 单个改密 / 多选批量改密(mail.com 真改,覆盖所有邮箱)/ 删除(仅 free)
//   - 邮箱密码校验工具(改密全归邮箱管理:导入后自动改密/手动/批量,注册流程不越界)
import {useEffect, useState} from "react";
import {api, connectStream, type Mailbox} from "./api";
import {MailCheckTool} from "./MailCheckTool";
import {MailboxDetail} from "./MailboxDetail";

const USAGE_LABEL: Record<string, string> = {free: "待分配", hold: "独立", gpt: "GPT", claude: "Claude"};
const USAGE_COLOR: Record<string, string> = {free: "#6b7280", hold: "#7c3aed", gpt: "#10a37f", claude: "#d97757"};
type BatchPw = {running: boolean; done: number; total: number; ok: number; stopped?: boolean};

export function MailboxPanel({notify}: {notify?: (m: string) => void}) {
    const [list, setList] = useState<Mailbox[]>([]);
    const [stats, setStats] = useState({free: 0, hold: 0, gpt: 0, claude: 0, total: 0});
    const [groups, setGroups] = useState<{grp: string; n: number}[]>([]); // 待分配(free)邮箱的分组分布
    const [usageFilter, setUsageFilter] = useState<"" | "free" | "hold" | "gpt" | "claude">("");
    const [fGrp, setFGrp] = useState(""); // 筛选:分组
    const [fPw, setFPw] = useState<"" | "no" | "yes" | "fail">(""); // 筛选:改密状态(未改/已改/失败)
    const [fEmail, setFEmail] = useState(""); // 筛选:邮箱关键词
    const [importText, setImportText] = useState("");
    const [grp, setGrp] = useState("");
    const [importAutoPw, setImportAutoPw] = useState(false); // 导入后自动改密
    const [importHold, setImportHold] = useState(false); // 导入即独立(进 hold,永不被业务分配)
    const [importProvider, setImportProvider] = useState<"mailcom"|"icloud">("mailcom"); // 邮箱 provider
    const [mailSep, setMailSep] = useState("----"); // 邮箱----密码 分隔符
    const [allocCount, setAllocCount] = useState(1);
    const [allocSrc, setAllocSrc] = useState("__ALL__"); // 分配来源:__ALL__=全池 / "g:<分组名>"=只从该分组(避免误分想保留的)
    const [busy, setBusy] = useState(false);
    const [selected, setSelected] = useState<Set<number>>(new Set()); // 多选(批量改密)
    const [batchPw, setBatchPw] = useState<BatchPw>({running: false, done: 0, total: 0, ok: 0});
    const [pwConc, setPwConc] = useState(1); // 改密并发
    const [detailMb, setDetailMb] = useState<Mailbox | null>(null); // 详情弹窗(日志+收件箱)

    const toast = (m: string) => notify?.(m);
    const load = () =>
        api.listMailboxes(usageFilter || undefined).then((r) => { setList(r.list); setStats(r.stats); setGroups(r.groups || []); }).catch(() => {});
    useEffect(() => { load(); /* eslint-disable-next-line */ }, [usageFilter]);
    useEffect(() => { api.state().then((s) => { if (s.state.mailSeparator) setMailSep(s.state.mailSeparator); if (s.state.pwConcurrency) setPwConc(s.state.pwConcurrency); }).catch(() => {}); }, []);
    // 实时刷新(邮箱变化/批量改密进度)
    useEffect(() => {
        const off = connectStream((ev, data) => {
            if (ev === "mailboxes") load();
            else if (ev === "batchPw") { setBatchPw(data); if (!data.running) load(); }
            else if (ev === "hello" && data?.state?.batchPw) { setBatchPw(data.state.batchPw); if (data.state.mailSeparator) setMailSep(data.state.mailSeparator); }
        });
        return off; /* eslint-disable-next-line */
    }, []);

    // 当前选中来源的可分配数 + 传给后端的 fromGrp(undefined=全池,字符串含''=该分组)
    const srcFromGrp = allocSrc === "__ALL__" ? undefined : allocSrc.slice(2);
    const srcCount = allocSrc === "__ALL__" ? stats.free : (groups.find((g) => "g:" + g.grp === allocSrc)?.n ?? 0);

    const doImport = async () => {
        if (!importText.trim()) return;
        setBusy(true);
        try {
            const r = await api.importFreeMailboxes(importText, "", grp, importAutoPw, importHold, importProvider);
            toast(`导入${importHold ? "独立" : "待分配"}邮箱:新增 ${r.inserted} / 跳过 ${r.skipped}${r.autoChangePw ? ` · 已启动 ${r.autoChangePw} 个自动改密` : ""}`);
            setImportText("");
            load();
        } catch (e: any) { toast("导入失败:" + e.message); } finally { setBusy(false); }
    };

    const doAllocate = async (usage: "gpt" | "claude") => {
        if (!(allocCount > 0)) return;
        if (allocCount > srcCount && !confirm(`该来源只有 ${srcCount} 个独立邮箱,少于要分配的 ${allocCount} 个,将只分配 ${srcCount} 个。继续?`)) return;
        const srcLabel = allocSrc === "__ALL__" ? "全部待分配" : (srcFromGrp || "(无分组)");
        if (usage === "claude" && !confirm(`从「${srcLabel}」分配 ${allocCount} 个给 Claude?(Claude 注册机制未就绪,分配后仅占位,暂不能自动注册)`)) return;
        setBusy(true);
        try {
            const r = await api.allocateMailboxes(usage, allocCount, srcFromGrp || "", srcFromGrp);
            if (r.error) toast(r.error);
            else toast(`已从「${srcLabel}」分配 ${r.allocated} 个给 ${usage.toUpperCase()}`);
            load();
        } catch (e: any) { toast("分配失败:" + e.message); } finally { setBusy(false); }
    };

    const doDelete = async (m: Mailbox) => {
        if (!confirm(`删除邮箱 ${m.email}?`)) return;
        try {
            const r = await api.deleteMailbox(m.id);
            if (!r.ok) toast(r.reason || "删除失败");
            else { toast("已删除"); load(); }
        } catch (e: any) { toast(e.message); }
    };

    const doChangePw = async (m: Mailbox) => {
        if (!confirm(`对 ${m.email} 执行 mail.com 改密(随机新密码,约 30s)?`)) return;
        setBusy(true);
        try {
            const r = await api.changeMailboxPasswd(m.id);
            toast(r.ok ? `改密成功,新密码 ${r.newPassword}` : `改密未确认(新密码 ${r.newPassword} 已记录)`);
            load();
        } catch (e: any) { toast(e.message); } finally { setBusy(false); }
    };

    // 切换独立/待分配(仅 free↔hold)
    const doSetUsage = async (m: Mailbox, usage: "free" | "hold") => {
        try { await api.setMailboxUsage(m.id, usage); toast(usage === "hold" ? "已设为独立(不参与业务分配)" : "已放回待分配"); load(); } catch (e: any) { toast(e.message); }
    };

    // 分组列表(当前 list 里所有 grp,去重)+ 改密状态判定 + 筛选后列表
    const allGrps = [...new Set(list.map((m) => m.grp || "").filter(Boolean))].sort();
    const pwState = (m: Mailbox) => { const s = m.pw_status || ""; return s.startsWith("✅") ? "yes" : s.startsWith("❌") ? "fail" : "no"; };
    const filtered = list.filter((m) => {
        if (fGrp === "__NONE__") { if (m.grp) return false; } else if (fGrp && (m.grp || "") !== fGrp) return false;
        if (fPw && pwState(m) !== fPw) return false;
        if (fEmail && !m.email.toLowerCase().includes(fEmail.toLowerCase())) return false;
        return true;
    });
    const noPwCount = list.filter((m) => pwState(m) === "no").length; // 未改密数

    // ---- 多选 + 批量改密/批量切换状态(基于筛选后列表) ----
    const toggleSel = (id: number) => setSelected((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
    const visibleIds = filtered.map((m) => m.id);
    const allSelected = visibleIds.length > 0 && visibleIds.every((id) => selected.has(id));
    const toggleAll = () => setSelected(allSelected ? new Set() : new Set(visibleIds));
    const selCount = [...selected].filter((id) => filtered.some((m) => m.id === id)).length;

    const doBatchChange = async () => {
        const ids = [...selected].filter((id) => filtered.some((m) => m.id === id));
        if (!ids.length) { toast("请先勾选邮箱"); return; }
        if (!confirm(`对选中 ${ids.length} 个邮箱执行 mail.com 改密(随机20位,headed 串行、逐个弹浏览器,可随时停止)?`)) return;
        try {
            const r = await api.batchChangeMailboxPasswd(ids);
            toast(r.count ? `已开始批量改密 ${r.count} 个(后台串行)` : (r.msg || "无可改邮箱"));
        } catch (e: any) { toast(e.message); }
    };
    const stopBatch = () => api.stopBatchPasswd().then(() => toast("已请求停止(当前号跑完即停)")).catch((e: any) => toast(e.message));
    const doBatchUsage = async (usage: "free" | "hold") => {
        const ids = [...selected].filter((id) => filtered.some((m) => m.id === id));
        if (!ids.length) { toast("请先勾选邮箱"); return; }
        try { const r = await api.setMailboxesUsage(ids, usage); toast(`已${usage === "hold" ? "设为独立" : "放回待分配"} ${r.count} 个(gpt/claude 已跳过)`); setSelected(new Set()); load(); } catch (e: any) { toast(e.message); }
    };
    const doBatchDelete = async () => {
        const ids = [...selected].filter((id) => filtered.some((m) => m.id === id));
        if (!ids.length) { toast("请先勾选邮箱"); return; }
        if (!confirm(`删除选中 ${ids.length} 个邮箱?被 gpt/claude 占用的会跳过(应从对应业务域删)。`)) return;
        try { const r = await api.batchDeleteMailbox(ids); toast(`已删除 ${r.count} 个${r.skipped ? `(占用跳过 ${r.skipped})` : ""}`); setSelected(new Set()); load(); } catch (e: any) { toast(e.message); }
    };


    const chip = (v: "" | "free" | "hold" | "gpt" | "claude", label: string, n: number) => (
        <button
            onClick={() => setUsageFilter(v)}
            style={{
                padding: "4px 12px", borderRadius: 14, cursor: "pointer", fontSize: 13,
                border: usageFilter === v ? "2px solid #10a37f" : "1px solid #d1d5db",
                background: usageFilter === v ? "#e6f7f1" : "#fff", fontWeight: usageFilter === v ? 600 : 400,
            }}
        >{label} {n}</button>
    );

    const card = {background: "#fff", border: "1px solid #e8eaed", borderRadius: 12, padding: 16, boxShadow: "0 1px 3px rgba(0,0,0,0.04)"};
    const inp = {padding: "6px 10px", border: "1px solid #e5e7eb", borderRadius: 8, fontSize: 13, outline: "none", boxSizing: "border-box" as const};

    return (
        <div style={{padding: 18, display: "flex", flexDirection: "column", gap: 14, height: "100%", boxSizing: "border-box", background: "#f6f7f9"}}>
            {/* 头部:标题 + 统计chips + 右侧策略/工具 */}
            <div style={{display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap"}}>
                <b style={{fontSize: 15, marginRight: 4}}>📮 邮箱资源池</b>
                {chip("", "全部", stats.total)}
                {chip("free", "待分配", stats.free)}
                {chip("hold", "独立", stats.hold)}
                {chip("gpt", "GPT", stats.gpt)}
                {chip("claude", "Claude", stats.claude)}
                <div style={{marginLeft: "auto", display: "flex", gap: 12, alignItems: "center"}}>
                    <MailCheckTool notify={notify} separator={mailSep}/>
                </div>
            </div>

            {/* 控制区:导入卡 + 分配卡(限宽均衡,避免宽屏拉伸) */}
            <div style={{display: "flex", gap: 14, alignItems: "stretch", flexWrap: "wrap", maxWidth: 1180}}>
                {/* 导入卡 */}
                <div style={{...card, flex: "1.8 1 420px", display: "flex", flexDirection: "column", gap: 10}}>
                    <div style={{display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap"}}>
                        <span style={{fontSize: 13, fontWeight: 600, color: "#111827"}}>📥 导入邮箱</span>
                        <span style={{fontSize: 11, color: "#9ca3af"}}>入池纯管理;默认「待分配」可被业务取用,勾「导入即独立」则永不被分配</span>
                    </div>
                    <textarea
                        value={importText} onChange={(e) => setImportText(e.target.value)} disabled={busy}
                        placeholder={`每行一个:  email${mailSep}password  /  email:password`}
                        style={{height: 84, resize: "vertical", padding: 10, fontFamily: "monospace", fontSize: 12, border: "1px solid #e5e7eb", borderRadius: 8, outline: "none"}}
                    />
                    <div style={{display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap"}}>
                        {/* 可选已有分组(datalist 下拉)或直接输入新分组 */}
                        <input value={grp} onChange={(e) => setGrp(e.target.value)} placeholder="分组/批次(选已有或输新)" list="mb-grp-options" style={{...inp, flex: "1 1 150px"}} />
                        <datalist id="mb-grp-options">
                            {groups.filter((g) => g.grp).map((g) => <option key={g.grp} value={g.grp}>{g.grp}({g.n})</option>)}
                        </datalist>
                        <label style={{fontSize: 12, color: "#7c3aed", display: "inline-flex", alignItems: "center", gap: 4, cursor: "pointer", whiteSpace: "nowrap"}} title="导入即设为独立(hold):永不被 GPT/Claude 分配,只纯管理">
                            <input type="checkbox" checked={importHold} onChange={(e) => setImportHold(e.target.checked)} disabled={busy} />导入即独立
                        </label>
                        <label style={{fontSize: 12, color: "#b45309", display: "inline-flex", alignItems: "center", gap: 4, cursor: "pointer", whiteSpace: "nowrap"}} title="导入后立即对这批邮箱改成随机20位密码(headed 串行,逐个弹浏览器)">
                            <input type="checkbox" checked={importAutoPw} onChange={(e) => setImportAutoPw(e.target.checked)} disabled={busy} />导入后自动改密
                        </label>
                        <label style={{fontSize: 12, color: "#0d9488", display: "inline-flex", alignItems: "center", gap: 4, whiteSpace: "nowrap"}} title="邮箱类型：mail.com(邮箱----密码) / iCloud(邮箱----查询码)">
                            类型
                            <select value={importProvider} onChange={(e) => setImportProvider(e.target.value as any)} style={{padding: "2px 4px", border: "1px solid #d1d5db", borderRadius: 4, fontSize: 12}}>
                                <option value="mailcom">mail.com</option>
                                <option value="icloud">iCloud</option>
                            </select>
                        </label>
                        <label style={{fontSize: 12, color: "#6b7280", display: "inline-flex", alignItems: "center", gap: 4, whiteSpace: "nowrap"}} title="邮箱与密码之间的分隔符(导入/校验共用)">
                            分隔符
                            <input value={mailSep} onChange={(e) => setMailSep(e.target.value)}
                                   onBlur={() => { if (mailSep.trim()) api.setMailSeparator(mailSep.trim()).catch((err: any) => toast("设置分隔符失败:" + err.message)); }}
                                   style={{width: 60, padding: "2px 6px", border: "1px solid #d1d5db", borderRadius: 4, fontFamily: "monospace", fontSize: 12, textAlign: "center"}} />
                        </label>
                        <button onClick={doImport} disabled={busy || !importText.trim()} style={{padding: "7px 20px", background: busy || !importText.trim() ? "#c7cbd1" : "#4f46e5", color: "#fff", border: "none", borderRadius: 8, cursor: busy || !importText.trim() ? "not-allowed" : "pointer", fontWeight: 500, fontSize: 13}}>导入</button>
                    </div>
                </div>
                {/* 分配卡 */}
                <div style={{...card, flex: "1 1 300px", display: "flex", flexDirection: "column", gap: 10}}>
                    <span style={{fontSize: 13, fontWeight: 600, color: "#111827"}}>🎯 分配到业务域</span>
                    <div style={{display: "flex", gap: 8, alignItems: "center"}}>
                        <span style={{fontSize: 13, color: "#6b7280", width: 30}}>来源</span>
                        <select value={allocSrc} onChange={(e) => setAllocSrc(e.target.value)} style={{...inp, flex: 1}}>
                            <option value="__ALL__">全部待分配({stats.free})</option>
                            {groups.map((g) => <option key={g.grp} value={"g:" + g.grp}>{g.grp || "(无分组)"}({g.n})</option>)}
                        </select>
                    </div>
                    <div style={{display: "flex", gap: 8, alignItems: "center"}}>
                        <span style={{fontSize: 13, color: "#6b7280", width: 30}}>数量</span>
                        <input type="number" min={1} max={srcCount || 1} value={allocCount} onChange={(e) => setAllocCount(Math.max(1, Number(e.target.value) || 1))} style={{...inp, width: 84}} />
                        <span style={{fontSize: 12, color: "#9ca3af"}}>可分配 {srcCount}</span>
                    </div>
                    <div style={{display: "flex", gap: 8}}>
                        <button onClick={() => doAllocate("gpt")} disabled={busy || srcCount === 0} style={{flex: 1, padding: "7px 10px", background: "#10a37f", color: "#fff", border: "none", borderRadius: 8, cursor: srcCount === 0 ? "not-allowed" : "pointer", opacity: srcCount === 0 ? 0.5 : 1, fontWeight: 500, fontSize: 13}}>→ GPT</button>
                        <button onClick={() => doAllocate("claude")} disabled={busy || srcCount === 0} style={{flex: 1, padding: "7px 10px", background: "#d97757", color: "#fff", border: "none", borderRadius: 8, cursor: srcCount === 0 ? "not-allowed" : "pointer", opacity: srcCount === 0 ? 0.5 : 1, fontWeight: 500, fontSize: 13}}>→ Claude</button>
                    </div>
                    <div style={{fontSize: 11, color: "#9ca3af", lineHeight: 1.5}}>只从选中来源取,<b>不动其他邮箱</b>。物理隔离不可串,GPT 立即进注册队列。</div>
                </div>
            </div>

            {/* 批量操作栏(选中或改密进行中时显示) */}
            {(selCount > 0 || batchPw.running) && (
                <div style={{display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap", background: "#fff", border: "1px solid #e8eaed", borderRadius: 12, padding: "10px 14px", boxShadow: "0 1px 3px rgba(0,0,0,0.04)"}}>
                    <span style={{fontSize: 13, color: "#374151"}}>已选 <b>{selCount}</b> 个</span>
                    {!batchPw.running
                        ? <>
                            <button onClick={doBatchChange} disabled={selCount === 0} style={{padding: "5px 14px", background: "#f59e0b", color: "#fff", border: "none", borderRadius: 6, cursor: selCount === 0 ? "not-allowed" : "pointer"}}>🔑 批量改密选中({selCount})</button>
                            <button onClick={() => doBatchUsage("hold")} disabled={selCount === 0} style={{padding: "5px 12px", background: "#7c3aed", color: "#fff", border: "none", borderRadius: 6, cursor: selCount === 0 ? "not-allowed" : "pointer"}}>🔒 设为独立</button>
                            <button onClick={() => doBatchUsage("free")} disabled={selCount === 0} style={{padding: "5px 12px", background: "#6b7280", color: "#fff", border: "none", borderRadius: 6, cursor: selCount === 0 ? "not-allowed" : "pointer"}}>↩ 放回待分配</button>
                            <button onClick={doBatchDelete} disabled={selCount === 0} style={{padding: "5px 12px", background: "#dc2626", color: "#fff", border: "none", borderRadius: 6, cursor: selCount === 0 ? "not-allowed" : "pointer"}}>🗑 批量删除</button>
                        </>
                        : <>
                            <span style={{fontSize: 13, color: "#2563eb"}}>改密中… {batchPw.done}/{batchPw.total}(成功 {batchPw.ok})</span>
                            <button onClick={stopBatch} style={{padding: "5px 12px", background: "#dc2626", color: "#fff", border: "none", borderRadius: 6, cursor: "pointer"}}>⏹ 停止</button>
                        </>}
                    {!batchPw.running && selCount > 0 && <button onClick={() => setSelected(new Set())} style={{padding: "5px 10px", fontSize: 13}}>清空选择</button>}
                    <label style={{fontSize: 12, color: "#6b7280", display: "inline-flex", alignItems: "center", gap: 3}}>并发
                        <input type="number" min={1} max={8} value={pwConc} onChange={(e) => setPwConc(Math.max(1, Math.min(8, Number(e.target.value) || 1)))}
                               onBlur={() => api.setPwConcurrency(pwConc).catch(() => {})}
                               style={{width: 42, padding: "2px 4px", border: "1px solid #d1d5db", borderRadius: 6, textAlign: "center", fontSize: 12}} />
                    </label>
                    <span style={{fontSize: 11, color: "#9ca3af"}}>改密=真登录 mail.com 改随机20位,headed、可停止;失败保留原密码并记录试过的新密码。</span>
                </div>
            )}

            {/* 筛选:分组 / 改密状态 / 邮箱 */}
            <div style={{display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", fontSize: 13}}>
                <select value={fGrp} onChange={(e) => setFGrp(e.target.value)} style={{padding: "5px 8px", border: "1px solid #e5e7eb", borderRadius: 8}}>
                    <option value="">全部分组</option>
                    <option value="__NONE__">未分组</option>
                    {allGrps.map((g) => <option key={g} value={g}>{g}</option>)}
                </select>
                <select value={fPw} onChange={(e) => setFPw(e.target.value as any)} style={{padding: "5px 8px", border: "1px solid #e5e7eb", borderRadius: 8}}>
                    <option value="">改密:全部</option>
                    <option value="no">未改密({noPwCount})</option>
                    <option value="yes">已改密</option>
                    <option value="fail">改密失败</option>
                </select>
                <input value={fEmail} onChange={(e) => setFEmail(e.target.value)} placeholder="邮箱关键词" style={{width: 150, padding: "5px 8px", border: "1px solid #e5e7eb", borderRadius: 8}} />
                <span style={{color: "#9ca3af", fontSize: 12}}>共 {filtered.length}{selCount ? ` · 已选 ${selCount}` : ""}</span>
            </div>

            {/* 邮箱列表 */}
            <div style={{flex: 1, overflow: "auto", background: "#fff", border: "1px solid #e8eaed", borderRadius: 12, boxShadow: "0 1px 3px rgba(0,0,0,0.04)"}}>
                <table style={{width: "100%", borderCollapse: "collapse", fontSize: 13}}>
                    <thead style={{position: "sticky", top: 0, background: "#f9fafb"}}>
                        <tr style={{textAlign: "left", color: "#6b7280"}}>
                            <th style={{padding: "8px 10px", width: 32}}><input type="checkbox" checked={allSelected} onChange={toggleAll} title="全选/取消当前列表"/></th>
                            <th style={{padding: "8px 10px"}}>邮箱</th>
                            <th style={{padding: "8px 10px"}}>归属</th>
                            <th style={{padding: "8px 10px"}}>改密状态</th>
                            <th style={{padding: "8px 10px"}}>分组</th>
                            <th style={{padding: "8px 10px"}}>操作</th>
                        </tr>
                    </thead>
                    <tbody>
                        {filtered.map((m) => (
                            <tr key={m.id} style={{borderTop: "1px solid #f3f4f6", background: selected.has(m.id) ? "#f0fdf9" : undefined}}>
                                <td style={{padding: "6px 10px"}}><input type="checkbox" checked={selected.has(m.id)} onChange={() => toggleSel(m.id)}/></td>
                                <td style={{padding: "6px 10px", fontFamily: "monospace"}}>
                                    <span onClick={() => setDetailMb(m)} title="点击查看操作日志 / 收件箱"
                                          style={{cursor: "pointer", color: detailMb?.id === m.id ? "#4f46e5" : "#374151", textDecoration: "underline", textDecorationColor: detailMb?.id === m.id ? "#4f46e5" : "#cbd5e1", textUnderlineOffset: 3}}
                                          onMouseEnter={(e) => { e.currentTarget.style.color = "#4f46e5"; e.currentTarget.style.textDecorationColor = "#4f46e5"; }}
                                          onMouseLeave={(e) => { const on = detailMb?.id === m.id; e.currentTarget.style.color = on ? "#4f46e5" : "#374151"; e.currentTarget.style.textDecorationColor = on ? "#4f46e5" : "#cbd5e1"; }}>{m.email}</span>
                                </td>
                                <td style={{padding: "6px 10px"}}>
                                    <span style={{padding: "1px 8px", borderRadius: 10, fontSize: 12, color: "#fff", background: USAGE_COLOR[m.usage] || "#6b7280"}}>
                                        {USAGE_LABEL[m.usage] || m.usage}
                                    </span>
                                </td>
                                <td style={{padding: "6px 10px", color: (m.pw_status || "").startsWith("✅") ? "#10a37f" : (m.pw_status || "").startsWith("❌") ? "#dc2626" : "#9ca3af"}}>{m.pw_status || "—"}</td>
                                <td style={{padding: "6px 10px", color: "#6b7280"}}>{m.grp || "—"}</td>
                                <td style={{padding: "6px 10px", whiteSpace: "nowrap"}}>
                                    <button onClick={() => doChangePw(m)} disabled={busy || batchPw.running} style={{marginRight: 6, fontSize: 12}}>改密</button>
                                    {m.usage === "free" && <button onClick={() => doSetUsage(m, "hold")} style={{marginRight: 6, fontSize: 12, color: "#7c3aed"}} title="设为独立:永不被 GPT/Claude 分配">设独立</button>}
                                    {m.usage === "hold" && <button onClick={() => doSetUsage(m, "free")} style={{marginRight: 6, fontSize: 12, color: "#4f46e5"}} title="放回待分配:可被业务取用">放回</button>}
                                    {(m.usage === "free" || m.usage === "hold") && <button onClick={() => doDelete(m)} style={{fontSize: 12, color: "#dc2626"}}>删除</button>}
                                </td>
                            </tr>
                        ))}
                        {filtered.length === 0 && (
                            <tr><td colSpan={6} style={{padding: 24, textAlign: "center", color: "#9ca3af"}}>{list.length ? "无匹配筛选的邮箱" : "暂无邮箱。可在上方导入独立邮箱。"}</td></tr>
                        )}
                    </tbody>
                </table>
            </div>

            {detailMb && <MailboxDetail mailbox={detailMb} onClose={() => setDetailMb(null)}/>}
        </div>
    );
}
