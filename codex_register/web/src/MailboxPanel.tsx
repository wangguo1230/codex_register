// 邮箱管理面板(架构 v2:邮箱能力唯一中心)。所有邮箱操作集中于此,GPT/Claude 只做注册。
//   - 查看全部邮箱,按 usage(free/gpt/claude)筛选;free=独立/未归属,gpt/claude=已归属业务
//   - 导入独立邮箱(可选「导入后自动改密」);从指定分组的 free 池分配 N 个给 GPT/Claude(★物理隔离)
//   - 单个改密 / 多选批量改密(mail.com 真改,覆盖所有邮箱)/ 删除(仅 free)
//   - 业务注册后自动改密开关(全局策略)/ 邮箱密码校验工具
import {useEffect, useState} from "react";
import {api, connectStream, type Mailbox} from "./api";
import {MailCheckTool} from "./MailCheckTool";

const USAGE_LABEL: Record<string, string> = {free: "独立/未归属", gpt: "GPT", claude: "Claude"};
const USAGE_COLOR: Record<string, string> = {free: "#6b7280", gpt: "#10a37f", claude: "#d97757"};
type BatchPw = {running: boolean; done: number; total: number; ok: number; stopped?: boolean};

export function MailboxPanel({notify}: {notify?: (m: string) => void}) {
    const [list, setList] = useState<Mailbox[]>([]);
    const [stats, setStats] = useState({free: 0, gpt: 0, claude: 0, total: 0});
    const [groups, setGroups] = useState<{grp: string; n: number}[]>([]); // 独立(free)邮箱的分组分布
    const [usageFilter, setUsageFilter] = useState<"" | "free" | "gpt" | "claude">("");
    const [importText, setImportText] = useState("");
    const [grp, setGrp] = useState("");
    const [importAutoPw, setImportAutoPw] = useState(false); // 导入后自动改密
    const [allocCount, setAllocCount] = useState(1);
    const [allocSrc, setAllocSrc] = useState("__ALL__"); // 分配来源:__ALL__=全池 / "g:<分组名>"=只从该分组(避免误分想保留的)
    const [busy, setBusy] = useState(false);
    const [selected, setSelected] = useState<Set<number>>(new Set()); // 多选(批量改密)
    const [batchPw, setBatchPw] = useState<BatchPw>({running: false, done: 0, total: 0, ok: 0});
    const [autoPasswd, setAutoPasswd] = useState(false); // 业务注册后自动改密(全局策略)

    const toast = (m: string) => notify?.(m);
    const load = () =>
        api.listMailboxes(usageFilter || undefined).then((r) => { setList(r.list); setStats(r.stats); setGroups(r.groups || []); }).catch(() => {});
    useEffect(() => { load(); /* eslint-disable-next-line */ }, [usageFilter]);
    // 实时刷新(邮箱变化/批量改密进度)+ 初始拉注册后自动改密开关
    useEffect(() => {
        api.state().then((s) => setAutoPasswd(!!s.state.autoChangePasswd)).catch(() => {});
        const off = connectStream((ev, data) => {
            if (ev === "mailboxes") load();
            else if (ev === "batchPw") { setBatchPw(data); if (!data.running) load(); }
            else if (ev === "hello" && data?.state?.batchPw) setBatchPw(data.state.batchPw);
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
            const r = await api.importFreeMailboxes(importText, "", grp, importAutoPw);
            toast(`导入独立邮箱:新增 ${r.inserted} / 跳过 ${r.skipped}${r.autoChangePw ? ` · 已启动 ${r.autoChangePw} 个自动改密` : ""}`);
            setImportText("");
            load();
        } catch (e: any) { toast("导入失败:" + e.message); } finally { setBusy(false); }
    };

    const doAllocate = async (usage: "gpt" | "claude") => {
        if (!(allocCount > 0)) return;
        if (allocCount > srcCount && !confirm(`该来源只有 ${srcCount} 个独立邮箱,少于要分配的 ${allocCount} 个,将只分配 ${srcCount} 个。继续?`)) return;
        const srcLabel = allocSrc === "__ALL__" ? "全部独立邮箱" : (srcFromGrp || "(无分组)");
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

    // ---- 多选 + 批量改密 ----
    const toggleSel = (id: number) => setSelected((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
    const visibleIds = list.map((m) => m.id);
    const allSelected = visibleIds.length > 0 && visibleIds.every((id) => selected.has(id));
    const toggleAll = () => setSelected(allSelected ? new Set() : new Set(visibleIds));
    const selCount = [...selected].filter((id) => list.some((m) => m.id === id)).length;

    const doBatchChange = async () => {
        const ids = [...selected].filter((id) => list.some((m) => m.id === id));
        if (!ids.length) { toast("请先勾选邮箱"); return; }
        if (!confirm(`对选中 ${ids.length} 个邮箱执行 mail.com 改密(随机20位,headed 串行、逐个弹浏览器,可随时停止)?`)) return;
        try {
            const r = await api.batchChangeMailboxPasswd(ids);
            toast(r.count ? `已开始批量改密 ${r.count} 个(后台串行)` : (r.msg || "无可改邮箱"));
        } catch (e: any) { toast(e.message); }
    };
    const stopBatch = () => api.stopBatchPasswd().then(() => toast("已请求停止(当前号跑完即停)")).catch((e: any) => toast(e.message));

    const toggleAutoPasswd = (v: boolean) => {
        setAutoPasswd(v);
        api.setAutoPasswd(v).then(() => toast(v ? "已开启:业务注册成功后自动改邮箱密码(随机20位)" : "已关闭注册后自动改密")).catch((e: any) => toast(e.message));
    };

    const chip = (v: "" | "free" | "gpt" | "claude", label: string, n: number) => (
        <button
            onClick={() => setUsageFilter(v)}
            style={{
                padding: "4px 12px", borderRadius: 14, cursor: "pointer", fontSize: 13,
                border: usageFilter === v ? "2px solid #10a37f" : "1px solid #d1d5db",
                background: usageFilter === v ? "#e6f7f1" : "#fff", fontWeight: usageFilter === v ? 600 : 400,
            }}
        >{label} {n}</button>
    );

    return (
        <div style={{padding: 16, display: "flex", flexDirection: "column", gap: 14, height: "100%", boxSizing: "border-box"}}>
            {/* 统计 + 筛选 + 校验工具 */}
            <div style={{display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap"}}>
                <b style={{marginRight: 6}}>📮 邮箱资源池</b>
                {chip("", "全部", stats.total)}
                {chip("free", "独立/未归属", stats.free)}
                {chip("gpt", "GPT", stats.gpt)}
                {chip("claude", "Claude", stats.claude)}
                <div style={{marginLeft: "auto", display: "flex", gap: 8, alignItems: "center"}}>
                    <label style={{fontSize: 12, color: "#374151", display: "inline-flex", alignItems: "center", gap: 4, cursor: "pointer"}} title="业务(GPT等)注册成功后,自动把该邮箱密码改成随机20位并同步库">
                        <input type="checkbox" checked={autoPasswd} onChange={(e) => toggleAutoPasswd(e.target.checked)} />注册后自动改密
                    </label>
                    <MailCheckTool notify={notify}/>
                </div>
            </div>
            <div style={{fontSize: 12, color: "#9ca3af", marginTop: -6}}>「独立/未归属」= 已导入但不属于 GPT/Claude 的邮箱,可长期纯管理,也可按需分配给业务。所有邮箱的导入/改密都在本页操作。</div>

            {/* 导入独立邮箱(可选自动改密) + 分配 */}
            <div style={{display: "flex", gap: 12, alignItems: "stretch", flexWrap: "wrap"}}>
                <div style={{flex: "1 1 340px", display: "flex", flexDirection: "column", gap: 6}}>
                    <textarea
                        value={importText} onChange={(e) => setImportText(e.target.value)} disabled={busy}
                        placeholder={"导入独立邮箱(每行 email----password / email:password)\n仅入池纯管理,不归属 GPT/Claude、不进任何注册队列"}
                        style={{height: 72, resize: "vertical", padding: 8, fontFamily: "monospace", fontSize: 12}}
                    />
                    <div style={{display: "flex", gap: 8, alignItems: "center"}}>
                        {/* 可选已有分组(datalist 下拉)或直接输入新分组 */}
                        <input value={grp} onChange={(e) => setGrp(e.target.value)} placeholder="分组/批次(可选,选已有或输新)" list="mb-grp-options" style={{flex: 1, padding: "5px 8px"}} />
                        <datalist id="mb-grp-options">
                            {groups.filter((g) => g.grp).map((g) => <option key={g.grp} value={g.grp}>{g.grp}({g.n})</option>)}
                        </datalist>
                        <button onClick={doImport} disabled={busy || !importText.trim()} style={{padding: "6px 16px"}}>导入独立邮箱</button>
                    </div>
                    <label style={{fontSize: 12, color: "#b45309", display: "inline-flex", alignItems: "center", gap: 4, cursor: "pointer"}} title="导入后立即对这批邮箱改成随机20位密码(headed 串行,逐个弹浏览器)">
                        <input type="checkbox" checked={importAutoPw} onChange={(e) => setImportAutoPw(e.target.checked)} disabled={busy} />导入后自动改密(随机20位)
                    </label>
                </div>
                <div style={{flex: "0 0 280px", display: "flex", flexDirection: "column", gap: 8, border: "1px dashed #d1d5db", borderRadius: 8, padding: 12}}>
                    <div style={{fontSize: 13, color: "#374151"}}>分配独立邮箱到业务域:</div>
                    <div style={{display: "flex", gap: 8, alignItems: "center"}}>
                        <span style={{fontSize: 13, whiteSpace: "nowrap"}}>来源</span>
                        <select value={allocSrc} onChange={(e) => setAllocSrc(e.target.value)} style={{flex: 1, padding: "5px 8px"}}>
                            <option value="__ALL__">全部独立邮箱({stats.free})</option>
                            {groups.map((g) => <option key={g.grp} value={"g:" + g.grp}>{g.grp || "(无分组)"}({g.n})</option>)}
                        </select>
                    </div>
                    <div style={{display: "flex", gap: 8, alignItems: "center"}}>
                        <span style={{fontSize: 13}}>数量</span>
                        <input type="number" min={1} max={srcCount || 1} value={allocCount} onChange={(e) => setAllocCount(Math.max(1, Number(e.target.value) || 1))} style={{width: 72, padding: "5px 8px"}} />
                        <span style={{fontSize: 12, color: "#9ca3af"}}>该来源可分配 {srcCount}</span>
                    </div>
                    <div style={{display: "flex", gap: 8}}>
                        <button onClick={() => doAllocate("gpt")} disabled={busy || srcCount === 0} style={{flex: 1, padding: "6px 10px", background: "#10a37f", color: "#fff", border: "none", borderRadius: 6, cursor: srcCount === 0 ? "not-allowed" : "pointer", opacity: srcCount === 0 ? 0.5 : 1}}>→ GPT</button>
                        <button onClick={() => doAllocate("claude")} disabled={busy || srcCount === 0} style={{flex: 1, padding: "6px 10px", background: "#d97757", color: "#fff", border: "none", borderRadius: 6, cursor: srcCount === 0 ? "not-allowed" : "pointer", opacity: srcCount === 0 ? 0.5 : 1}}>→ Claude</button>
                    </div>
                    <div style={{fontSize: 11, color: "#9ca3af"}}>只从选中来源取,<b>不会动其他独立邮箱</b>。分配=锁定 usage+建 pending 业务号,物理隔离不可串。GPT 立即进注册队列。</div>
                </div>
            </div>

            {/* 批量操作栏(选中或改密进行中时显示) */}
            {(selCount > 0 || batchPw.running) && (
                <div style={{display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap", background: "#f9fafb", border: "1px solid #e5e7eb", borderRadius: 8, padding: "8px 12px"}}>
                    <span style={{fontSize: 13, color: "#374151"}}>已选 <b>{selCount}</b> 个</span>
                    {!batchPw.running
                        ? <button onClick={doBatchChange} disabled={selCount === 0} style={{padding: "5px 14px", background: "#f59e0b", color: "#fff", border: "none", borderRadius: 6, cursor: selCount === 0 ? "not-allowed" : "pointer"}}>🔑 批量改密选中({selCount})</button>
                        : <>
                            <span style={{fontSize: 13, color: "#2563eb"}}>改密中… {batchPw.done}/{batchPw.total}(成功 {batchPw.ok})</span>
                            <button onClick={stopBatch} style={{padding: "5px 12px", background: "#dc2626", color: "#fff", border: "none", borderRadius: 6, cursor: "pointer"}}>⏹ 停止</button>
                        </>}
                    {!batchPw.running && selCount > 0 && <button onClick={() => setSelected(new Set())} style={{padding: "5px 10px", fontSize: 13}}>清空选择</button>}
                    <span style={{fontSize: 11, color: "#9ca3af"}}>批量改密=真登录 mail.com 逐个改随机20位,headed 串行、可停止;失败保留原密码并记录试过的新密码。</span>
                </div>
            )}

            {/* 邮箱列表 */}
            <div style={{flex: 1, overflow: "auto", border: "1px solid #e5e7eb", borderRadius: 8}}>
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
                        {list.map((m) => (
                            <tr key={m.id} style={{borderTop: "1px solid #f3f4f6", background: selected.has(m.id) ? "#f0fdf9" : undefined}}>
                                <td style={{padding: "6px 10px"}}><input type="checkbox" checked={selected.has(m.id)} onChange={() => toggleSel(m.id)}/></td>
                                <td style={{padding: "6px 10px", fontFamily: "monospace"}}>{m.email}</td>
                                <td style={{padding: "6px 10px"}}>
                                    <span style={{padding: "1px 8px", borderRadius: 10, fontSize: 12, color: "#fff", background: USAGE_COLOR[m.usage] || "#6b7280"}}>
                                        {USAGE_LABEL[m.usage] || m.usage}
                                    </span>
                                </td>
                                <td style={{padding: "6px 10px", color: (m.pw_status || "").startsWith("✅") ? "#10a37f" : (m.pw_status || "").startsWith("❌") ? "#dc2626" : "#9ca3af"}}>{m.pw_status || "—"}</td>
                                <td style={{padding: "6px 10px", color: "#6b7280"}}>{m.grp || "—"}</td>
                                <td style={{padding: "6px 10px", whiteSpace: "nowrap"}}>
                                    <button onClick={() => doChangePw(m)} disabled={busy || batchPw.running} style={{marginRight: 6, fontSize: 12}}>改密</button>
                                    {m.usage === "free" && <button onClick={() => doDelete(m)} style={{fontSize: 12, color: "#dc2626"}}>删除</button>}
                                </td>
                            </tr>
                        ))}
                        {list.length === 0 && (
                            <tr><td colSpan={6} style={{padding: 24, textAlign: "center", color: "#9ca3af"}}>暂无邮箱。可在上方导入独立邮箱。</td></tr>
                        )}
                    </tbody>
                </table>
            </div>
        </div>
    );
}
