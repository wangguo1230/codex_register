// Claude 订阅/套餐查询工具(独立)。批量对已注册成功的 Claude 账号:
//   比特浏览器注入 sessionKey 过 CF → 查 current_user_access + org → 得存活/套餐(Free/Paid)/claude_code 权限/tier。
// 后台串行跑(比特较慢),结果走 SSE(claude 事件的 result)实时逐行更新。也回写 claude_accounts(plan/claude_code/dead_at)。
import {useEffect, useState} from "react";
import {api, connectStream} from "./api";

type Row = {id: number; email: string; status: "idle" | "querying" | "done"; alive?: boolean; plan?: string; claudeCode?: string; tier?: string; reason?: string};
const CC_LABEL: Record<string, string> = {available: "✅ 可用", blocked_by_org_tier: "🔒 需付费档", blocked_by_platform: "⛔ 平台限", blocked_by_org_admin: "⛔ 管理员限"};

export function ClaudeSubTool({onClose, notify}: {onClose: () => void; notify?: (m: string) => void}) {
    const [rows, setRows] = useState<Row[]>([]);
    const [running, setRunning] = useState(false);

    useEffect(() => {
        api.listClaudeAccounts().then((r) => setRows(r.list.filter((a) => a.status === "success").map((a) => ({id: a.id, email: a.email, status: "idle", plan: a.plan, claudeCode: a.claude_code})))).catch(() => {});
        const off = connectStream((ev, data: any) => {
            if (ev === "claude" && data?.result) {
                const r = data.result;
                setRows((prev) => prev.map((x) => x.id === r.id ? {...x, status: "done", alive: r.alive, plan: r.plan, claudeCode: r.claudeCode, tier: r.tier, reason: r.reason} : x));
            }
        });
        return off; /* eslint-disable-next-line */
    }, []);

    const doneN = rows.filter((r) => r.status === "done").length;
    const queryingN = rows.filter((r) => r.status === "querying").length;
    useEffect(() => { if (running && queryingN === 0 && doneN > 0) setRunning(false); }, [queryingN, doneN, running]);

    const run = async () => {
        const ids = rows.map((r) => r.id);
        if (!ids.length) { notify?.("无已注册成功的 Claude 账号"); return; }
        setRows((prev) => prev.map((r) => ({...r, status: "querying"})));
        setRunning(true);
        try { const r = await api.queryClaude(ids); notify?.(`已开始查询 ${r.count} 个(比特浏览器串行,每个约 20-40s)`); }
        catch (e: any) { notify?.(e.message); setRunning(false); }
    };
    const chat = async () => {
        const ids = rows.filter((r) => r.alive !== false).map((r) => r.id);
        if (!ids.length) { notify?.("无可养号账号"); return; }
        if (!confirm(`对 ${ids.length} 个 Claude 账号各发一条消息养号(比特浏览器,较慢)?`)) return;
        try { const r = await api.chatClaude(ids); notify?.(`已开始养号 ${r.count} 个(后台跑,进度见 Claude 详情日志)`); } catch (e: any) { notify?.(e.message); }
    };

    return (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-30" onClick={onClose}>
            <div className="bg-white rounded-xl w-[720px] max-h-[85vh] flex flex-col shadow-2xl" onClick={(e) => e.stopPropagation()}>
                <div className="px-5 py-3 border-b flex items-center justify-between">
                    <span className="font-medium">🧠 Claude 订阅 / 套餐查询 <span className="text-xs text-gray-400 font-normal">比特浏览器过 CF · 查存活+套餐+Claude Code 权限</span></span>
                    <button onClick={onClose} className="text-gray-400 hover:text-gray-700 text-lg leading-none">✕</button>
                </div>
                <div className="px-5 py-3 border-b flex items-center gap-3 flex-wrap">
                    <button onClick={run} disabled={running || rows.length === 0} className={`px-4 py-1.5 rounded text-sm font-medium text-white ${running || rows.length === 0 ? "bg-gray-400 cursor-not-allowed" : "bg-indigo-600 hover:bg-indigo-700"}`}>{running ? `查询中… ${doneN}/${rows.length}` : `🔍 查询全部(${rows.length})`}</button>
                    <button onClick={chat} disabled={rows.length === 0} className="px-4 py-1.5 rounded text-sm font-medium bg-emerald-600 hover:bg-emerald-700 text-white disabled:opacity-40">💬 批量养号</button>
                    {rows.length > 0 && <span className="text-xs text-gray-500">共 {rows.length} 个成功号 · 存活 {rows.filter((r) => r.alive === true).length} · 失效/受限 {rows.filter((r) => r.alive === false).length}</span>}
                </div>
                <div className="flex-1 overflow-auto">
                    <table className="w-full text-xs">
                        <thead className="bg-gray-100 text-gray-500 sticky top-0"><tr>
                            <th className="text-left px-3 py-1.5">邮箱</th><th className="text-left px-3 py-1.5">存活</th><th className="text-left px-3 py-1.5">套餐</th><th className="text-left px-3 py-1.5">Claude Code</th><th className="text-left px-3 py-1.5">tier / 说明</th>
                        </tr></thead>
                        <tbody>
                            {rows.map((r) => (
                                <tr key={r.id} className="border-t">
                                    <td className="px-3 py-1.5 font-mono">{r.email}</td>
                                    <td className="px-3 py-1.5">
                                        {r.status === "querying" ? <span className="text-blue-500">🔄 查询中…</span>
                                            : r.status === "idle" ? <span className="text-gray-400">—</span>
                                                : r.alive ? <span className="text-green-600">✅ 存活</span> : <span className="text-red-500">❌ 失效</span>}
                                    </td>
                                    <td className="px-3 py-1.5">{r.alive === false ? "—" : (r.plan ? <span className={r.plan === "Free" ? "text-gray-600" : "text-amber-600 font-medium"}>{r.plan}</span> : "—")}</td>
                                    <td className="px-3 py-1.5">{r.claudeCode ? (CC_LABEL[r.claudeCode] || r.claudeCode) : "—"}</td>
                                    <td className="px-3 py-1.5 text-gray-500">{r.reason || r.tier || "—"}</td>
                                </tr>
                            ))}
                            {rows.length === 0 && <tr><td colSpan={5} className="px-3 py-10 text-center text-gray-400">暂无注册成功的 Claude 账号</td></tr>}
                        </tbody>
                    </table>
                </div>
                <div className="px-5 py-2 border-t text-xs text-gray-400">比特浏览器逐个查(每个 20-40s),结果实时更新并回写。详细过程:Claude 页点账号邮箱名开详情日志(独立)。</div>
            </div>
        </div>
    );
}
