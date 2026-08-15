// 邮箱管理面板(架构 v2:邮箱能力唯一中心)。所有邮箱操作集中于此,GPT/Claude 只做注册。
//   - 查看全部邮箱,按 usage(free/gpt/claude)筛选;free=待分配 hold=独立(永不分配) gpt/claude=已归属
//   - 导入独立邮箱(mail.com 可「导入后自动改密」;Gmail 可「导入后自动整备」);从指定分组的 free 池分配 N 个给 GPT/Claude(★物理隔离)
//   - 单个改密 / 多选批量改密(mail.com 真改,覆盖所有邮箱)/ 删除(仅 free)
//   - 邮箱密码校验工具(改密全归邮箱管理:导入后自动改密/手动/批量,注册流程不越界)
import {useCallback, useEffect, useMemo, useRef, useState} from "react";
import {api, connectStream, type Mailbox, type MailboxJob} from "./api";
import {MailCheckTool} from "./MailCheckTool";
import {MailboxDetail} from "./MailboxDetail";
import {ProxyPoolPanel} from "./ProxyPoolPanel";

/** 列表一次最多挂 DOM 的行数；全量仍在内存里筛，避免 3000+ tr 卡死主线程 */
const LIST_PAGE_SIZE = 150;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const USAGE_LABEL: Record<string, string> = {free: "待分配", hold: "独立", gpt: "GPT", claude: "Claude", deleted: "已删除"};
const USAGE_COLOR: Record<string, string> = {free: "#6b7280", hold: "#7c3aed", gpt: "#10a37f", claude: "#d97757", deleted: "#9ca3af"};

/** 从粘贴文本抽出邮箱：纯地址 / email----pwd / email:pwd / 多行混合。 */
function extractEmails(text: string): string[] {
    const seen = new Set<string>();
    const out: string[] = [];
    const push = (raw: string) => {
        const email = String(raw || "").trim().toLowerCase().replace(/^[<"'\[]+|[>"'\]]+$/g, "");
        if (EMAIL_RE.test(email) && !seen.has(email)) { seen.add(email); out.push(email); }
    };
    for (const raw of String(text || "").split(/\r?\n/)) {
        const line = raw.trim();
        if (!line) continue;
        if (line.includes("----")) push(line.split("----")[0] || "");
        else push(line.split(/[\s,;:|\t]+/)[0] || "");
        for (const m of line.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g) || []) push(m);
    }
    return out;
}
const GOOGLE_STAGE_LABEL: Record<string, string> = {
    imported: "刚导入", login_ok: "能登录", login_fail: "登不上",
    partial: "整备未齐", ready: "已整备", gpt_ok: "已注册 GPT", blocked: "卡住",
};
const GOOGLE_STAGE_SEARCH: Record<string, string> = {
    imported: "刚导入 imported",
    login_ok: "能登录 login_ok",
    login_fail: "登不上 login_fail",
    partial: "整备未齐 未整备 partial",
    ready: "已整备 整备的 整备完 备完 可取件 整备 ready",
    gpt_ok: "已注册 gpt gpt_ok",
    blocked: "卡住 blocked",
};
const GOOGLE_STAGE_KEYWORD: Record<string, string> = {
    整备的: "ready", 已整备: "ready", 整备完: "ready", 备完: "ready", 可取件: "ready", 整备: "ready",
    整备未齐: "partial", 未整备: "partial",
    刚导入: "imported", 能登录: "login_ok", 登不上: "login_fail", 卡住: "blocked",
};
const GOOGLE_STAGE_COLOR: Record<string, string> = {
    imported: "#6b7280", login_ok: "#2563eb", login_fail: "#dc2626",
    partial: "#d97706", ready: "#059669", gpt_ok: "#10a37f", blocked: "#b91c1c",
};
const KIND_LABEL: Record<string, string> = {harden: "整备", pw: "改密", "2fa": "2FA", mail: "任务"};
const emptyJob = (): MailboxJob => ({running: false, done: 0, total: 0, ok: 0, fail: 0, queued: 0, rate: 0, current: [], windows: [], byKind: {}, instances: [], hourly: []});

function pad2(n: number) { return String(n).padStart(2, "0"); }
function fmtClock(ts?: number) {
    if (!ts) return "—";
    const d = new Date(ts);
    return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}
function fmtDur(ms?: number) {
    const n = Math.max(0, Math.floor(Number(ms) || 0));
    if (!n) return "—";
    const s = Math.floor(n / 1000);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    if (h) return `${h}小时${m}分`;
    if (m) return `${m}分${pad2(sec)}秒`;
    return `${sec}秒`;
}
function fmtHourLabel(ts: number) {
    const d = new Date(ts);
    return `${pad2(d.getHours())}:00`;
}

function jobTitle(j: MailboxJob) {
    const live = Object.entries(j.byKind || {}).filter(([, v]) => (v.pending + v.running) > 0).map(([k]) => KIND_LABEL[k] || k);
    if (live.length) return live.join(" / ");
    const any = Object.entries(j.byKind || {}).filter(([, v]) => (v.done + v.error) > 0).map(([k]) => KIND_LABEL[k] || k);
    return any.length ? any.join(" / ") : (KIND_LABEL[j.kind || ""] || "任务");
}

function rememberLastJob(data: Partial<MailboxJob> | undefined) {
    if (!data || !data.total) return null;
    return {
        kind: jobTitle(data as MailboxJob),
        done: data.done || 0,
        total: data.total || 0,
        ok: data.ok || 0,
        fail: Math.max(0, data.fail ?? ((data.done || 0) - (data.ok || 0))),
        rate: data.rate ?? (data.done ? Math.round((data.ok || 0) / data.done * 100) : 0),
        stopped: !!data.stopped,
        startedAt: data.startedAt || 0,
        endedAt: data.endedAt || 0,
        elapsedMs: data.elapsedMs || 0,
        avgMs: data.avgMs || 0,
        hourly: data.hourly || [],
    };
}

function mergeJob(prev: MailboxJob, next: Partial<MailboxJob> | undefined): MailboxJob {
    const n = {...emptyJob(), ...prev, ...(next || {})};
    const incomingTotal = Number(next?.total || 0);
    const prevTotal = Number(prev.total || 0);
    if (incomingTotal <= 0 && prevTotal > 0) {
        n.done = prev.done;
        n.total = prev.total;
        n.ok = prev.ok;
        n.fail = prev.fail;
        n.queued = prev.queued;
        n.rate = prev.rate;
        n.lastLine = next?.lastLine || prev.lastLine;
    }
    if (Array.isArray(next?.current)) n.current = next.current;
    else if ((prev.current || []).length) n.current = prev.current;
    if (next?.windows) n.windows = next.windows;
    if (next?.instances) n.instances = next.instances;
    if (next?.byKind) n.byKind = next.byKind;
    if (Array.isArray(next?.hourly)) n.hourly = next.hourly;
    if (next?.hourNow) n.hourNow = next.hourNow;
    if (next?.startedAt) n.startedAt = next.startedAt;
    if (next?.endedAt != null) n.endedAt = next.endedAt;
    if (next?.elapsedMs != null) n.elapsedMs = next.elapsedMs;
    if (next?.avgMs != null) n.avgMs = next.avgMs;
    if (next?.etaMs != null) n.etaMs = next.etaMs;
    return n;
}

export function MailboxPanel({notify}: {notify?: (m: string) => void}) {
    const [list, setList] = useState<Mailbox[]>([]);
    const [stats, setStats] = useState({free: 0, hold: 0, gpt: 0, claude: 0, total: 0, deleted: 0});
    const [groups, setGroups] = useState<{grp: string; n: number}[]>([]); // 待分配(free)邮箱的分组分布
    const [usageFilter, setUsageFilter] = useState<"" | "free" | "hold" | "gpt" | "claude" | "deleted">("");
    const [fGrp, setFGrp] = useState(""); // 筛选:分组
    const [fPw, setFPw] = useState<"" | "no" | "yes" | "fail">(""); // 筛选:改密状态(未改/已改/失败)
    const [fGmail, setFGmail] = useState(""); // 筛选:Gmail 管理阶段
    const [fProvider, setFProvider] = useState<"" | "mailcom" | "google" | "icloud">("");
    const [fSold, setFSold] = useState<"" | "yes" | "no">("");
    const [fEmail, setFEmail] = useState(""); // 筛选:邮箱关键词
    const [batchSearch, setBatchSearch] = useState(false);
    const [lastJob, setLastJob] = useState<{kind: string; done: number; total: number; ok: number; fail: number; rate: number; stopped?: boolean; startedAt?: number; endedAt?: number; elapsedMs?: number; avgMs?: number; hourly?: {at: number; done: number; ok: number; fail: number}[]} | null>(null);
    const [nowTick, setNowTick] = useState(Date.now());
    const [importText, setImportText] = useState("");
    const [grp, setGrp] = useState("");
    const [importAutoPw, setImportAutoPw] = useState(false); // 导入后自动改密(mail.com)
    const [importAutoHarden, setImportAutoHarden] = useState(false); // Gmail 导入后立刻整备
    const [importHold, setImportHold] = useState(false); // 导入即独立(进 hold,永不被业务分配)
    const [importProvider, setImportProvider] = useState<"mailcom"|"icloud"|"google">("mailcom");
    const [lookupExtra, setLookupExtra] = useState<Mailbox[]>([]); // 当前筛选列表里没有、lookup 补回来的号(含已删)
    const [mailSep, setMailSep] = useState("----"); // 邮箱----密码 分隔符
    const [moveGrp, setMoveGrp] = useState("");
    const [allocCount, setAllocCount] = useState(1);
    const [allocSrc, setAllocSrc] = useState("__ALL__"); // 分配来源:__ALL__=全池 / "g:<分组名>"=只从该分组(避免误分想保留的)
    const [busy, setBusy] = useState(false);
    const [selected, setSelected] = useState<Set<number>>(new Set()); // 多选(批量改密)
    const [pwConc, setPwConc] = useState(1); // 改密并发
    const [detailMb, setDetailMb] = useState<Mailbox | null>(null); // 详情弹窗(日志+收件箱)
    const [poolSnap, setPoolSnap] = useState({total: 0, slots: 0, leased: 0, free: 0});
    // 默认收起代理池 / 导入分配 / 任务详情，主屏留给列表
    const [showPool, setShowPool] = useState(false);
    const [toolsOpen, setToolsOpen] = useState<null | "import" | "alloc">(null);
    const [jobDetailOpen, setJobDetailOpen] = useState(false);
    const [jumpText, setJumpText] = useState("");
    const [job, setJob] = useState<MailboxJob>(emptyJob());
    const [stopping, setStopping] = useState(false);
    const [listLimit, setListLimit] = useState(LIST_PAGE_SIZE);
    const loadTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const jobRunningRef = useRef(false);
    const toggleTools = (which: "import" | "alloc") => {
        setToolsOpen((cur) => (cur === which ? null : which));
        if (which === "import") setShowPool(false);
    };

    const toast = (m: string) => notify?.(m);
    const load = useCallback((immediate = false) => {
        const run = () => {
            api.listMailboxes(usageFilter || undefined)
                .then((r) => { setList(r.list); setStats(r.stats); setGroups(r.groups || []); })
                .catch(() => {});
        };
        if (immediate) {
            if (loadTimer.current) { clearTimeout(loadTimer.current); loadTimer.current = null; }
            run();
            return;
        }
        // SSE 可能连发 mailboxes：合并成一次拉全表，避免进页后连环 1MB+ 请求
        if (loadTimer.current) clearTimeout(loadTimer.current);
        loadTimer.current = setTimeout(() => { loadTimer.current = null; run(); }, 400);
    }, [usageFilter]);
    useEffect(() => {
        setListLimit(LIST_PAGE_SIZE);
        load(true);
        return () => { if (loadTimer.current) clearTimeout(loadTimer.current); };
    }, [load]);
    useEffect(() => {
        api.state().then((s) => {
            if (s.state.mailSeparator) setMailSep(s.state.mailSeparator);
            if (s.state.pwConcurrency) setPwConc(s.state.pwConcurrency);
            const st = s.state as any;
            const snap = st.mailProxyPoolSnap;
            if (snap) setPoolSnap({total: snap.total || 0, slots: snap.slots || 0, leased: snap.leased || 0, free: snap.free || 0});
            if (typeof st.mailProxyJump === "string") setJumpText(st.mailProxyJump);
            const incoming = st.mailJob || st.batchHarden;
            if (incoming) {
                setJob((p) => mergeJob(p, incoming));
                if (!incoming.running) {
                    const last = rememberLastJob(incoming);
                    if (last) setLastJob(last);
                }
            }
        }).catch(() => {});
        const pullJob = () => api.mailboxJob().then((r) => {
            const incoming = r.job || r.batchHarden;
            if (incoming) {
                setJob((p) => mergeJob(p, incoming));
                jobRunningRef.current = !!incoming.running;
                if (!incoming.running) {
                    const last = rememberLastJob(incoming);
                    if (last) setLastJob((prev) => prev || last);
                }
            }
        }).catch(() => {});
        pullJob();
        // 有任务时 2s；空闲 8s，降低进页后的后台噪音
        const tick = setInterval(() => {
            if (jobRunningRef.current || document.visibilityState === "visible") pullJob();
        }, job.running ? 2000 : 8000);
        return () => clearInterval(tick);
    }, [job.running]);
    useEffect(() => {
        if (!job.running && !(job.current || []).length) return;
        const t = setInterval(() => setNowTick(Date.now()), 1000);
        return () => clearInterval(t);
    }, [job.running, (job.current || []).length]);
    // 实时刷新(邮箱变化/批量改密进度)
    useEffect(() => {
        const off = connectStream((ev, data) => {
            if (ev === "mailboxes") {
                load(false);
                if (data?.proxyPool) setPoolSnap({total: data.proxyPool.total || 0, slots: data.proxyPool.slots || 0, leased: data.proxyPool.leased || 0, free: data.proxyPool.free || 0});
            }
            else if (ev === "batchPw" || ev === "batchHarden") {
                setJob((p) => mergeJob(p, data));
                jobRunningRef.current = !!data?.running;
                if (data?.proxyPool) setPoolSnap({total: data.proxyPool.total || 0, slots: data.proxyPool.slots || 0, leased: data.proxyPool.leased || 0, free: data.proxyPool.free || 0});
                if (!data.running) {
                    const last = rememberLastJob(data);
                    if (last) setLastJob(last);
                    if (!(data.windows || []).some((w: any) => w.status === 1)) load(false);
                }
            }
            else if (ev === "hello" && data?.state) {
                const incoming = data.state.mailJob || data.state.batchHarden;
                if (incoming) setJob((p) => mergeJob(p, incoming));
                if (data.state.mailSeparator) setMailSep(data.state.mailSeparator);
                if (data.state.mailProxyPoolSnap) {
                    const snap = data.state.mailProxyPoolSnap;
                    setPoolSnap({total: snap.total || 0, slots: snap.slots || 0, leased: snap.leased || 0, free: snap.free || 0});
                }
                if (typeof data.state.mailProxyJump === "string") setJumpText(data.state.mailProxyJump);
            }
        });
        return off;
    }, [load]);

    // 当前选中来源的可分配数 + 传给后端的 fromGrp(undefined=全池,字符串含''=该分组)
    const srcFromGrp = allocSrc === "__ALL__" ? undefined : allocSrc.slice(2);
    const srcCount = allocSrc === "__ALL__" ? stats.free : (groups.find((g) => "g:" + g.grp === allocSrc)?.n ?? 0);

    const doImport = async () => {
        if (!importText.trim()) return;
        const pasted = extractEmails(importText);
        setBusy(true);
        try {
            const r = await api.importFreeMailboxes(importText, "", grp, importAutoPw, importHold, importProvider, importProvider === "google" && importAutoHarden);
            const bits = [`新增 ${r.inserted}`, `跳过 ${r.skipped}`];
            if (r.autoChangePw) bits.push(`已启动 ${r.autoChangePw} 个自动改密`);
            if (r.autoHarden) bits.push(`已启动 ${r.autoHarden} 个整备`);
            if (r.hardenError) bits.push(`整备未启动: ${r.hardenError}`);
            toast(`导入${importHold ? "独立" : "待分配"}邮箱: ${bits.join(" / ")}`);
            setImportText("");
            if (pasted.length) {
                setFEmail(pasted.join("\n"));
                setUsageFilter("");
                setFGrp("");
                setFPw("");
                setFGmail("");
            }
            if (r.ids?.length) setSelected(new Set(r.ids));
            load(true);
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
            load(true);
        } catch (e: any) { toast("分配失败:" + e.message); } finally { setBusy(false); }
    };

    const doDelete = async (m: Mailbox) => {
        if (!confirm(`删除邮箱 ${m.email}?`)) return;
        try {
            const r = await api.deleteMailbox(m.id);
            if (!r.ok) toast(r.reason || "删除失败");
            else { toast("已删除"); load(true); }
        } catch (e: any) { toast(e.message); }
    };

    const doChangePw = async (m: Mailbox) => {
        if (!confirm(`对 ${m.email} 执行${m.provider === "google" ? " Google" : " mail.com"} 改密(随机新密码)?`)) return;
        setBusy(true);
        try {
            const r = await api.changeMailboxPasswd(m.id);
            toast(r.queued ? `已入队改密，预定新密码 ${r.newPassword}` : (r.ok ? `改密成功,新密码 ${r.newPassword}` : `改密未确认(新密码 ${r.newPassword} 已记录)`));
            load(true);
        } catch (e: any) { toast(e.message); } finally { setBusy(false); }
    };

    // 切换独立/待分配(仅 free↔hold)
    const doSetUsage = async (m: Mailbox, usage: "free" | "hold") => {
        try { await api.setMailboxUsage(m.id, usage); toast(usage === "hold" ? "已设为独立(不参与业务分配)" : "已放回待分配"); load(true); } catch (e: any) { toast(e.message); }
    };

    const pwState = (m: Mailbox) => { const s = m.pw_status || ""; return s.startsWith("✅") ? "yes" : s.startsWith("❌") ? "fail" : "no"; };
    const extractedEmails = useMemo(() => extractEmails(fEmail), [fEmail]);
    const keywordQs = useMemo(() => {
        if (extractedEmails.length) return [] as string[];
        return fEmail.toLowerCase().split(/[\s,;|]+/).map((s) => s.trim()).filter(Boolean);
    }, [fEmail, extractedEmails]);
    useEffect(() => {
        if (extractedEmails.length && usageFilter) setUsageFilter("");
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [extractedEmails.join("\n")]);
    useEffect(() => {
        if (extractedEmails.length || !keywordQs.length) return;
        const map: Record<string, "" | "free" | "hold" | "gpt" | "claude" | "deleted"> = {
            独立: "hold", hold: "hold", 待分配: "free", 未分配: "free", free: "free",
            gpt: "gpt", claude: "claude", 已删除: "deleted", 已删: "deleted",
        };
        const hit = keywordQs.map((q) => map[q]).find(Boolean);
        if (hit && usageFilter !== hit) setUsageFilter(hit);
        const stageHit = keywordQs.map((q) => GOOGLE_STAGE_KEYWORD[q]).find(Boolean);
        if (stageHit && fGmail !== stageHit) setFGmail(stageHit);
        if (stageHit && fProvider !== "google") setFProvider("google");
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [keywordQs.join(",")]);
    useEffect(() => {
        if (!extractedEmails.length) { setLookupExtra([]); return; }
        const have = new Set(list.map((m) => m.email.toLowerCase()));
        const missing = extractedEmails.filter((e) => !have.has(e));
        if (!missing.length) { setLookupExtra([]); return; }
        let live = true;
        api.lookupMailboxes(missing).then((r) => { if (live) setLookupExtra(r.list || []); }).catch(() => {});
        return () => { live = false; };
    }, [extractedEmails.join("\n"), list]);
    const searchBase = useMemo(() => {
        const byId = new Map(list.map((m) => [m.id, m]));
        for (const m of lookupExtra) if (!byId.has(m.id)) byId.set(m.id, m);
        return [...byId.values()];
    }, [list, lookupExtra]);
    const providerOf = (m: Mailbox): "mailcom" | "google" | "icloud" =>
        m.provider === "google" ? "google" : m.provider === "icloud" ? "icloud" : "mailcom";
    const allGrps = useMemo(
        () => [...new Set(list.map((m) => m.grp || "").filter(Boolean))].sort(),
        [list],
    );
    const filtered = useMemo(() => {
        const usageLabelOf = (m: Mailbox) => m.deleted_at ? "已删除" : (USAGE_LABEL[m.usage] || m.usage);
        const emailSet = extractedEmails.length ? new Set(extractedEmails) : null;
        return searchBase.filter((m) => {
            if (fProvider && providerOf(m) !== fProvider) return false;
            if (fSold === "yes" && !m.sold_at) return false;
            if (fSold === "no" && m.sold_at) return false;
            if (fGrp === "__NONE__") { if (m.grp) return false; } else if (fGrp && (m.grp || "") !== fGrp) return false;
            if (fPw && pwState(m) !== fPw) return false;
            if (fGmail && (m.google_stage || "") !== fGmail) return false;
            if (emailSet) return emailSet.has(m.email.toLowerCase());
            if (keywordQs.length) {
                const hay = [
                    m.email,
                    usageLabelOf(m),
                    m.usage,
                    m.usage === "hold" ? "独立" : "",
                    m.usage === "free" ? "待分配 未分配" : "",
                    providerOf(m) === "google" ? "gmail google" : providerOf(m) === "icloud" ? "icloud" : "mail.com mailcom",
                    m.sold_at ? "已售 售出 sold" : "未售",
                    m.grp || "",
                    m.google_stage || "",
                    GOOGLE_STAGE_LABEL[m.google_stage || ""] || "",
                    GOOGLE_STAGE_SEARCH[m.google_stage || ""] || "",
                    m.imap_password ? "imap 有imap" : "",
                ].join(" ").toLowerCase();
                if (!keywordQs.some((q) => hay.includes(q))) return false;
            }
            return true;
        });
    }, [searchBase, fProvider, fSold, fGrp, fPw, fGmail, extractedEmails, keywordQs]);
    // 筛选条件变时重置「显示更多」分页
    useEffect(() => { setListLimit(LIST_PAGE_SIZE); }, [usageFilter, fGrp, fPw, fGmail, fProvider, fSold, fEmail]);
    const visibleRows = useMemo(() => filtered.slice(0, listLimit), [filtered, listLimit]);
    const typeCounts = useMemo(() => {
        let mailcom = 0, google = 0, icloud = 0;
        for (const m of searchBase) {
            const p = providerOf(m);
            if (p === "google") google++;
            else if (p === "icloud") icloud++;
            else mailcom++;
        }
        return {mailcom, google, icloud};
    }, [searchBase]);
    const searchMissing = useMemo(() => {
        if (!extractedEmails.length) return [] as string[];
        const have = new Set(searchBase.map((m) => m.email.toLowerCase()));
        return extractedEmails.filter((e) => !have.has(e));
    }, [extractedEmails, searchBase]);
    const noPwCount = useMemo(() => list.filter((m) => pwState(m) === "no").length, [list]);
    /** 整备下拉的数字跟当前分组/类型/售出走，不要用全库 Gmail 数。 */
    const gmailInView = useMemo(() => searchBase.filter((m) => {
        if (providerOf(m) !== "google") return false;
        if (fSold === "yes" && !m.sold_at) return false;
        if (fSold === "no" && m.sold_at) return false;
        if (fGrp === "__NONE__") { if (m.grp) return false; }
        else if (fGrp && (m.grp || "") !== fGrp) return false;
        return true;
    }), [searchBase, fSold, fGrp]);
    const gmailStageCounts = useMemo(() => {
        const c: Record<string, number> = {};
        for (const m of gmailInView) {
            const k = m.google_stage || "imported";
            c[k] = (c[k] || 0) + 1;
        }
        return c;
    }, [gmailInView]);
    const totpCell = (m: Mailbox) => {
        if (m.google_state?.totp_rotated) return {text: "已换", color: "#059669", title: "2FA 已换成我们的密钥"};
        if (m.totp_secret) return {text: "卖家", color: "#d97706", title: "库里有密钥，但还不是我们换过的"};
        return {text: "—", color: "#d1d5db", title: "没有 2FA 密钥"};
    };

    // ---- 多选 + 批量改密/批量切换状态(基于筛选后列表) ----
    const toggleSel = (id: number) => setSelected((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
    const filteredIdSet = useMemo(() => new Set(filtered.map((m) => m.id)), [filtered]);
    const allFilteredSelected = filtered.length > 0 && filtered.every((m) => selected.has(m.id));
    const allSelected = allFilteredSelected;
    const toggleAll = () => setSelected(allFilteredSelected ? new Set() : new Set(filtered.map((m) => m.id)));
    const selCount = useMemo(() => {
        let n = 0;
        for (const id of selected) if (filteredIdSet.has(id)) n++;
        return n;
    }, [selected, filteredIdSet]);
    const openWins = (job.windows || []).filter((w) => w.status === 1);
    const leftoverWins = (job.windows || []).filter((w) => w.status !== 1);
    const jobBusy = !!(job.running || openWins.length);
    const runningEmails = new Map((job.current || []).map((c) => [c.email.toLowerCase(), KIND_LABEL[c.kind || ""] || "执行中"]));
    const jobKind = jobTitle(job);
    const runN = (job.current || []).length || job.runningCount || openWins.length;
    const jobDone = job.done || 0;
    const jobTotal = job.total || 0;
    const jobOk = job.ok || 0;
    const jobFail = Math.max(0, job.fail ?? (jobDone - jobOk));
    const jobQueued = Math.max(0, job.queued ?? (jobTotal - jobDone - runN));
    const jobRate = job.rate ?? (jobDone ? Math.round(jobOk / jobDone * 100) : 0);
    const jobPct = jobTotal ? Math.min(100, Math.round(((jobDone + (job.running ? runN : 0)) / jobTotal) * 100)) : 0;
    const kindStats = Object.entries(job.byKind || {}).filter(([, v]) => (v.pending + v.running + v.done + v.error) > 0);
    const farm = job.instances || [];

    const doBatchChange = async () => {
        const ids = [...selected].filter((id) => filtered.some((m) => m.id === id));
        if (!ids.length) { toast("请先勾选邮箱"); return; }
        if (!confirm(`对选中 ${ids.length} 个邮箱执行 mail.com 改密(随机20位,headed 串行、逐个弹浏览器,可随时停止)?`)) return;
        try {
            const r = await api.batchChangeMailboxPasswd(ids);
            toast(r.count ? `已入队改密 ${r.count} 个，空闲代理会认领` : (r.msg || "无可改邮箱"));
        } catch (e: any) { toast(e.message); }
    };
    const doBatchHarden = async () => {
        const ids = [...selected].filter((id) => filtered.some((m) => m.id === id && m.provider === "google"));
        if (!ids.length) { toast("请先勾选 Gmail"); return; }
        if (!confirm(`完全整备选中 ${ids.length} 个 Gmail？\n会做完全部步骤：清手机/辅助邮箱、换成我们的 2FA、开通 IMAP、改密、踢设备。\n「继续未完成」只补 2FA+IMAP；要六项都跑请用这一颗。`)) return;
        try {
            const r = await api.batchHardenMailboxGoogle(ids);
            toast(`已入队 ${r.count} 个${r.skipped ? `（跳过 ${r.skipped} 个已在跑/排队）` : ""} · 本机空位 ${r.concurrency} · 代理 ${r.proxies}，有空闲就认领`);
        } catch (e: any) { toast(e.message); }
    };
    const stopMailboxJob = async () => {
        setStopping(true);
        try {
            const r = await api.stopBatchHardenMailboxGoogle();
            toast(r.closed ? `已停止，关掉 ${r.closed} 个指纹窗` : "已请求停止");
        } catch (e: any) { toast(e.message); }
        finally { setStopping(false); }
    };
    const resumeMailboxJob = async (onlyFailed = false) => {
        try {
            let ids: number[] | undefined;
            let scope = "";
            if (onlyFailed) {
                ids = selCount > 0 ? [...selected].filter((id) => filtered.some((m) => m.id === id)) : undefined;
                scope = selCount > 0 ? `已选 ${ids.length} 个里、任务条这批失败且还缺 2FA/IMAP 的` : "任务条上这批失败（和失败数同一批）";
            } else if (selCount > 0) {
                ids = [...selected].filter((id) => filtered.some((m) => m.id === id));
                scope = `已选 ${ids.length} 个里还缺 2FA/IMAP 的`;
            } else if (fGrp) {
                ids = searchBase.filter((m) => m.provider === "google" && (fGrp === "__NONE__" ? !m.grp : (m.grp || "") === fGrp)).map((m) => m.id);
                scope = `分组「${fGrp}」里还缺 2FA/IMAP 的`;
            } else {
                ids = undefined;
                scope = "只续最近失败/已取消的任务，不会把全库刚导入都拉进来";
            }
            const verb = onlyFailed ? "重试失败" : "继续未完成";
            if (!confirm(`${verb}：${scope}？`)) return;
            const r = onlyFailed ? await api.retryFailedMailboxJobs(ids) : await api.resumeHardenMailboxGoogle(ids);
            toast(r.count
                ? `已${verb} ${r.count} 个${r.skippedDone ? `（${r.skippedDone} 个已齐跳过）` : ""}`
                : (r.msg || `没有可${verb}的`));
        } catch (e: any) { toast(e.message); }
    };
    const doBatchUsage = async (usage: "free" | "hold") => {
        const ids = [...selected].filter((id) => filtered.some((m) => m.id === id));
        if (!ids.length) { toast("请先勾选邮箱"); return; }
        try { const r = await api.setMailboxesUsage(ids, usage); toast(`已${usage === "hold" ? "设为独立" : "放回待分配"} ${r.count} 个(gpt/claude 已跳过)`); setSelected(new Set()); load(true); } catch (e: any) { toast(e.message); }
    };
    const doBatchGrp = async () => {
        const ids = [...selected].filter((id) => filtered.some((m) => m.id === id && (m.usage === "free" || m.usage === "hold")));
        if (!ids.length) { toast("请先勾选独立或待分配邮箱"); return; }
        const name = moveGrp.trim();
        if (!confirm(`把选中 ${ids.length} 个邮箱改到分组「${name || "（空）"}」？\n已归属 GPT/Claude 的不会改。`)) return;
        try {
            const r = await api.setMailboxesGrp(ids, name);
            toast(`已改分组 ${r.count} 个 → ${name || "（空）"}`);
            load(true);
        } catch (e: any) { toast(e.message); }
    };
    const doBatchAllocGpt = async () => {
        const rows = filtered.filter((m) => selected.has(m.id) && (m.usage === "free" || m.usage === "hold") && !m.sold_at);
        if (!rows.length) { toast("请先勾选未售的独立/待分配邮箱"); return; }
        const gmailReady = (m: Mailbox) => m.provider !== "google" || (m.google_stage === "ready" && !!String(m.imap_password || "").trim());
        const notReady = rows.filter((m) => !gmailReady(m));
        const ok = rows.filter(gmailReady);
        if (!ok.length) { toast("选中的 Gmail 都还没整备完（要阶段=已整备且已开 IMAP）"); return; }
        const d = new Date();
        const suggested = moveGrp.trim() || `${d.getMonth() + 1}月${d.getDate()}已整备GPT`;
        const typed = window.prompt(
            `给这 ${ok.length} 个号起个 GPT 分组名（可新建）${notReady.length ? `；另有 ${notReady.length} 个未整备会跳过` : ""}`,
            suggested,
        );
        if (typed == null) return;
        const batch = typed.trim();
        if (!batch) { toast("分组名不能为空"); return; }
        setMoveGrp(batch);
        if (!confirm(`把 ${ok.length} 个已整备邮箱分到「${batch}」并分配进 GPT 注册队列？`)) return;
        setBusy(true);
        try {
            const r = await api.allocateMailboxIds("gpt", ok.map((m) => m.id), batch);
            const skip = [r.skippedHarden && `未整备 ${r.skippedHarden}`, r.skippedImap && `无IMAP ${r.skippedImap}`, r.skippedSold && `已售 ${r.skippedSold}`, r.skippedBusy && `已挂GPT ${r.skippedBusy}`, r.skipped && `其它 ${r.skipped}`].filter(Boolean).join("，");
            toast(`已分配 ${r.allocated ?? 0} 个进 GPT${skip ? `（跳过 ${skip}）` : ""}。到 GPT 页点「开始」注册`);
            setSelected(new Set());
            load(true);
        } catch (e: any) { toast(e.message); }
        finally { setBusy(false); }
    };
    const copyCreds = async (rows: Mailbox[]) => {
        if (!rows.length) { toast("没有可复制的邮箱"); return; }
        const text = rows.map((m) => [m.email, m.password || "", m.totp_secret || "", m.recovery_email || ""].join(mailSep)).join("\n");
        try { await navigator.clipboard.writeText(text); toast(`已复制 ${rows.length} 条账密`); }
        catch { toast("复制失败,请手动选中"); }
    };
    const doCopySel = () => {
        const rows = filtered.filter((m) => selected.has(m.id));
        copyCreds(rows.length ? rows : filtered);
    };
    const doBatchDelete = async () => {
        const ids = [...selected].filter((id) => filtered.some((m) => m.id === id));
        if (!ids.length) { toast("请先勾选邮箱"); return; }
        if (!confirm(`删除选中 ${ids.length} 个邮箱?被 gpt/claude 占用的会跳过(应从对应业务域删)。`)) return;
        try { const r = await api.batchDeleteMailbox(ids); toast(`已删除 ${r.count} 个${r.skipped ? `(占用跳过 ${r.skipped})` : ""}`); setSelected(new Set()); load(true); } catch (e: any) { toast(e.message); }
    };


    const chip = (v: "" | "free" | "hold" | "gpt" | "claude" | "deleted", label: string, n: number) => (
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
    const sel = {height: 32, padding: "0 8px", border: "1px solid #e5e7eb", borderRadius: 8, fontSize: 12, background: "#fff", color: "#374151"};
    const typeChip = (v: "" | "mailcom" | "google" | "icloud", label: string, n: number) => (
        <button key={v || "all"} onClick={() => { setFProvider(v); if (v !== "google" && v !== "") setFGmail(""); }}
                style={{
                    height: 32, padding: "0 10px", borderRadius: 8, fontSize: 12, cursor: "pointer",
                    border: fProvider === v ? "1px solid #111827" : "1px solid #e5e7eb",
                    background: fProvider === v ? "#111827" : "#fff",
                    color: fProvider === v ? "#fff" : "#4b5563", fontWeight: fProvider === v ? 600 : 400,
                }}>{label} {n}</button>
    );
    return (
        <div style={{
            padding: 18, display: "flex", flexDirection: "column", gap: 12,
            flex: 1, minHeight: 0, height: "100%", boxSizing: "border-box",
            background: "#f6f7f9", overflow: "hidden",
        }}>
            <datalist id="mb-grp-options">
                {groups.filter((g) => g.grp).map((g) => <option key={g.grp} value={g.grp}>{g.grp}({g.n})</option>)}
            </datalist>
            {/* 头部:标题 + 统计chips + 右侧策略/工具 */}
            <div style={{display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", flexShrink: 0}}>
                <b style={{fontSize: 15, marginRight: 4}}>📮 邮箱资源池</b>
                {chip("", "全部", stats.total)}
                {chip("free", "待分配", stats.free)}
                {chip("hold", "独立", stats.hold)}
                {chip("gpt", "GPT", stats.gpt)}
                {chip("claude", "Claude", stats.claude)}
                {chip("deleted", "已删除", stats.deleted)}
                <div style={{marginLeft: "auto", display: "flex", gap: 12, alignItems: "center"}}>
                    <button onClick={() => resumeMailboxJob(false)}
                            style={{padding: "5px 10px", fontSize: 12, border: "1px solid #fdba74", background: "#fff7ed", borderRadius: 8, cursor: "pointer", color: "#c2410c"}}>
                        继续未完成
                    </button>
                    <button onClick={() => resumeMailboxJob(true)}
                            style={{padding: "5px 10px", fontSize: 12, border: "1px solid #fecaca", background: "#fef2f2", borderRadius: 8, cursor: "pointer", color: "#b91c1c"}}>
                        重试失败
                    </button>
                    <button onClick={stopMailboxJob} disabled={stopping || !jobBusy}
                            style={{padding: "5px 10px", fontSize: 12, border: "none", background: jobBusy ? "#dc2626" : "#e5e7eb", color: jobBusy ? "#fff" : "#9ca3af", borderRadius: 8, cursor: jobBusy ? "pointer" : "not-allowed"}}>
                        {stopping ? "停止中" : "停止"}
                    </button>
                    <button onClick={() => setShowPool((v) => !v)}
                            style={{padding: "5px 10px", fontSize: 12, border: "1px solid #d1d5db", borderRadius: 8, background: showPool ? "#eef2ff" : "#fff", cursor: "pointer", color: "#4338ca"}}>
                        代理池 {poolSnap.total || 0}{poolSnap.leased ? ` · 占用${poolSnap.leased}` : ""}{jumpText.trim() ? " · 链式" : ""}
                    </button>
                    <MailCheckTool notify={notify} separator={mailSep}/>
                </div>
            </div>

            {/* 任务：默认一行摘要，详情可展开（不占列表高度） */}
            {jobBusy || leftoverWins.length || lastJob ? (
                <div style={{
                    flexShrink: 0, background: "#fff", border: "1px solid #e8eaed", borderRadius: 12,
                    padding: "8px 12px", boxShadow: "0 1px 2px rgba(15,23,42,0.04)",
                }}>
                    {jobBusy ? (
                        <>
                            <div style={{display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap"}}>
                                <span style={{fontSize: 13, fontWeight: 650, color: "#111827"}}>
                                    {jobKind || "任务"}
                                    {job.stopped ? <span style={{marginLeft: 6, fontSize: 11, color: "#b45309", fontWeight: 500}}>收尾中</span> : null}
                                </span>
                                <span style={{fontSize: 12, color: "#b45309", fontVariantNumeric: "tabular-nums"}}>执行 {runN}</span>
                                <span style={{fontSize: 12, color: "#374151", fontVariantNumeric: "tabular-nums"}}>{jobDone}/{jobTotal || "—"}</span>
                                <span style={{fontSize: 12, color: "#059669"}}>成 {jobOk}</span>
                                <span style={{fontSize: 12, color: jobFail ? "#dc2626" : "#9ca3af"}}>败 {jobFail}</span>
                                <span style={{fontSize: 12, color: "#6b7280"}}>{jobDone ? `${jobRate}%` : "—"}</span>
                                <span style={{fontSize: 12, color: "#4338ca"}}>{fmtDur(job.startedAt ? nowTick - job.startedAt : job.elapsedMs)}</span>
                                {job.etaMs ? <span style={{fontSize: 12, color: "#9a3412"}}>余 {fmtDur(job.etaMs)}</span> : null}
                                <div style={{flex: 1, minWidth: 48, height: 4, background: "#f3f4f6", borderRadius: 99, overflow: "hidden", maxWidth: 160}}>
                                    <div style={{width: `${jobPct}%`, height: "100%", background: "#ea580c", borderRadius: 99}}/>
                                </div>
                                <button type="button" onClick={() => setJobDetailOpen((v) => !v)}
                                        style={{height: 28, padding: "0 10px", fontSize: 12, border: "1px solid #e5e7eb", borderRadius: 8, background: jobDetailOpen ? "#fff7ed" : "#fff", cursor: "pointer", color: "#9a3412"}}>
                                    {jobDetailOpen ? "收起日志" : `日志${(job.current || []).length ? `(${(job.current || []).length})` : ""} ▾`}
                                </button>
                                <button onClick={stopMailboxJob} disabled={stopping}
                                        style={{height: 28, padding: "0 12px", background: stopping ? "#fca5a5" : "#dc2626", color: "#fff", border: "none", borderRadius: 8, cursor: stopping ? "wait" : "pointer", fontWeight: 600, fontSize: 12}}>
                                    {stopping ? "停止中" : "停止"}
                                </button>
                            </div>
                            {jobDetailOpen && (
                                <div style={{marginTop: 8, maxHeight: "22vh", overflow: "auto", borderTop: "1px solid #f3f4f6", paddingTop: 8}}>
                                    <div style={{display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 6}}>
                                        {kindStats.map(([k, v]) => (
                                            <span key={k} style={{fontSize: 11, color: "#4b5563", background: "#f3f4f6", borderRadius: 999, padding: "2px 8px"}}>
                                                {KIND_LABEL[k] || k} 跑{v.running} 排{v.pending} 成{v.ok} 败{v.error}
                                            </span>
                                        ))}
                                        <span style={{fontSize: 11, color: "#4338ca"}}>代理 空闲{poolSnap.free}/占{poolSnap.leased}</span>
                                    </div>
                                    {(job.current || []).map((c) => (
                                        <div key={`${c.kind || "job"}-${c.id}`} style={{fontSize: 12, fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", color: "#57534e", marginBottom: 2}}>
                                            <span style={{color: "#9a3412"}}>[{KIND_LABEL[c.kind || ""] || c.kind || "任务"}] {c.email}</span>
                                            <span style={{color: "#4338ca"}}>  {c.claimedAt ? fmtDur(nowTick - c.claimedAt) : (c.elapsedMs ? fmtDur(c.elapsedMs) : "")}</span>
                                            <span style={{color: "#a8a29e"}}>  {c.lastLine || "运行中"}</span>
                                        </div>
                                    ))}
                                    {openWins.length > 0 && !(job.current || []).length && (
                                        <div style={{fontSize: 12, color: "#78716c"}}>外部窗 {openWins.length}：{openWins.map((w) => w.name || w.id.slice(0, 8)).join("  ")}</div>
                                    )}
                                </div>
                            )}
                        </>
                    ) : leftoverWins.length ? (
                        <div style={{display: "flex", alignItems: "center", gap: 12}}>
                            <span style={{fontSize: 13, color: "#475569"}}>残留指纹 {leftoverWins.length}</span>
                            <button onClick={stopMailboxJob} disabled={stopping}
                                    style={{height: 28, padding: "0 12px", background: "#334155", color: "#fff", border: "none", borderRadius: 8, cursor: "pointer", fontSize: 12}}>清理</button>
                        </div>
                    ) : lastJob ? (
                        <div style={{display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap"}}>
                            <span style={{fontSize: 13, color: "#6b7280"}}>上次{lastJob.kind}{lastJob.stopped ? "（已停）" : ""} {lastJob.done}/{lastJob.total} 成{lastJob.ok} 败{lastJob.fail}</span>
                            <button onClick={() => resumeMailboxJob(false)} style={{marginLeft: "auto", height: 28, padding: "0 12px", background: "#ea580c", color: "#fff", border: "none", borderRadius: 8, fontSize: 12, cursor: "pointer"}}>继续</button>
                            <button onClick={() => resumeMailboxJob(true)} style={{height: 28, padding: "0 12px", background: "#dc2626", color: "#fff", border: "none", borderRadius: 8, fontSize: 12, cursor: "pointer"}}>重试失败</button>
                            <button onClick={() => setLastJob(null)} style={{height: 28, padding: "0 10px", border: "1px solid #e5e7eb", borderRadius: 8, background: "#fff", fontSize: 12, color: "#6b7280", cursor: "pointer"}}>关闭</button>
                        </div>
                    ) : null}
                </div>
            ) : null}

            {showPool && (
                <div style={{flexShrink: 0, maxHeight: "28vh", overflow: "auto", minHeight: 0}}>
                    <ProxyPoolPanel
                        notify={toast}
                        kind="mail"
                        title="邮箱代理池"
                        onMeta={(m) => {
                            setPoolSnap({total: m.total, slots: m.slots, leased: m.leased, free: m.free});
                            setJumpText(m.jump);
                        }}
                    />
                </div>
            )}

            {/* 批量操作：有勾选就出现。任务在跑也要能「完全整备」，不能把按钮藏掉。 */}
            {selCount > 0 && (
                <div style={{display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", background: "#fff", border: "1px solid #e8eaed", borderRadius: 12, padding: "8px 12px", flexShrink: 0}}>
                    <span style={{fontSize: 13, color: "#374151"}}>已选 <b>{selCount}</b>{filtered.length ? ` / ${filtered.length}` : ""}</span>
                    <button onClick={doBatchChange} style={{padding: "5px 12px", background: "#f59e0b", color: "#fff", border: "none", borderRadius: 6, cursor: "pointer", fontSize: 12}}>改密</button>
                    <button onClick={doBatchHarden} title="六项都跑：2FA、IMAP、改密、踢设备、清手机、清辅助邮箱"
                            style={{padding: "5px 12px", background: "#b45309", color: "#fff", border: "none", borderRadius: 6, cursor: "pointer", fontSize: 12, fontWeight: 600}}>完全整备</button>
                    <button onClick={() => doBatchUsage("hold")} style={{padding: "5px 12px", background: "#7c3aed", color: "#fff", border: "none", borderRadius: 6, cursor: "pointer", fontSize: 12}}>设独立</button>
                    <button onClick={() => doBatchUsage("free")} style={{padding: "5px 12px", background: "#6b7280", color: "#fff", border: "none", borderRadius: 6, cursor: "pointer", fontSize: 12}}>放回</button>
                    <input value={moveGrp} onChange={(e) => setMoveGrp(e.target.value)} placeholder="新分组" list="mb-grp-options"
                           style={{width: 120, height: 28, padding: "0 8px", border: "1px solid #d1d5db", borderRadius: 6, fontSize: 12}}/>
                    <button onClick={doBatchGrp} style={{padding: "5px 12px", background: "#4f46e5", color: "#fff", border: "none", borderRadius: 6, cursor: "pointer", fontSize: 12}}>改分组</button>
                    <button onClick={doBatchAllocGpt} disabled={busy} style={{padding: "5px 12px", background: "#059669", color: "#fff", border: "none", borderRadius: 6, cursor: "pointer", fontSize: 12}}>→ GPT</button>
                    <button onClick={doCopySel} style={{padding: "5px 12px", background: "#2563eb", color: "#fff", border: "none", borderRadius: 6, cursor: "pointer", fontSize: 12}}>复制账密</button>
                    <button onClick={doBatchDelete} style={{padding: "5px 12px", background: "#dc2626", color: "#fff", border: "none", borderRadius: 6, cursor: "pointer", fontSize: 12}}>删除</button>
                    <button onClick={() => setSelected(new Set())} style={{padding: "5px 10px", fontSize: 12}}>清空选择</button>
                </div>
            )}

            {/* 列表主区：筛选 + 可折叠工具 + 表格 */}
            <div style={{flex: 1, minHeight: 0, display: "flex", flexDirection: "column", gap: 8}}>
                <div style={{display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", flexShrink: 0}}>
                    <button type="button" onClick={() => toggleTools("import")}
                            style={{height: 32, padding: "0 12px", borderRadius: 8, fontSize: 12, cursor: "pointer", border: toolsOpen === "import" ? "1px solid #4f46e5" : "1px solid #e5e7eb", background: toolsOpen === "import" ? "#eef2ff" : "#fff", color: "#4338ca", fontWeight: 600}}>
                        导入{toolsOpen === "import" ? " ▴" : " ▾"}
                    </button>
                    <button type="button" onClick={() => toggleTools("alloc")}
                            style={{height: 32, padding: "0 12px", borderRadius: 8, fontSize: 12, cursor: "pointer", border: toolsOpen === "alloc" ? "1px solid #059669" : "1px solid #e5e7eb", background: toolsOpen === "alloc" ? "#ecfdf5" : "#fff", color: "#047857", fontWeight: 600}}>
                        分配{toolsOpen === "alloc" ? " ▴" : " ▾"}
                    </button>
                    <span style={{width: 1, height: 16, background: "#e5e7eb"}}/>
                    {typeChip("", "全部", searchBase.length)}
                    {typeChip("mailcom", "mail.com", typeCounts.mailcom)}
                    {typeChip("google", "Gmail", typeCounts.google)}
                    {typeChip("icloud", "iCloud", typeCounts.icloud)}
                    <span style={{width: 1, height: 16, background: "#e5e7eb"}}/>
                    <select value={usageFilter} onChange={(e) => setUsageFilter(e.target.value as any)} style={sel} title="按归属筛选">
                        <option value="">归属:全部</option>
                        <option value="free">待分配({stats.free})</option>
                        <option value="hold">独立({stats.hold})</option>
                        <option value="gpt">GPT({stats.gpt})</option>
                        <option value="claude">Claude({stats.claude})</option>
                        <option value="deleted">已删除({stats.deleted})</option>
                    </select>
                    <select value={fSold} onChange={(e) => setFSold(e.target.value as any)} style={sel} title="按是否已售筛选">
                        <option value="">售出:全部</option>
                        <option value="no">未售</option>
                        <option value="yes">已售</option>
                    </select>
                    <select value={fGrp} onChange={(e) => setFGrp(e.target.value)} style={sel}>
                        <option value="">全部分组</option>
                        <option value="__NONE__">未分组</option>
                        {allGrps.map((g) => <option key={g} value={g}>{g}</option>)}
                    </select>
                    <select value={fPw} onChange={(e) => setFPw(e.target.value as any)} style={sel}>
                        <option value="">改密:全部</option>
                        <option value="no">未改密({noPwCount})</option>
                        <option value="yes">已改密</option>
                        <option value="fail">改密失败</option>
                    </select>
                    {fProvider !== "mailcom" && fProvider !== "icloud" && (
                        <select value={fGmail} onChange={(e) => setFGmail(e.target.value)} style={sel}
                                title="已整备=已换成我们的2FA且有IMAP。卖家密钥+IMAP仍算未齐。数字随当前分组变化。">
                            <option value="">整备:全部({gmailInView.length})</option>
                            {Object.entries(GOOGLE_STAGE_LABEL).map(([k, lab]) => (
                                <option key={k} value={k}>{lab}({gmailStageCounts[k] || 0})</option>
                            ))}
                        </select>
                    )}
                    <div style={{flex: "1 1 240px", minWidth: 200, display: "flex", alignItems: "center", gap: 6}}>
                        {!batchSearch ? (
                            <input
                                value={fEmail}
                                onChange={(e) => {
                                    const v = e.target.value;
                                    if (v.includes("\n")) setBatchSearch(true);
                                    setFEmail(v);
                                }}
                                onPaste={(e) => {
                                    const t = e.clipboardData.getData("text");
                                    if (t.includes("\n") || extractEmails(t).length > 1) setBatchSearch(true);
                                }}
                                placeholder="搜邮箱 / 独立 / GPT / 已售 / Gmail"
                                style={{...inp, height: 32, padding: "0 10px", width: "100%", fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", fontSize: 12}}
                            />
                        ) : null}
                        <button onClick={() => setBatchSearch((v) => !v)}
                                style={{height: 32, padding: "0 10px", border: "1px solid #e5e7eb", borderRadius: 8, background: batchSearch ? "#111827" : "#fff", color: batchSearch ? "#fff" : "#4b5563", fontSize: 12, cursor: "pointer", whiteSpace: "nowrap"}}>
                            批量
                        </button>
                    </div>
                    <span style={{fontSize: 12, color: "#9ca3af", whiteSpace: "nowrap"}}>
                        {filtered.length} 条{filtered.length > visibleRows.length ? ` · 显示 ${visibleRows.length}` : ""}{selCount ? ` · 已选 ${selCount}` : ""}
                    </span>
                    {filtered.length > 0 && (
                        <button onClick={() => copyCreds(filtered)}
                                style={{height: 32, padding: "0 10px", fontSize: 12, border: "1px solid #e5e7eb", borderRadius: 8, background: "#fff", cursor: "pointer", color: "#374151"}}>
                            复制账密
                        </button>
                    )}
                    <label style={{fontSize: 12, color: "#6b7280", display: "inline-flex", alignItems: "center", gap: 4, whiteSpace: "nowrap"}}>并发
                        <input type="number" min={1} max={8} value={pwConc} onChange={(e) => setPwConc(Math.max(1, Math.min(8, Number(e.target.value) || 1)))}
                               onBlur={() => api.setPwConcurrency(pwConc).catch(() => {})}
                               style={{width: 40, height: 32, padding: 0, border: "1px solid #e5e7eb", borderRadius: 8, textAlign: "center", fontSize: 12}} />
                    </label>
                </div>
                {batchSearch && (
                    <div>
                        <textarea value={fEmail} onChange={(e) => setFEmail(e.target.value)}
                                  placeholder={"一行一个，可直接粘贴 email----密码----totp----辅助邮箱"}
                                  rows={3}
                                  style={{width: "100%", minHeight: 72, resize: "vertical", padding: "8px 10px", border: "1px solid #e5e7eb", borderRadius: 8, fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", fontSize: 12, lineHeight: 1.45, outline: "none", boxSizing: "border-box"}} />
                    </div>
                )}
                {extractedEmails.length > 0 && (
                    <div style={{fontSize: 12, color: "#6b7280", display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center"}}>
                        <span>查 {extractedEmails.length} · 命中 <b style={{color: "#059669"}}>{filtered.length}</b>
                            {searchMissing.length ? <> · 未找到 <b style={{color: "#dc2626"}}>{searchMissing.length}</b></> : null}
                        </span>
                        <button onClick={() => setSelected(new Set(filtered.map((m) => m.id)))} disabled={!filtered.length}
                                style={{height: 26, padding: "0 8px", fontSize: 12, border: "1px solid #e5e7eb", borderRadius: 6, background: "#fff", cursor: filtered.length ? "pointer" : "not-allowed"}}>选中命中</button>
                        {searchMissing.length > 0 && <button onClick={() => { navigator.clipboard.writeText(searchMissing.join("\n")).then(() => toast(`已复制 ${searchMissing.length} 个未找到`)).catch(() => toast("复制失败")); }}
                                style={{height: 26, padding: "0 8px", fontSize: 12, border: "1px solid #fecaca", borderRadius: 6, background: "#fff", color: "#b91c1c", cursor: "pointer"}}>复制未找到</button>}
                        <button onClick={() => { setFEmail(""); setBatchSearch(false); }} style={{height: 26, padding: "0 8px", fontSize: 12, border: "1px solid #e5e7eb", borderRadius: 6, background: "#fff", cursor: "pointer", color: "#6b7280"}}>清除</button>
                    </div>
                )}

                {/* 导入 / 分配：默认折叠，点筛选行按钮展开；滚列表自动收起 */}
                {toolsOpen && (
                    <div style={{...card, flexShrink: 0, maxHeight: "36vh", overflow: "auto"}}>
                        {toolsOpen === "import" && (
                            <div style={{display: "flex", flexDirection: "column", gap: 10}}>
                                <div style={{display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap"}}>
                                    <span style={{fontSize: 13, fontWeight: 600}}>📥 导入邮箱</span>
                                    <span style={{fontSize: 11, color: "#9ca3af"}}>默认待分配；Gmail 可选独立+整备</span>
                                    <button type="button" onClick={() => setToolsOpen(null)} style={{marginLeft: "auto", border: "none", background: "transparent", color: "#9ca3af", cursor: "pointer", fontSize: 12}}>收起</button>
                                </div>
                                <textarea
                                    value={importText}
                                    onChange={(e) => setImportText(e.target.value)}
                                    disabled={busy}
                                    autoFocus
                                    placeholder={importProvider === "google"
                                        ? `Gmail: email${mailSep}password${mailSep}totp${mailSep}辅助邮箱`
                                        : `每行: email${mailSep}password`}
                                    style={{height: 88, resize: "vertical", padding: 10, fontFamily: "monospace", fontSize: 12, border: "1px solid #e5e7eb", borderRadius: 8, outline: "none"}}
                                />
                                <div style={{display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap"}}>
                                    <input value={grp} onChange={(e) => setGrp(e.target.value)} placeholder="分组/批次" list="mb-grp-options" style={{...inp, flex: "1 1 140px"}} />
                                    <label style={{fontSize: 12, color: "#7c3aed", display: "inline-flex", alignItems: "center", gap: 4, cursor: "pointer"}}>
                                        <input type="checkbox" checked={importHold} onChange={(e) => setImportHold(e.target.checked)} disabled={busy} />独立
                                    </label>
                                    {importProvider === "google" ? (
                                        <label style={{fontSize: 12, color: "#b45309", display: "inline-flex", alignItems: "center", gap: 4, cursor: "pointer"}}>
                                            <input type="checkbox" checked={importAutoHarden} onChange={(e) => setImportAutoHarden(e.target.checked)} disabled={busy} />自动整备
                                        </label>
                                    ) : (
                                        <label style={{fontSize: 12, color: "#b45309", display: "inline-flex", alignItems: "center", gap: 4, cursor: "pointer"}}>
                                            <input type="checkbox" checked={importAutoPw} onChange={(e) => setImportAutoPw(e.target.checked)} disabled={busy} />自动改密
                                        </label>
                                    )}
                                    <select value={importProvider} onChange={(e) => {
                                        const p = e.target.value as "mailcom"|"icloud"|"google";
                                        setImportProvider(p);
                                        if (p === "google") { setImportHold(true); setImportAutoHarden(true); setImportAutoPw(false); }
                                    }} style={{padding: "4px 6px", border: "1px solid #d1d5db", borderRadius: 6, fontSize: 12}}>
                                        <option value="mailcom">mail.com</option>
                                        <option value="icloud">iCloud</option>
                                        <option value="google">Gmail</option>
                                    </select>
                                    <input value={mailSep} onChange={(e) => setMailSep(e.target.value)}
                                           onBlur={() => { if (mailSep.trim()) api.setMailSeparator(mailSep.trim()).catch((err: any) => toast("分隔符:" + err.message)); }}
                                           title="分隔符" style={{width: 48, padding: "4px 6px", border: "1px solid #d1d5db", borderRadius: 6, fontFamily: "monospace", fontSize: 12, textAlign: "center"}} />
                                    <button onClick={async () => { await doImport(); setToolsOpen(null); }} disabled={busy || !importText.trim()}
                                            style={{padding: "7px 18px", background: busy || !importText.trim() ? "#c7cbd1" : "#4f46e5", color: "#fff", border: "none", borderRadius: 8, cursor: busy || !importText.trim() ? "not-allowed" : "pointer", fontWeight: 500, fontSize: 13}}>导入</button>
                                </div>
                            </div>
                        )}
                        {toolsOpen === "alloc" && (
                            <div style={{display: "flex", flexDirection: "column", gap: 10, maxWidth: 420}}>
                                <div style={{display: "flex", alignItems: "center", gap: 8}}>
                                    <span style={{fontSize: 13, fontWeight: 600}}>🎯 分配到业务域</span>
                                    <button type="button" onClick={() => setToolsOpen(null)} style={{marginLeft: "auto", border: "none", background: "transparent", color: "#9ca3af", cursor: "pointer", fontSize: 12}}>收起</button>
                                </div>
                                <div style={{display: "flex", gap: 8, alignItems: "center"}}>
                                    <span style={{fontSize: 12, color: "#6b7280", width: 36}}>来源</span>
                                    <select value={allocSrc} onChange={(e) => setAllocSrc(e.target.value)} style={{...inp, flex: 1}}>
                                        <option value="__ALL__">全部待分配({stats.free})</option>
                                        {groups.map((g) => <option key={g.grp} value={"g:" + g.grp}>{g.grp || "(无分组)"}({g.n})</option>)}
                                    </select>
                                </div>
                                <div style={{display: "flex", gap: 8, alignItems: "center"}}>
                                    <span style={{fontSize: 12, color: "#6b7280", width: 36}}>数量</span>
                                    <input type="number" min={1} max={srcCount || 1} value={allocCount} onChange={(e) => setAllocCount(Math.max(1, Number(e.target.value) || 1))} style={{...inp, width: 84}} />
                                    <span style={{fontSize: 12, color: "#9ca3af"}}>可分 {srcCount}</span>
                                </div>
                                <div style={{display: "flex", gap: 8}}>
                                    <button onClick={async () => { await doAllocate("gpt"); setToolsOpen(null); }} disabled={busy || srcCount === 0}
                                            style={{flex: 1, padding: "7px 10px", background: "#10a37f", color: "#fff", border: "none", borderRadius: 8, cursor: srcCount === 0 ? "not-allowed" : "pointer", opacity: srcCount === 0 ? 0.5 : 1, fontWeight: 500, fontSize: 13}}>→ GPT</button>
                                    <button onClick={async () => { await doAllocate("claude"); setToolsOpen(null); }} disabled={busy || srcCount === 0}
                                            style={{flex: 1, padding: "7px 10px", background: "#d97757", color: "#fff", border: "none", borderRadius: 8, cursor: srcCount === 0 ? "not-allowed" : "pointer", opacity: srcCount === 0 ? 0.5 : 1, fontWeight: 500, fontSize: 13}}>→ Claude</button>
                                </div>
                            </div>
                        )}
                    </div>
                )}

            {/* 邮箱列表：滚动时收起导入/分配，把主视口留给表格 */}
            <div
                onScroll={(e) => {
                    if (toolsOpen && (e.currentTarget.scrollTop > 40)) setToolsOpen(null);
                }}
                style={{flex: 1, minHeight: 0, overflow: "auto", background: "#fff", border: "1px solid #e8eaed", borderRadius: 12, boxShadow: "0 1px 3px rgba(0,0,0,0.04)"}}
            >
                <table style={{width: "100%", borderCollapse: "collapse", fontSize: 13}}>
                    <thead style={{position: "sticky", top: 0, background: "#f9fafb"}}>
                        <tr style={{textAlign: "left", color: "#6b7280"}}>
                            <th style={{padding: "8px 10px", width: 32}}><input type="checkbox" checked={allSelected} onChange={toggleAll} title="全选/取消当前筛选的全部邮箱（不只是这一页）"/></th>
                            <th style={{padding: "8px 10px"}}>邮箱</th>
                            <th style={{padding: "8px 10px"}}>密码</th>
                            <th style={{padding: "8px 10px"}}>类型</th>
                            <th style={{padding: "8px 10px"}}>2FA</th>
                            <th style={{padding: "8px 10px"}}>Gmail 状态</th>
                            <th style={{padding: "8px 10px"}}>归属</th>
                            <th style={{padding: "8px 10px"}}>改密状态</th>
                            <th style={{padding: "8px 10px"}}>分组</th>
                            <th style={{padding: "8px 10px"}}>操作</th>
                        </tr>
                    </thead>
                    <tbody>
                        {visibleRows.map((m) => (
                            <tr key={m.id} style={{borderTop: "1px solid #f3f4f6", background: runningEmails.has(m.email.toLowerCase()) ? "#fff7ed" : selected.has(m.id) ? "#f0fdf9" : undefined}}>
                                <td style={{padding: "6px 10px"}}><input type="checkbox" checked={selected.has(m.id)} onChange={() => toggleSel(m.id)}/></td>
                                <td style={{padding: "6px 10px", fontFamily: "monospace"}}>
                                    {runningEmails.has(m.email.toLowerCase()) ? <span style={{marginRight: 6, padding: "0 6px", borderRadius: 8, fontSize: 11, color: "#9a3412", background: "#ffedd5"}}>{runningEmails.get(m.email.toLowerCase())}中</span> : null}
                                    <span onClick={() => setDetailMb(m)} title="点击查看操作日志 / 收件箱"
                                          style={{cursor: "pointer", color: detailMb?.id === m.id ? "#4f46e5" : "#374151", textDecoration: "underline", textDecorationColor: detailMb?.id === m.id ? "#4f46e5" : "#cbd5e1", textUnderlineOffset: 3}}
                                          onMouseEnter={(e) => { e.currentTarget.style.color = "#4f46e5"; e.currentTarget.style.textDecorationColor = "#4f46e5"; }}
                                          onMouseLeave={(e) => { const on = detailMb?.id === m.id; e.currentTarget.style.color = on ? "#4f46e5" : "#374151"; e.currentTarget.style.textDecorationColor = on ? "#4f46e5" : "#cbd5e1"; }}>{m.email}</span>
                                </td>
                                <td style={{padding: "6px 10px", fontFamily: "monospace", fontSize: 12, color: "#374151", maxWidth: 220}} title={m.password || ""}>
                                    <span className="select-text" style={{wordBreak: "break-all"}}>{m.password || "—"}</span>
                                    {m.password && <button onClick={() => copyCreds([m])} style={{marginLeft: 6, fontSize: 11, color: "#2563eb", background: "none", border: "none", cursor: "pointer"}}>复制</button>}
                                </td>
                                <td style={{padding: "6px 10px", fontSize: 12, color: "#6b7280"}}>{m.provider === "google" ? "Gmail" : m.provider === "icloud" ? "iCloud" : (m.provider || "mail.com")}</td>
                                <td style={{padding: "6px 10px", fontSize: 12}} title={totpCell(m).title}>
                                    {(() => { const t = totpCell(m); return <span style={{color: t.color}}>{t.text}</span>; })()}
                                    {m.provider === "google" && m.imap_password ? <span style={{marginLeft: 6, color: "#2563eb"}}>IMAP</span> : null}
                                    {m.provider === "google" && m.recovery_email ? <span style={{marginLeft: 6, color: "#d97706"}}>有辅助</span> : null}
                                </td>
                                <td style={{padding: "6px 10px"}}>
                                    {m.provider === "google"
                                        ? <span title={[m.google_state?.last_error, m.google_state?.login_error].filter(Boolean).join(" · ")}
                                              style={{padding: "1px 8px", borderRadius: 10, fontSize: 12, color: "#fff", background: GOOGLE_STAGE_COLOR[m.google_stage || ""] || "#9ca3af"}}>
                                            {GOOGLE_STAGE_LABEL[m.google_stage || ""] || "未记录"}
                                          </span>
                                        : <span style={{color: "#d1d5db"}}>—</span>}
                                </td>
                                <td style={{padding: "6px 10px"}}>
                                    <span style={{padding: "1px 8px", borderRadius: 10, fontSize: 12, color: "#fff", background: m.deleted_at ? USAGE_COLOR.deleted : (USAGE_COLOR[m.usage] || "#6b7280")}}>
                                        {m.deleted_at ? "已删除" : (USAGE_LABEL[m.usage] || m.usage)}
                                    </span>
                                    {m.sold_at ? <span style={{marginLeft: 6, padding: "1px 6px", borderRadius: 8, fontSize: 11, color: "#b45309", background: "#fef3c7"}}>已售</span> : null}
                                </td>
                                <td style={{padding: "6px 10px", color: (() => {
                                    const s = m.pw_status || "";
                                    const unfinished = m.provider === "google" && !["ready", "gpt_ok"].includes(m.google_stage || "");
                                    if (s.startsWith("✅改密") && unfinished) return "#d97706";
                                    if (s.startsWith("✅")) return "#10a37f";
                                    if (s.startsWith("❌")) return "#dc2626";
                                    return "#9ca3af";
                                })()}} title={m.provider === "google" && (m.pw_status || "").startsWith("✅改密") && !["ready", "gpt_ok"].includes(m.google_stage || "") ? "改密做过，但 2FA+IMAP 还没齐，不是整单成功" : ""}>
                                    {(m.pw_status || "").startsWith("✅改密") && m.provider === "google" && !["ready", "gpt_ok"].includes(m.google_stage || "")
                                        ? String(m.pw_status).replace(/^✅改密/, "改密已做·未齐")
                                        : (m.pw_status || "—")}
                                </td>
                                <td style={{padding: "6px 10px", color: "#6b7280"}}>{m.grp || "—"}</td>
                                <td style={{padding: "6px 10px", whiteSpace: "nowrap"}}>
                                    {usageFilter === "deleted" || m.deleted_at
                                        ? <span style={{fontSize: 12, color: "#9ca3af"}}>已删除</span>
                                        : <>
                                            <button onClick={() => doChangePw(m)} disabled={busy} style={{marginRight: 6, fontSize: 12}}>改密</button>
                                            {m.provider === "google" && <button onClick={async () => {
                                                if (!confirm(`整备 ${m.email}？将删辅助邮箱/手机、换2FA、改密、登出其它设备并开通 IMAP。进度在上方任务条，可随时停止。`)) return;
                                                try {
                                                    const r = await api.hardenMailboxGoogle(m.id);
                                                    toast(r.queued || r.ok ? `已入队 ${m.email}，空闲代理会认领` : `整备未启动: ${r.error || ""}`);
                                                } catch (e: any) { toast(e.message); }
                                            }} disabled={busy} style={{marginRight: 6, fontSize: 12, color: "#b45309"}}>整备</button>}
                                            {m.provider === "google" && <button onClick={async () => {
                                                if (!confirm(`给 ${m.email} 添加/替换 Google TOTP?`)) return;
                                                try {
                                                    const r = await api.changeMailboxGoogle2fa(m.id);
                                                    toast(r.queued ? "2FA 已入队，空闲代理会认领" : (r.ok ? `2FA 已更新: ${r.totpSecret}` : `2FA 失败: ${r.error || ""}`));
                                                    load(true);
                                                } catch (e: any) { toast(e.message); }
                                            }} disabled={busy} style={{marginRight: 6, fontSize: 12, color: "#059669"}}>换2FA</button>}
                                            {m.usage === "free" && <button onClick={() => doSetUsage(m, "hold")} style={{marginRight: 6, fontSize: 12, color: "#7c3aed"}} title="设为独立:永不被 GPT/Claude 分配">设独立</button>}
                                            {m.usage === "hold" && !m.sold_at && <button onClick={() => doSetUsage(m, "free")} style={{marginRight: 6, fontSize: 12, color: "#4f46e5"}} title="放回待分配:可被业务取用">放回</button>}
                                            {(m.usage === "free" || m.usage === "hold") && !m.sold_at && <button onClick={() => doDelete(m)} style={{fontSize: 12, color: "#dc2626"}}>删除</button>}
                                        </>}
                                </td>
                            </tr>
                        ))}
                        {filtered.length === 0 && (
                            <tr><td colSpan={10} style={{padding: 24, textAlign: "center", color: "#9ca3af"}}>{list.length ? "无匹配筛选的邮箱" : "暂无邮箱。可在上方导入独立邮箱。"}</td></tr>
                        )}
                        {filtered.length > visibleRows.length && (
                            <tr>
                                <td colSpan={10} style={{padding: 16, textAlign: "center"}}>
                                    <button
                                        type="button"
                                        onClick={() => setListLimit((n) => n + LIST_PAGE_SIZE)}
                                        style={{height: 32, padding: "0 16px", borderRadius: 8, border: "1px solid #e5e7eb", background: "#fff", cursor: "pointer", fontSize: 13}}
                                    >
                                        显示更多（已 {visibleRows.length}/{filtered.length}）
                                    </button>
                                    <button
                                        type="button"
                                        onClick={() => setListLimit(filtered.length)}
                                        style={{marginLeft: 8, height: 32, padding: "0 12px", borderRadius: 8, border: "none", background: "transparent", color: "#6b7280", cursor: "pointer", fontSize: 12}}
                                    >
                                        全部展开
                                    </button>
                                </td>
                            </tr>
                        )}
                    </tbody>
                </table>
            </div>
            </div>

            {detailMb && <MailboxDetail mailbox={detailMb} onClose={() => setDetailMb(null)}/>}
        </div>
    );
}
