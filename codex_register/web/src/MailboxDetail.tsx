// 邮箱详情右侧抽屉(架构 v2:邮箱能力集中,交互对齐 GPT 详情抽屉)。点邮箱名/详情拉出:
//   - 操作日志(登录/改密/收信,读独立 mailbox_logs 表,与 GPT 注册日志隔离;SSE mbLog 实时追加)
//   - 收件箱(登录 mail.com 拉列表 + 按需展开正文),覆盖 free/gpt/claude 所有邮箱
import {useEffect, useState} from "react";
import {api, connectStream, type Mailbox} from "./api";

// 把正文里的 http(s) 链接渲染成可点击 <a>(新标签打开),其余原样。让邮件里的链接可见可点。
function linkify(text: string) {
    return String(text).split(/(https?:\/\/[^\s()<>"']+)/g).map((p, i) =>
        /^https?:\/\//.test(p)
            ? <a key={i} href={p} target="_blank" rel="noreferrer" className="text-indigo-500 underline break-all">{p}</a>
            : <span key={i}>{p}</span>);
}

export function MailboxDetail({mailbox, onClose}: {mailbox: Mailbox; onClose: () => void}) {
    const [tab, setTab] = useState<"log" | "inbox">("log");
    const [logs, setLogs] = useState<{ts: number; line: string}[]>([]);
    const [inbox, setInbox] = useState<{email: string; mails: any[]} | null>(null);
    const [loading, setLoading] = useState(false);
    const [err, setErr] = useState("");
    const [expanded, setExpanded] = useState<string | null>(null);
    const [bodies, setBodies] = useState<Record<string, string>>({});
    const [bodyLoading, setBodyLoading] = useState<string | null>(null);
    const [copied, setCopied] = useState(false);
    const copyPw = () => { try { navigator.clipboard?.writeText(mailbox.password); } catch { /* */ } setCopied(true); setTimeout(() => setCopied(false), 1500); };
    const usageLabel = mailbox.usage === "free" ? "独立/未归属" : mailbox.usage.toUpperCase();

    const loadLogs = () => api.mailboxLogs(mailbox.id).then(setLogs).catch(() => {});
    // 载入该邮箱日志 + 订阅 mbLog 实时追加(仅本邮箱)
    useEffect(() => {
        loadLogs();
        const off = connectStream((ev, data) => {
            if (ev === "mbLog" && data?.id === mailbox.id) setLogs((p) => [...p, {ts: data.ts, line: data.line}]);
        });
        return off; /* eslint-disable-next-line */
    }, [mailbox.id]);

    const loadInbox = async () => {
        setLoading(true); setErr(""); setInbox(null); setExpanded(null); setBodies({});
        try { setInbox(await api.mailboxInbox(mailbox.id)); }
        catch (e: any) { setErr(e.message); }
        finally { setLoading(false); }
    };
    // 切到收件箱且未加载 → 自动拉
    useEffect(() => { if (tab === "inbox" && !inbox && !loading) loadInbox(); /* eslint-disable-next-line */ }, [tab]);

    const toggleMail = (mailId: string) => {
        if (expanded === mailId) { setExpanded(null); return; }
        setExpanded(mailId);
        if (bodies[mailId] === undefined) {
            setBodyLoading(mailId);
            api.mailboxMailBody(mailbox.id, mailId)
                .then((r) => setBodies((p) => ({...p, [mailId]: r.body || "(无正文)"})))
                .catch((e: any) => setBodies((p) => ({...p, [mailId]: "加载失败:" + e.message})))
                .finally(() => setBodyLoading(null));
        }
    };

    return (
        <>
            {/* 左侧半透明遮罩,点击关闭 */}
            <div className="fixed inset-0 bg-black/30 z-30" onClick={onClose}/>
            {/* 右侧抽屉 */}
            <div className="fixed top-0 right-0 bottom-0 w-[46%] min-w-[420px] max-w-[720px] bg-white shadow-2xl z-40 flex flex-col">
                <div className="px-5 py-3 border-b flex items-center justify-between shrink-0">
                    <div className="min-w-0">
                        <div className="font-mono text-sm truncate">{mailbox.email}</div>
                    </div>
                    <button onClick={onClose} className="text-gray-400 hover:text-gray-700 text-xl leading-none ml-3 shrink-0">✕</button>
                </div>
                {/* 基本信息 */}
                <div className="px-5 py-3 border-b bg-gray-50 text-xs shrink-0" style={{display: "grid", gridTemplateColumns: "auto 1fr", columnGap: 14, rowGap: 6, alignItems: "center"}}>
                    <span className="text-gray-400">密码</span>
                    <span className="font-mono text-gray-800 flex items-center gap-2 break-all">
                        {mailbox.password || "—"}
                        {mailbox.password && <button onClick={copyPw} className="text-indigo-600 hover:underline shrink-0">{copied ? "✓ 已复制" : "复制"}</button>}
                    </span>
                    <span className="text-gray-400">归属</span>
                    <span className="text-gray-700">{usageLabel}{mailbox.grp ? ` · 分组 ${mailbox.grp}` : ""}</span>
                    <span className="text-gray-400">改密状态</span>
                    <span className={(mailbox.pw_status || "").startsWith("✅") ? "text-emerald-600" : (mailbox.pw_status || "").startsWith("❌") ? "text-red-500" : "text-gray-500"}>{mailbox.pw_status || "未改过"}</span>
                    <span className="text-gray-400">Provider</span>
                    <span className="text-gray-700">{mailbox.provider}{mailbox.created_at ? ` · 创建 ${new Date(mailbox.created_at).toLocaleString()}` : ""}</span>
                </div>
                <div className="px-4 pt-2 flex gap-1 border-b items-center shrink-0">
                    {(["log", "inbox"] as const).map((t) => (
                        <button key={t} onClick={() => setTab(t)} className={`px-3 py-1.5 rounded-t text-xs font-medium ${tab === t ? "bg-gray-900 text-white" : "bg-gray-100 text-gray-500 hover:bg-gray-200"}`}>{t === "log" ? "📋 操作日志" : "📥 收件箱"}</button>
                    ))}
                    <button onClick={tab === "log" ? loadLogs : loadInbox} disabled={loading} className={`ml-auto text-xs ${loading ? "text-gray-300" : "text-indigo-600 hover:underline"}`}>{loading ? "刷新中…" : "🔄 刷新"}</button>
                </div>
                <div className="flex-1 overflow-auto min-h-0">
                    {tab === "log" ? (
                        <div className="px-3 py-2 font-mono text-xs leading-relaxed bg-gray-900 text-gray-100 min-h-full">
                            {logs.length === 0
                                ? <div className="text-gray-500">（暂无该邮箱操作日志。登录/改密/收信操作会实时记录在此,与 GPT 注册日志分开）</div>
                                : logs.map((l, i) => (
                                    <div key={i} className="whitespace-pre-wrap break-all">
                                        <span className="text-gray-600">{new Date(l.ts).toLocaleTimeString()} </span>
                                        <span className={l.line.includes("✅") ? "text-green-400" : l.line.includes("❌") ? "text-red-400" : ""}>{l.line}</span>
                                    </div>
                                ))}
                        </div>
                    ) : (
                        <div className="p-4">
                            {loading && <div className="text-center py-10 text-gray-500">正在登录 mail.com 拉取收件箱…（约 20~30s）</div>}
                            {err && !loading && <div className="text-red-500 text-sm py-4">❌ 登录/收信失败：{err}</div>}
                            {inbox && !loading && inbox.mails.length === 0 && <div className="text-emerald-600 text-center py-10">✓ 登录成功，收件箱为空</div>}
                            {inbox && inbox.mails.map((m: any) => (
                                <div key={m.id} className="border-b py-2 cursor-pointer hover:bg-gray-50 -mx-2 px-2 rounded" onClick={() => toggleMail(m.id)}>
                                    <div className="flex justify-between text-xs text-gray-400 mb-0.5"><span className="truncate max-w-[60%]">{m.from}</span><span>{m.date}</span></div>
                                    <div className="text-sm text-gray-800 flex items-center gap-1"><span className="text-gray-400 text-xs">{expanded === m.id ? "▾" : "▸"}</span>{m.subject || "(无主题)"}</div>
                                    {expanded === m.id && <div className="mt-2 text-xs text-gray-600 whitespace-pre-wrap bg-gray-50 border rounded p-2 max-h-64 overflow-auto leading-relaxed select-text cursor-text" onClick={(e) => e.stopPropagation()}>{bodyLoading === m.id ? "正在加载正文…" : linkify(bodies[m.id] ?? "(点击加载)")}</div>}
                                </div>
                            ))}
                        </div>
                    )}
                </div>
            </div>
        </>
    );
}
