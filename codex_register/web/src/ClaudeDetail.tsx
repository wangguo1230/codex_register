// Claude 账号详情右侧抽屉。独立展示 Claude 域日志(注册/查订阅/养号,读独立 claude_logs 表,
// 与邮箱日志/GPT 日志分开)+ 凭证信息(sessionKey/org/套餐/claude_code)。SSE claudeLog 实时追加。
import {useEffect, useState} from "react";
import {api, connectStream, type ClaudeAccount} from "./api";

const CC_LABEL: Record<string, string> = {available: "✅ 可用", blocked_by_org_tier: "🔒 需付费档", blocked_by_platform: "⛔ 平台限", blocked_by_org_admin: "⛔ 管理员限"};

export function ClaudeDetail({account, onClose}: {account: ClaudeAccount; onClose: () => void}) {
    const [logs, setLogs] = useState<{ts: number; line: string}[]>([]);
    const [copied, setCopied] = useState("");
    const [scanning, setScanning] = useState(false); // 扫邮箱检测禁用中

    const loadLogs = () => api.claudeLogs(account.id).then(setLogs).catch(() => {});
    useEffect(() => {
        loadLogs();
        const off = connectStream((ev, data: any) => {
            if (ev === "claudeLog" && data?.id === account.id) setLogs((p) => [...p, {ts: data.ts, line: data.line}]);
            if (ev === "claude" && data?.result?.id === account.id) setScanning(false); // 检测出结果→复位按钮
        });
        return off; /* eslint-disable-next-line */
    }, [account.id]);

    const doScan = async () => {
        setScanning(true);
        try { await api.scanClaudeDisabled(account.id); } catch { setScanning(false); }
    };

    const copy = (v: string, tag: string) => { try { navigator.clipboard?.writeText(v); } catch { /* */ } setCopied(tag); setTimeout(() => setCopied(""), 1500); };
    const info = (label: string, val: any, copyVal?: string, tag?: string) => (
        <><span className="text-gray-400">{label}</span>
        <span className="text-gray-700 break-all font-mono flex items-center gap-2">{val || "—"}{copyVal && <button onClick={() => copy(copyVal, tag!)} className="text-indigo-600 hover:underline shrink-0 font-sans">{copied === tag ? "✓已复制" : "复制"}</button>}</span></>
    );

    return (
        <>
            <div className="fixed inset-0 bg-black/30 z-30" onClick={onClose}/>
            <div className="fixed top-0 right-0 bottom-0 w-[46%] min-w-[420px] max-w-[720px] bg-white shadow-2xl z-40 flex flex-col">
                <div className="px-5 py-3 border-b flex items-center justify-between shrink-0">
                    <div className="min-w-0">
                        <div className="font-mono text-sm truncate">{account.email}</div>
                        <div className="text-xs text-gray-400">Claude 账号 · 状态 {account.status}{account.batch ? ` · 批次 ${account.batch}` : ""}</div>
                    </div>
                    <button onClick={onClose} className="text-gray-400 hover:text-gray-700 text-xl leading-none ml-3 shrink-0">✕</button>
                </div>
                {/* 凭证/订阅信息 */}
                <div className="px-5 py-3 border-b bg-gray-50 text-xs shrink-0" style={{display: "grid", gridTemplateColumns: "auto 1fr", columnGap: 14, rowGap: 6, alignItems: "center"}}>
                    {info("sessionKey", account.session_key ? account.session_key.slice(0, 22) + "…" : "", account.session_key, "sk")}
                    {info("org_id", account.org_id, account.org_id, "org")}
                    {info("套餐", account.plan ? <span className={account.plan === "Free" ? "text-gray-600" : "text-amber-600 font-semibold"}>{account.plan}</span> : "")}
                    {info("Claude Code", account.claude_code ? (CC_LABEL[account.claude_code] || account.claude_code) : "")}
                    {account.error ? info("错误", <span className="text-red-500">{account.error.slice(0, 60)}</span>) : null}
                </div>
                {/* Claude 域日志 */}
                <div className="px-4 pt-2 flex gap-1 border-b items-center shrink-0">
                    <span className="px-3 py-1.5 rounded-t text-xs font-medium bg-gray-900 text-white">📋 Claude 日志</span>
                    <button onClick={doScan} disabled={scanning} className="ml-auto text-xs text-teal-600 hover:underline disabled:opacity-40" title="扫邮箱找 Anthropic 禁用通知,未命中再 API 探测存活;命中即标失效(过程见下方日志)">{scanning ? "🔍 检测中…" : "🔍 检测是否禁用"}</button>
                    <button onClick={loadLogs} className="text-xs text-indigo-600 hover:underline">🔄 刷新</button>
                </div>
                <div className="flex-1 overflow-auto min-h-0">
                    <div className="px-3 py-2 font-mono text-xs leading-relaxed bg-gray-900 text-gray-100 min-h-full">
                        {logs.length === 0
                            ? <div className="text-gray-500">（暂无该 Claude 账号日志。注册/查订阅/养号会实时记录在此,独立于邮箱与 GPT 日志）</div>
                            : logs.map((l, i) => (
                                <div key={i} className="whitespace-pre-wrap break-all">
                                    <span className="text-gray-600">{new Intl.DateTimeFormat("en-GB", {timeZone: "Asia/Shanghai", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false}).format(new Date(l.ts))} </span>
                                    <span className={l.line.includes("✅") || l.line.includes("✓") ? "text-green-400" : l.line.includes("❌") || l.line.includes("✗") ? "text-red-400" : ""}>{l.line}</span>
                                </div>
                            ))}
                    </div>
                </div>
            </div>
        </>
    );
}
