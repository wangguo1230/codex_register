// 邮箱密码校验工具(邮箱域小工具):批量试登录校验密码是否正确,可选「验证通过后改随机20位」。
// 独立·不入库·不影响账号列表。2026-07-04 从 GPT 控制台迁入邮箱管理域(职责归位:邮箱能力属邮箱域)。
// 自包含:自管弹窗开关 + 输入/结果/并发池,仅依赖 api.mailCheck 与可选 notify。
import {useState} from "react";
import {api} from "./api";

type Row = {email: string; status: "pending" | "checking" | "ok" | "fail"; ok?: boolean; reason?: string; changed?: boolean; newPassword?: string};

function parseMailLines(text: string, separator = "----") {
    return text.split("\n").map((l) => l.trim()).filter(Boolean).map((l) => {
        if (l.includes(separator)) {
            const parts = l.split(separator);
            return {email: parts[0].trim(), password: (parts[1] || "").trim(), parts};
        }
        const m = l.match(/^(\S+?)[\s:]+(.+)$/);
        return m ? {email: m[1].trim(), password: m[2].trim(), parts: [m[1].trim(), m[2].trim()]} : {email: l, password: "", parts: [l]};
    }).filter((x) => x.email);
}

export function MailCheckTool({notify, separator = "----"}: {notify?: (m: string) => void; separator?: string}) {
    const [show, setShow] = useState(false);
    const [input, setInput] = useState("");
    const [changePw, setChangePw] = useState(false);
    const [results, setResults] = useState<Row[]>([]);
    const [running, setRunning] = useState(false);
    const toast = (m: string) => notify?.(m);

    async function run() {
        const items = parseMailLines(input, separator);
        if (!items.length) { toast(`请粘贴 邮箱${separator}密码(每行一个)`); return; }
        setRunning(true);
        // 逐个请求 + 前端并发池,实时更新每行进度(pending→checking→ok/fail)
        const rows: Row[] = items.map((it) => ({email: it.email, status: "pending"}));
        setResults([...rows]);
        const CONC = 2; // 后端每个请求都会开 Chrome，前端也顶 2，避免 4 路打满 3100
        let idx = 0;
        const worker = async () => {
            while (idx < items.length) {
                const i = idx; idx += 1;
                rows[i] = {email: items[i].email, status: "checking"};
                setResults([...rows]);
                try {
                    const r = await api.mailCheck([items[i]], changePw);
                    const res: any = r.results[0] || {ok: false, reason: "无结果"};
                    rows[i] = {email: items[i].email, status: res.ok ? "ok" : "fail", ...res};
                } catch (e: any) {
                    rows[i] = {email: items[i].email, status: "fail", ok: false, reason: e.message};
                }
                setResults([...rows]);
            }
        };
        await Promise.all(Array.from({length: Math.min(CONC, items.length)}, () => worker()));
        setRunning(false);
        toast("校验完成");
    }
    // 结果导出:保留原始行格式,只替换密码段(第2段)为新密码
    const exportText = () => {
        const src = parseMailLines(input, separator);
        return results.map((r, i) => {
            if (!r.ok) return null;
            const s = src[i];
            if (!s) return null;
            const newPw = r.newPassword || s.password;
            const parts = [...s.parts];
            parts[1] = newPw;
            return parts.join(separator);
        }).filter(Boolean).join("\n");
    };

    return (
        <>
            <button onClick={() => setShow(true)} title="批量校验邮箱密码是否正确,可勾选验证后改密(弹窗、不占页面)"
                    style={{padding: "5px 12px", borderRadius: 8, fontSize: 13, border: "1px solid #d1d5db", background: "#fff", cursor: "pointer"}}>🧰 校验工具</button>
            {show && (
                <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-30" onClick={() => !running && setShow(false)}>
                    <div className="bg-white rounded-xl w-[600px] max-h-[85vh] flex flex-col shadow-2xl" onClick={(e) => e.stopPropagation()}>
                        <div className="px-5 py-3 border-b flex items-center justify-between">
                            <span className="font-medium">🧰 邮箱密码校验工具 <span className="text-xs text-gray-400 font-normal">独立·不入库·不影响账号列表</span></span>
                            <button onClick={() => !running && setShow(false)} disabled={running} className="text-gray-400 hover:text-gray-700 text-lg leading-none disabled:opacity-40">✕</button>
                        </div>
                        <div className="px-5 py-4 space-y-3 text-sm overflow-auto">
                            <div className="text-xs text-gray-500">粘贴 <span className="font-mono">邮箱----密码</span>(每行一个)试登录校验密码是否正确；勾选改密则对<b>验证通过</b>的邮箱改成随机20位新密码并返回。</div>
                            <textarea value={input} onChange={(e) => setInput(e.target.value)} placeholder={"a@mail.com----pass123\nb@mail.com----pass456"} disabled={running}
                                      className="w-full h-24 px-2 py-1.5 border rounded text-xs font-mono resize-y disabled:bg-gray-50"/>
                            <div className="flex items-center gap-3 flex-wrap">
                                <label className="inline-flex items-center gap-1 cursor-pointer text-amber-700"><input type="checkbox" checked={changePw} onChange={(e) => setChangePw(e.target.checked)} disabled={running}/>验证通过后改密(随机20位,逐个弹浏览器)</label>
                                <button onClick={run} disabled={running} className={`px-4 py-1.5 rounded text-sm font-medium text-white ${running ? "bg-gray-400 cursor-not-allowed" : "bg-cyan-600 hover:bg-cyan-700"}`}>{running ? "运行中…" : "▶ 开始校验"}</button>
                                {results.length > 0 && <span className="text-xs text-gray-500">进度 {results.filter((r) => r.status === "ok" || r.status === "fail").length}/{results.length} · 通过 {results.filter((r) => r.status === "ok").length}</span>}
                            </div>
                            {results.length > 0 && (
                                <>
                                    <div className="max-h-64 overflow-auto border rounded">
                                        <table className="w-full text-xs">
                                            <thead className="bg-gray-100 text-gray-500 sticky top-0"><tr><th className="text-left px-2 py-1 w-8">#</th><th className="text-left px-2 py-1">邮箱</th><th className="text-left px-2 py-1">进度/结果</th><th className="text-left px-2 py-1">新密码</th></tr></thead>
                                            <tbody>
                                                {results.map((r, i) => (
                                                    <tr key={i} className="border-t">
                                                        <td className="px-2 py-1 text-gray-400">{i + 1}</td>
                                                        <td className="px-2 py-1 font-mono">{r.email}</td>
                                                        <td className="px-2 py-1">
                                                            {r.status === "pending" ? <span className="text-gray-400">⏳ 等待</span>
                                                                : r.status === "checking" ? <span className="text-blue-500">🔄 验证中…</span>
                                                                    : r.status === "ok" ? <span className="text-green-600">✅ {r.changed ? "已改密" : "密码正确"}</span>
                                                                        : <span className="text-red-500" title={r.reason}>❌ {(r.reason || "失败").slice(0, 28)}</span>}
                                                        </td>
                                                        <td className="px-2 py-1 font-mono select-text cursor-text">{r.newPassword || "—"}</td>
                                                    </tr>
                                                ))}
                                            </tbody>
                                        </table>
                                    </div>
                                    <div>
                                        <div className="text-xs text-gray-500 mb-1">通过项(邮箱----密码,点击全选复制):</div>
                                        <textarea readOnly value={exportText()} onClick={(e) => (e.target as HTMLTextAreaElement).select()} className="w-full h-20 px-2 py-1 border rounded text-xs font-mono bg-gray-50 select-text"/>
                                    </div>
                                </>
                            )}
                        </div>
                    </div>
                </div>
            )}
        </>
    );
}
