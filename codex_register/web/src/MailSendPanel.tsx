import {useEffect, useMemo, useState} from "react";
import {api, type Mailbox, type MailSendLog} from "./api";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_VISIBLE_SENDERS = 300;

function parseRecipients(value: string) {
    return [...new Set(
        String(value || "")
            .split(/[\s,;，；]+/)
            .map((item) => item.trim().toLowerCase())
            .filter((item) => EMAIL_RE.test(item)),
    )];
}

function mailboxProvider(mailbox: Mailbox) {
    if (mailbox.provider === "google" || /@(gmail|googlemail)\.com$/i.test(mailbox.email)) return "Gmail";
    if (mailbox.provider === "mailcom" || /@mail\.com$/i.test(mailbox.email)) return "mail.com";
    return "";
}

function canSend(mailbox: Mailbox) {
    const provider = mailboxProvider(mailbox);
    if (provider === "Gmail") return !!String(mailbox.imap_password || "").trim();
    if (provider === "mail.com") return !!String(mailbox.password || "").trim();
    return false;
}

function fmtTime(value?: number) {
    if (!value) return "-";
    return new Date(Number(value)).toLocaleString("zh-CN", {hour12: false});
}

function usageLabel(value?: string) {
    return ({free: "待分配", hold: "独立", gpt: "GPT", claude: "Claude"} as Record<string, string>)[String(value || "")] || value || "-";
}

export function MailSendPanel({notify}: {notify?: (message: string, ms?: number) => void}) {
    const [mailboxes, setMailboxes] = useState<Mailbox[]>([]);
    const [senderId, setSenderId] = useState<number | null>(null);
    const [senderSearch, setSenderSearch] = useState("");
    const [recipientsText, setRecipientsText] = useState("");
    const [subject, setSubject] = useState("");
    const [body, setBody] = useState("");
    const [fromName, setFromName] = useState("");
    const [logs, setLogs] = useState<MailSendLog[]>([]);
    const [busy, setBusy] = useState(false);
    const [loading, setLoading] = useState(true);
    const [logsLoading, setLogsLoading] = useState(false);
    const [result, setResult] = useState<{ok: boolean; message: string} | null>(null);

    const senders = useMemo(() => mailboxes.filter((mailbox) =>
        mailbox.usage !== "deleted" && !mailbox.deleted_at && !!mailboxProvider(mailbox),
    ), [mailboxes]);
    const sender = useMemo(() => senders.find((mailbox) => mailbox.id === senderId) || null, [senders, senderId]);
    const recipients = useMemo(() => parseRecipients(recipientsText), [recipientsText]);
    const filteredSenders = useMemo(() => {
        const key = senderSearch.trim().toLowerCase();
        const list = key
            ? senders.filter((mailbox) => `${mailbox.email} ${mailbox.grp || ""} ${mailbox.usage || ""}`.toLowerCase().includes(key))
            : senders;
        return list.slice(0, MAX_VISIBLE_SENDERS);
    }, [senders, senderSearch]);

    const loadLogs = async (email = sender?.email || "") => {
        setLogsLoading(true);
        try {
            const response = await api.mailSendLogs(email || undefined, 100);
            setLogs(response.items || []);
        } catch (error: any) {
            notify?.(`发送记录读取失败: ${error.message}`);
        } finally {
            setLogsLoading(false);
        }
    };

    useEffect(() => {
        let active = true;
        Promise.all([api.listMailboxes(), api.mailSendLogs(undefined, 100)])
            .then(([mailboxResponse, logResponse]) => {
                if (!active) return;
                setMailboxes(mailboxResponse.list || []);
                setLogs(logResponse.items || []);
            })
            .catch((error: any) => notify?.(`邮件发送初始化失败: ${error.message}`, 5000))
            .finally(() => { if (active) setLoading(false); });
        return () => { active = false; };
    }, []);

    const selectSender = (mailbox: Mailbox) => {
        setSenderId(mailbox.id);
        setResult(null);
        setFromName(mailbox.email.split("@")[0] || "");
        void loadLogs(mailbox.email);
    };

    const send = async () => {
        if (!sender) return notify?.("请选择发件邮箱");
        if (!canSend(sender)) return notify?.(`${sender.email} 缺少发信凭据`);
        if (!recipients.length) return notify?.("请填写有效收件人");
        if (!subject.trim()) return notify?.("请填写邮件主题");
        if (!body.trim()) return notify?.("请填写邮件正文");
        setBusy(true);
        setResult(null);
        try {
            const response = await api.sendMailbox({
                mailboxId: sender.id,
                to: recipients,
                subject: subject.trim(),
                text: body,
                fromName: fromName.trim(),
            });
            const via = response.via || mailboxProvider(sender);
            const message = `已发送给 ${recipients.length} 个收件人 · ${via}`;
            setResult({ok: true, message});
            notify?.(message, 5000);
            await loadLogs(sender.email);
        } catch (error: any) {
            const message = String(error?.message || error);
            setResult({ok: false, message});
            notify?.(`发送失败: ${message}`, 6000);
            await loadLogs(sender.email);
        } finally {
            setBusy(false);
        }
    };

    return (
        <main className="flex-1 min-h-0 overflow-auto bg-[#f5f6f7] p-4 lg:p-5">
            <div className="mx-auto grid min-h-full max-w-[1680px] grid-cols-1 gap-3 xl:grid-cols-[320px_minmax(480px,1fr)_420px]">
                <section className="flex min-h-[520px] flex-col overflow-hidden rounded-lg border border-gray-200 bg-white">
                    <header className="border-b border-gray-200 px-4 py-3">
                        <div className="flex items-center justify-between gap-3">
                            <h2 className="text-sm font-semibold text-gray-900">发件账号</h2>
                            <span className="text-xs tabular-nums text-gray-400">{senders.filter(canSend).length}/{senders.length}</span>
                        </div>
                        <input
                            value={senderSearch}
                            onChange={(event) => setSenderSearch(event.target.value)}
                            placeholder="搜索邮箱或分组"
                            className="mt-2 h-8 w-full rounded-md border border-gray-200 px-2.5 text-xs outline-none focus:border-gray-500"
                        />
                    </header>
                    <div className="min-h-0 flex-1 overflow-auto">
                        {loading ? (
                            <div className="px-4 py-8 text-center text-xs text-gray-400">加载中</div>
                        ) : filteredSenders.length ? filteredSenders.map((mailbox) => {
                            const selected = mailbox.id === senderId;
                            const ready = canSend(mailbox);
                            return (
                                <button
                                    key={mailbox.id}
                                    type="button"
                                    onClick={() => selectSender(mailbox)}
                                    className={`block w-full border-b border-gray-100 px-4 py-2.5 text-left transition-colors ${selected ? "bg-gray-900 text-white" : "bg-white text-gray-700 hover:bg-gray-50"}`}
                                >
                                    <span className="block truncate font-mono text-xs">{mailbox.email}</span>
                                    <span className={`mt-1 flex items-center gap-2 text-[11px] ${selected ? "text-gray-300" : "text-gray-400"}`}>
                                        <span>{mailboxProvider(mailbox)}</span>
                                        <span>{usageLabel(mailbox.usage)}</span>
                                        {mailbox.grp ? <span className="truncate">{mailbox.grp}</span> : null}
                                        <span className={`ml-auto ${ready ? (selected ? "text-emerald-300" : "text-emerald-600") : (selected ? "text-amber-300" : "text-amber-600")}`}>
                                            {ready ? "可发" : "缺凭据"}
                                        </span>
                                    </span>
                                </button>
                            );
                        }) : (
                            <div className="px-4 py-8 text-center text-xs text-gray-400">没有匹配的发件账号</div>
                        )}
                    </div>
                </section>

                <section className="flex min-h-[520px] flex-col rounded-lg border border-gray-200 bg-white">
                    <header className="flex min-h-[57px] items-center justify-between gap-3 border-b border-gray-200 px-4 py-3">
                        <div className="min-w-0">
                            <h1 className="text-sm font-semibold text-gray-900">邮件编辑</h1>
                            <p className="mt-0.5 truncate font-mono text-[11px] text-gray-400">{sender?.email || "未选择发件账号"}</p>
                        </div>
                        {sender ? <span className="rounded border border-gray-200 px-2 py-1 text-[11px] text-gray-500">{mailboxProvider(sender)}</span> : null}
                    </header>
                    <div className="flex flex-1 flex-col gap-3 p-4">
                        <div className="grid grid-cols-1 gap-3 md:grid-cols-[1fr_180px]">
                            <label className="text-xs font-medium text-gray-600">
                                收件人
                                <textarea
                                    value={recipientsText}
                                    onChange={(event) => setRecipientsText(event.target.value)}
                                    placeholder="name@example.com"
                                    rows={2}
                                    className="mt-1 block w-full resize-none rounded-md border border-gray-200 px-3 py-2 font-mono text-xs leading-5 outline-none focus:border-gray-500"
                                />
                            </label>
                            <label className="text-xs font-medium text-gray-600">
                                发件人名称
                                <input
                                    value={fromName}
                                    onChange={(event) => setFromName(event.target.value)}
                                    className="mt-1 block h-[58px] w-full rounded-md border border-gray-200 px-3 text-sm outline-none focus:border-gray-500"
                                />
                            </label>
                        </div>
                        <label className="text-xs font-medium text-gray-600">
                            主题
                            <input
                                value={subject}
                                onChange={(event) => setSubject(event.target.value)}
                                className="mt-1 block h-9 w-full rounded-md border border-gray-200 px-3 text-sm outline-none focus:border-gray-500"
                            />
                        </label>
                        <label className="flex min-h-[260px] flex-1 flex-col text-xs font-medium text-gray-600">
                            正文
                            <textarea
                                value={body}
                                onChange={(event) => setBody(event.target.value)}
                                className="mt-1 min-h-[240px] flex-1 resize-none rounded-md border border-gray-200 px-3 py-3 text-sm leading-6 outline-none focus:border-gray-500"
                            />
                        </label>
                        <footer className="flex flex-wrap items-center gap-3 border-t border-gray-100 pt-3">
                            <span className="text-xs tabular-nums text-gray-400">收件人 {recipients.length} · 正文 {body.length}</span>
                            {result ? <span className={`text-xs ${result.ok ? "text-emerald-700" : "text-red-600"}`}>{result.message}</span> : null}
                            <button
                                type="button"
                                onClick={() => void send()}
                                disabled={busy || !sender || !recipients.length || !subject.trim() || !body.trim()}
                                className="ml-auto h-9 min-w-[104px] rounded-md bg-emerald-700 px-4 text-sm font-medium text-white hover:bg-emerald-800 disabled:cursor-not-allowed disabled:bg-gray-300"
                            >
                                {busy ? "发送中" : "发送邮件"}
                            </button>
                        </footer>
                    </div>
                </section>

                <section className="flex min-h-[520px] flex-col overflow-hidden rounded-lg border border-gray-200 bg-white">
                    <header className="flex min-h-[57px] items-center justify-between border-b border-gray-200 px-4 py-3">
                        <div>
                            <h2 className="text-sm font-semibold text-gray-900">发送记录</h2>
                            <p className="mt-0.5 text-[11px] text-gray-400">{sender ? sender.email : "全部账号"}</p>
                        </div>
                        <button
                            type="button"
                            title="刷新发送记录"
                            onClick={() => void loadLogs()}
                            disabled={logsLoading}
                            className="h-8 w-8 rounded-md border border-gray-200 text-base text-gray-500 hover:bg-gray-50 disabled:opacity-40"
                        >
                            ↻
                        </button>
                    </header>
                    <div className="min-h-0 flex-1 overflow-auto">
                        {logs.length ? logs.map((log) => (
                            <article key={log.id} className="border-b border-gray-100 px-4 py-3">
                                <div className="flex items-center gap-2">
                                    <span className={`h-2 w-2 rounded-full ${log.status === "sent" ? "bg-emerald-500" : "bg-red-500"}`}/>
                                    <span className="min-w-0 flex-1 truncate font-mono text-xs text-gray-700">{log.email}</span>
                                    <span className="text-[10px] tabular-nums text-gray-400">{fmtTime(log.created_at)}</span>
                                </div>
                                <div className="mt-1.5 truncate text-xs text-gray-500" title={log.to_email}>至 {log.to_email || "-"}</div>
                                <div className="mt-1 truncate text-xs text-gray-600" title={log.subject}>{log.subject || "无主题"}</div>
                                {log.error ? <div className="mt-1.5 line-clamp-2 text-[11px] text-red-600" title={log.error}>{log.error}</div> : null}
                                {log.proxy_session ? <div className="mt-1 font-mono text-[10px] text-gray-400">session {log.proxy_session}</div> : null}
                            </article>
                        )) : (
                            <div className="px-4 py-8 text-center text-xs text-gray-400">暂无发送记录</div>
                        )}
                    </div>
                </section>
            </div>
        </main>
    );
}
