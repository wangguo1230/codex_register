// Claude 注册面板(架构 v2 前端三模块之一,与 GPT 注册对称)。
//   - 列出 Claude 业务账号(claude_accounts,经 usage='claude' 从邮箱池分配而来,★与 GPT 物理隔离)
//   - 从 free 池分配 N 个占位账号给 Claude
//   - 注册机制(claude.ai 逆向)未就绪:自动注册按钮暂禁用,机制定稿后接 /api/claude/register + ClaudeRegisterEngine
// 设计:结构对称于 GPT 视图,机制一到即可在此挂注册/凭证/养号操作,骨架不改。
import {useEffect, useState} from "react";
import {api, type ClaudeAccount, type Stats} from "./api";

const ST_COLOR: Record<string, string> = {pending: "#6b7280", running: "#2563eb", success: "#d97757", failed: "#dc2626"};
const EMPTY: Stats = {pending: 0, running: 0, success: 0, failed: 0, total: 0};

export function ClaudePanel({notify}: {notify?: (m: string) => void}) {
    const [list, setList] = useState<ClaudeAccount[]>([]);
    const [stats, setStats] = useState<Stats>(EMPTY);
    const [freeCount, setFreeCount] = useState(0);
    const [allocCount, setAllocCount] = useState(1);
    const [batch, setBatch] = useState("");
    const [busy, setBusy] = useState(false);

    const toast = (m: string) => notify?.(m);
    const load = () => {
        api.listClaudeAccounts().then((r) => { setList(r.list); setStats(r.stats); }).catch(() => {});
        api.listMailboxes("free").then((r) => setFreeCount(r.stats.free)).catch(() => {});
    };
    useEffect(() => { load(); /* eslint-disable-next-line */ }, []);

    const doAllocate = async () => {
        if (!(allocCount > 0)) return;
        if (!confirm(`从 free 池分配 ${allocCount} 个占位账号给 Claude?(注册机制未就绪,分配后仅占位,暂不能自动注册)`)) return;
        setBusy(true);
        try {
            const r = await api.allocateMailboxes("claude", allocCount, batch);
            if (r.error) toast(r.error);
            else toast(`已从 free 池分配 ${r.allocated} 个给 Claude(占位)`);
            load();
        } catch (e: any) { toast("分配失败:" + e.message); } finally { setBusy(false); }
    };

    return (
        <div style={{padding: 16, display: "flex", flexDirection: "column", gap: 14, height: "100%", boxSizing: "border-box"}}>
            {/* 机制待逆向提示 */}
            <div style={{padding: "10px 14px", borderRadius: 8, background: "#fdf3ee", border: "1px solid #f0c8b4", color: "#9a3412", fontSize: 13, lineHeight: 1.6}}>
                🧠 <b>Claude 注册域</b>:邮箱与 GPT <b>物理隔离(usage=claude,不可串)</b>。注册机制(claude.ai 逆向)尚未攻克,
                当前可从邮箱池分配<b>占位账号</b>,自动注册待 <code>ClaudeRegisterEngine</code> 实现
                (见 <code>docs/ARCHITECTURE-v2.md §8 D1</code>)。机制一到,注册/凭证/养号即可在本面板挂载,骨架不变。
            </div>

            {/* 统计 */}
            <div style={{display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap"}}>
                <b style={{marginRight: 6}}>🧠 Claude 账号</b>
                {(["total", "pending", "running", "success", "failed"] as const).map((k) => (
                    <span key={k} style={{padding: "4px 12px", borderRadius: 14, fontSize: 13, border: "1px solid #e5e7eb", background: "#fff"}}>
                        {{total: "全部", pending: "等待", running: "运行", success: "成功", failed: "失败"}[k]} {(stats as any)[k]}
                    </span>
                ))}
            </div>

            {/* 从池分配占位账号 */}
            <div style={{display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", border: "1px dashed #d1d5db", borderRadius: 8, padding: 12}}>
                <span style={{fontSize: 13, color: "#374151"}}>从 <b>free 池({freeCount})</b> 分配</span>
                <input type="number" min={1} value={allocCount} onChange={(e) => setAllocCount(Math.max(1, Number(e.target.value) || 1))} style={{width: 72, padding: "5px 8px"}} />
                <span style={{fontSize: 13}}>个</span>
                <input value={batch} onChange={(e) => setBatch(e.target.value)} placeholder="批次(可选)" style={{width: 140, padding: "5px 8px"}} />
                <button onClick={doAllocate} disabled={busy || freeCount === 0} style={{padding: "6px 16px", background: "#d97757", color: "#fff", border: "none", borderRadius: 6, cursor: freeCount === 0 ? "not-allowed" : "pointer"}}>→ 分配给 Claude(占位)</button>
                <button disabled title="Claude 注册机制待逆向,暂不可用" style={{padding: "6px 16px", background: "#e5e7eb", color: "#9ca3af", border: "none", borderRadius: 6, cursor: "not-allowed"}}>▶ 开始注册(待实现)</button>
            </div>

            {/* Claude 账号列表 */}
            <div style={{flex: 1, overflow: "auto", border: "1px solid #e5e7eb", borderRadius: 8}}>
                <table style={{width: "100%", borderCollapse: "collapse", fontSize: 13}}>
                    <thead style={{position: "sticky", top: 0, background: "#f9fafb"}}>
                        <tr style={{textAlign: "left", color: "#6b7280"}}>
                            <th style={{padding: "8px 10px"}}>邮箱</th>
                            <th style={{padding: "8px 10px"}}>状态</th>
                            <th style={{padding: "8px 10px"}}>凭证(session_key)</th>
                            <th style={{padding: "8px 10px"}}>批次</th>
                        </tr>
                    </thead>
                    <tbody>
                        {list.map((a) => (
                            <tr key={a.id} style={{borderTop: "1px solid #f3f4f6"}}>
                                <td style={{padding: "6px 10px", fontFamily: "monospace"}}>{a.email}</td>
                                <td style={{padding: "6px 10px"}}>
                                    <span style={{padding: "1px 8px", borderRadius: 10, fontSize: 12, color: "#fff", background: ST_COLOR[a.status] || "#6b7280"}}>{a.status}</span>
                                </td>
                                <td style={{padding: "6px 10px", color: "#9ca3af", fontFamily: "monospace"}}>{a.session_key ? a.session_key.slice(0, 16) + "…" : "—"}</td>
                                <td style={{padding: "6px 10px", color: "#6b7280"}}>{a.batch || "—"}</td>
                            </tr>
                        ))}
                        {list.length === 0 && (
                            <tr><td colSpan={4} style={{padding: 24, textAlign: "center", color: "#9ca3af"}}>暂无 Claude 账号。可从上方 free 池分配占位账号。</td></tr>
                        )}
                    </tbody>
                </table>
            </div>
        </div>
    );
}
