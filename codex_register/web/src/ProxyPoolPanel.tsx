import {useEffect, useState} from "react";
import {api, connectStream} from "./api";

export type ProxyPoolMeta = {total: number; slots: number; leased: number; free: number; jump: string};

/** 跳板 + 导入代理池。kind=mail 邮箱管理，kind=gpt GPT 注册，两套配置互不影响。 */
export function ProxyPoolPanel({
    notify,
    title = "代理池",
    kind = "mail",
    hint,
    onMeta,
}: {
    notify?: (m: string) => void;
    title?: string;
    kind?: "mail" | "gpt";
    hint?: string;
    onMeta?: (m: ProxyPoolMeta) => void;
}) {
    const [poolText, setPoolText] = useState("");
    const [poolSnap, setPoolSnap] = useState({total: 0, slots: 0, leased: 0, free: 0});
    const [poolCopies, setPoolCopies] = useState(1);
    const [jumpText, setJumpText] = useState("");
    const [jumpHint, setJumpHint] = useState("");
    const [jumpBusy, setJumpBusy] = useState(false);
    const [vlessText, setVlessText] = useState("");
    const [jumpXray, setJumpXray] = useState<{running?: boolean; port?: number; node?: string; error?: string} | null>(null);
    const [jumpItems, setJumpItems] = useState<{masked: string; leased: number; cap: number; ok: boolean | null; ip: string; reason: string}[]>([]);

    const toast = (m: string) => notify?.(m);
    const emit = (snap: {total?: number; slots?: number; leased?: number; free?: number}, jump?: string) => {
        const next = {
            total: snap.total || 0,
            slots: snap.slots || 0,
            leased: snap.leased || 0,
            free: snap.free || 0,
        };
        setPoolSnap(next);
        if (typeof jump === "string") setJumpText(jump);
        onMeta?.({...next, jump: typeof jump === "string" ? jump : jumpText});
    };

    const isGpt = kind === "gpt";
    useEffect(() => {
        api.state().then((s) => {
            const st = s.state as any;
            const lines = isGpt ? (st.gptProxyPoolLines || st.gptProxyPool) : (st.mailProxyPoolLines || st.mailProxyPool);
            if (Array.isArray(lines)) setPoolText(lines.join("\n"));
            const snap = isGpt ? st.gptProxyPoolSnap : st.mailProxyPoolSnap;
            const jump = isGpt ? st.gptProxyJump : st.mailProxyJump;
            if (snap) emit(snap, typeof jump === "string" ? jump : undefined);
            else if (typeof jump === "string") setJumpText(jump);
            if (st.regProxy) setJumpHint(st.regProxy);
            if (st.jumpXrayVless) setVlessText(st.jumpXrayVless);
            else if (st.claudeXrayVless) setVlessText(st.claudeXrayVless);
            if (st.jumpXray) setJumpXray(st.jumpXray);
            const jlines = isGpt ? st.gptJumpPool : st.mailJumpPool;
            if (Array.isArray(jlines) && jlines.length) setJumpText(jlines.join("\n"));
            const jsnap = isGpt ? st.gptJumpPoolSnap : st.mailJumpPoolSnap;
            if (jsnap?.items) setJumpItems(jsnap.items);
        }).catch(() => {});
        const load = isGpt ? api.gptProxyPool() : api.mailProxyPool();
        load.then((r) => {
            const lines = r.lines || r.urls || [];
            if (lines.length) setPoolText(lines.join("\n"));
            emit(r, r.jump);
        }).catch(() => {});
        const off = connectStream((ev, data) => {
            if (!isGpt && ev === "mailboxes" && data?.proxyPool) emit(data.proxyPool);
            else if (!isGpt && (ev === "batchPw" || ev === "batchHarden") && data?.proxyPool) emit(data.proxyPool);
            else if (ev === "hello" && data?.state) {
                const st = data.state;
                const lines = isGpt ? (st.gptProxyPoolLines || st.gptProxyPool) : (st.mailProxyPoolLines || st.mailProxyPool);
                if (Array.isArray(lines)) setPoolText(lines.join("\n"));
                const snap = isGpt ? st.gptProxyPoolSnap : st.mailProxyPoolSnap;
                const jump = isGpt ? st.gptProxyJump : st.mailProxyJump;
                if (snap) emit(snap, typeof jump === "string" ? jump : undefined);
                else if (typeof jump === "string") setJumpText(jump);
            }
        });
        return off;
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [kind]);

    const applyResult = (r: {lines?: string[]; urls?: string[]; total?: number; slots?: number; leased?: number; free?: number; jump?: string}) => {
        setPoolText((r.lines && r.lines.length ? r.lines : r.urls || []).join("\n"));
        emit(r, r.jump);
    };
    const setPool = isGpt ? api.setGptProxyPool : api.setMailProxyPool;
    const setJump = isGpt ? api.setGptProxyJump : api.setMailProxyJump;
    const testJump = isGpt ? api.testGptProxyJump : api.testMailProxyJump;
    const doSavePool = async () => {
        try {
            const r = await setPool(poolText, {append: false, copies: 1});
            applyResult(r);
            toast(r.total ? `代理池已覆盖保存 ${r.total} 条（一号一 session）` : "代理池已清空，未配池时同时只跑 1 个指纹");
        } catch (e: any) { toast("保存代理池失败: " + e.message); }
    };
    const doImportPool = async () => {
        if (!poolText.trim()) { toast("先粘贴代理，一行一个"); return; }
        try {
            const r = await setPool(poolText, {append: true, copies: poolCopies});
            applyResult(r);
            toast(`导入完成：新增 ${r.inserted ?? 0} / 跳过 ${r.skipped ?? 0} / 池内共 ${r.total} 条`);
        } catch (e: any) { toast("导入代理失败: " + e.message); }
    };

    const inp = {padding: "6px 10px", border: "1px solid #e5e7eb", borderRadius: 8, fontSize: 13, outline: "none", boxSizing: "border-box" as const};
    const card = {background: "#fff", border: "1px solid #e8eaed", borderRadius: 12, padding: 16, boxShadow: "0 1px 3px rgba(0,0,0,0.04)", maxWidth: 1180};

    return (
        <div style={card}>
            <div style={{display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap", marginBottom: 8}}>
                <span style={{fontSize: 13, fontWeight: 600, color: "#111827"}}>{title}</span>
                <span style={{fontSize: 11, color: "#9ca3af"}}>{hint || (isGpt
                    ? "GPT 注册专用。跳板池先探活，1 个跳板最多带 2 条出口。和邮箱池分开。"
                    : "邮箱整备专用。跳板池先探活，1 个跳板最多带 2 条出口。和 GPT 池分开。")}</span>
            </div>
            <textarea value={poolText} onChange={(e) => setPoolText(e.target.value)}
                      placeholder={"一行一个，支持：\ngate-hk.kookeey.info:1000:user:pass-US-session-5m\nip:port:user:pass\nsocks5://user:pass@host:port"}
                      style={{width: "100%", height: 140, resize: "vertical", padding: 10, fontFamily: "monospace", fontSize: 12, border: "1px solid #e5e7eb", borderRadius: 8, outline: "none", boxSizing: "border-box"}}/>
            <div style={{marginTop: 10}}>
                <div style={{fontSize: 12, color: "#374151", marginBottom: 4}}>跳板池（一行一个，1 个跳板最多带 2 条出口，租之前会探活）</div>
                <textarea value={jumpText} onChange={(e) => setJumpText(e.target.value)}
                          placeholder={jumpHint || "socks5://127.0.0.1:10811\nsocks5://127.0.0.1:10812"}
                          style={{width: "100%", height: 72, resize: "vertical", padding: 8, fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", fontSize: 12, border: "1px solid #e5e7eb", borderRadius: 8, outline: "none", boxSizing: "border-box"}}/>
                <div style={{display: "flex", gap: 8, alignItems: "center", marginTop: 6, flexWrap: "wrap"}}>
                    <button onClick={async () => {
                        setJumpBusy(true);
                        try {
                            const save = isGpt ? api.setGptJumpPool : api.setMailJumpPool;
                            const r = await save(jumpText, true);
                            setJumpItems(r.items || []);
                            onMeta?.({...poolSnap, jump: (r.items || [])[0]?.url || ""});
                            const ok = (r.items || []).filter((x) => x.ok).length;
                            toast(`跳板池 ${r.total} 条，探活通过 ${ok}，每条最多带 ${r.maxPerJump} 个出口`);
                        } catch (e: any) { toast("保存/探活跳板失败: " + e.message); }
                        finally { setJumpBusy(false); }
                    }} disabled={jumpBusy} style={{height: 32, padding: "0 10px", border: "none", background: "#4f46e5", color: "#fff", borderRadius: 8, fontSize: 12, cursor: jumpBusy ? "wait" : "pointer"}}>{jumpBusy ? "在测…" : "保存并探活"}</button>
                    <button onClick={async () => {
                        setJumpBusy(true);
                        try {
                            const r = isGpt ? await api.checkGptJumpPool() : await api.checkMailJumpPool();
                            setJumpItems(r.items || []);
                            const ok = (r.items || []).filter((x) => x.ok).length;
                            toast(`探活 ${ok}/${r.total}`);
                        } catch (e: any) { toast(e.message); }
                        finally { setJumpBusy(false); }
                    }} disabled={jumpBusy} style={{height: 32, padding: "0 10px", border: "1px solid #d1d5db", background: "#fff", borderRadius: 8, fontSize: 12, cursor: jumpBusy ? "wait" : "pointer"}}>再测一遍</button>
                    <button onClick={async () => {
                        const next = (jumpText ? jumpText + "\n" : "") + "socks5://127.0.0.1:10808";
                        setJumpText(next);
                    }} style={{height: 32, padding: "0 10px", border: "1px solid #e5e7eb", background: "#fff", borderRadius: 8, fontSize: 12, cursor: "pointer", color: "#6b7280"}}>加入 10808</button>
                    <button onClick={async () => {
                        setJumpText("");
                        try {
                            const save = isGpt ? api.setGptJumpPool : api.setMailJumpPool;
                            await save("", false);
                            setJumpItems([]);
                            toast("已清空跳板池");
                        } catch (e: any) { toast(e.message); }
                    }} style={{height: 32, padding: "0 10px", border: "none", background: "transparent", fontSize: 12, color: "#9ca3af", cursor: "pointer"}}>清空</button>
                </div>
                {jumpItems.length > 0 && (
                    <div style={{marginTop: 6, display: "flex", flexDirection: "column", gap: 3}}>
                        {jumpItems.map((it, i) => (
                            <div key={i} style={{fontSize: 11, color: it.ok === false ? "#b45309" : "#374151", fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace"}}>
                                {it.ok === true ? "通" : it.ok === false ? "死" : "?"} {it.masked} · {it.leased}/{it.cap}{it.ip ? ` · ${it.ip}` : ""}{it.reason ? ` · ${it.reason}` : ""}
                            </div>
                        ))}
                    </div>
                )}
            </div>
            <div style={{display: "flex", gap: 8, alignItems: "center", marginTop: 8, flexWrap: "wrap"}}>
                <span style={{fontSize: 12, color: "#374151", whiteSpace: "nowrap"}}>跳板 vless</span>
                <input value={vlessText} onChange={(e) => setVlessText(e.target.value)}
                       placeholder="vless://…  自己起 xray @10811，不占用你的 10808"
                       style={{flex: "1 1 320px", ...inp, fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace"}}/>
                <button onClick={async () => {
                    if (!vlessText.trim()) { toast("先贴一条 vless"); return; }
                    setJumpBusy(true);
                    try {
                        const r = await api.startJumpXray(vlessText.trim());
                        setJumpXray(r.xray);
                        setJumpText(r.jump);
                        onMeta?.({...poolSnap, jump: r.jump});
                        toast(`跳板 xray 已起 ${r.xray.node || ""} @${r.jump}，10808 还给你`);
                    } catch (e: any) { toast("起跳板 vless 失败: " + e.message); }
                    finally { setJumpBusy(false); }
                }} style={{height: 32, padding: "0 10px", border: "none", background: "#4f46e5", color: "#fff", borderRadius: 8, fontSize: 12, cursor: "pointer"}}>起独立跳板</button>
                {jumpXray?.running && <button onClick={async () => {
                    try {
                        const r = await api.stopJumpXray();
                        setJumpXray(r.xray);
                        toast("已停跳板 xray");
                    } catch (e: any) { toast(e.message); }
                }} style={{height: 32, padding: "0 10px", border: "none", background: "#dc2626", color: "#fff", borderRadius: 8, fontSize: 12, cursor: "pointer"}}>停跳板</button>}
            </div>
            <div style={{fontSize: 11, color: jumpXray?.error ? "#dc2626" : (jumpText.trim() ? "#4338ca" : "#9ca3af"), marginTop: 4}}>
                {jumpXray?.running
                    ? `独立跳板运行中 ${jumpXray.node || ""} @127.0.0.1:${jumpXray.port || 10811}。10808 是你自己的，任务不占用。`
                    : jumpText.trim()
                        ? `链式已开：本机 → ${jumpText.trim()} → 代理池网关。`
                        : "未开跳板：本机直连代理池网关。贴一条 vless 点「起独立跳板」。"}
                {jumpXray?.error ? ` ${jumpXray.error}` : ""}
            </div>
            <div style={{display: "flex", gap: 10, alignItems: "center", marginTop: 8, flexWrap: "wrap"}}>
                <button onClick={doImportPool} style={{padding: "6px 14px", background: "#0d9488", color: "#fff", border: "none", borderRadius: 8, cursor: "pointer", fontSize: 13}}>批量导入追加</button>
                <button onClick={doSavePool} style={{padding: "6px 14px", background: "#4f46e5", color: "#fff", border: "none", borderRadius: 8, cursor: "pointer", fontSize: 13}}>覆盖保存</button>
                <label style={{fontSize: 12, color: "#6b7280", display: "inline-flex", alignItems: "center", gap: 4}} title="同一条 kookeey 账号生成多条不同 session">
                    一条生成
                    <input type="number" min={1} max={200} value={poolCopies} onChange={(e) => setPoolCopies(Math.max(1, Math.min(200, Number(e.target.value) || 1)))}
                           style={{width: 52, padding: "4px 6px", border: "1px solid #d1d5db", borderRadius: 6, textAlign: "center", fontSize: 12}}/>
                    条 session
                </label>
                <span style={{fontSize: 12, color: poolSnap.total ? "#4338ca" : "#b45309"}}>
                    {poolSnap.total ? `已配 ${poolSnap.total} 条 · 空闲 ${poolSnap.free} / 占用 ${poolSnap.leased}` : "未配池：同时只开 1 个指纹"}
                </span>
            </div>
        </div>
    );
}
