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
    const [jumpBusy, setJumpBusy] = useState(false);
    const [jumpItems, setJumpItems] = useState<{masked: string; leased: number; cap: number; ok: boolean | null; ip: string; reason: string; node?: string; port?: number; xray?: boolean | null; source?: string; xrayError?: string}[]>([]);

    const toast = (m: string) => notify?.(m);
    const emit = (snap: {total?: number; slots?: number; leased?: number; free?: number}, jump?: string) => {
        const next = {
            total: snap.total || 0,
            slots: snap.slots || 0,
            leased: snap.leased || 0,
            free: snap.free || 0,
        };
        setPoolSnap(next);
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
            const jlines = (isGpt ? st.gptJumpPool : st.mailJumpPool) || st.jumpFleet?.map((f: {vless: string}) => f.vless);
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

    const card = {background: "#fff", border: "1px solid #e8eaed", borderRadius: 12, padding: 16, boxShadow: "0 1px 3px rgba(0,0,0,0.04)", maxWidth: 1180};

    return (
        <div style={card}>
            <div style={{display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap", marginBottom: 8}}>
                <span style={{fontSize: 13, fontWeight: 600, color: "#111827"}}>{title}</span>
                <span style={{fontSize: 11, color: "#9ca3af"}}>{hint || (isGpt
                    ? "GPT 注册专用。跳板可空：空则直连出口代理池，不走邮箱跳板。"
                    : "邮箱整备专用。先贴跳板 vless，再导入出口代理。")}</span>
            </div>
            <div style={{marginBottom: 14, padding: 12, background: "#eef2ff", border: "1px solid #c7d2fe", borderRadius: 10}}>
                <div style={{fontSize: 13, fontWeight: 700, color: "#312e81", marginBottom: 4}}>跳板 vless</div>
                <div style={{fontSize: 11, color: "#4338ca", marginBottom: 8}}>一行一条。vless:// 会自己起 xray（10811 起）；socks5:// / socks:// 直接当跳板，不用起 xray。1 个跳板最多带 2 条出口。不占 10808。</div>
                <textarea value={jumpText} onChange={(e) => setJumpText(e.target.value)}
                          placeholder={"vless://uuid@host:port?security=reality&pbk=…#name\nsocks5://user:pass@host:8001"}
                          style={{width: "100%", height: 96, resize: "vertical", padding: 8, fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", fontSize: 12, border: "1px solid #a5b4fc", borderRadius: 8, outline: "none", boxSizing: "border-box", background: "#fff"}}/>
                <div style={{display: "flex", gap: 8, alignItems: "center", marginTop: 6, flexWrap: "wrap"}}>
                    <button onClick={async () => {
                        setJumpBusy(true);
                        try {
                            const save = isGpt ? api.setGptJumpPool : api.setMailJumpPool;
                            const r = await save(jumpText, true);
                            if (Array.isArray((r as any).lines) && (r as any).lines.length) setJumpText((r as any).lines.join("\n"));
                            setJumpItems(r.items || []);
                            onMeta?.({...poolSnap, jump: (r.items || [])[0]?.url || ""});
                            const ok = (r.items || []).filter((x) => x.ok).length;
                            const xrayOk = (r.items || []).filter((x) => x.xray !== false).length;
                            toast(`已起 xray ${xrayOk}/${r.total}，探活通过 ${ok}，每条最多带 ${r.maxPerJump} 个出口`);
                        } catch (e: any) { toast("保存/起跳板失败: " + e.message); }
                        finally { setJumpBusy(false); }
                    }} disabled={jumpBusy} style={{height: 32, padding: "0 10px", border: "none", background: "#4f46e5", color: "#fff", borderRadius: 8, fontSize: 12, cursor: jumpBusy ? "wait" : "pointer"}}>{jumpBusy ? "在起 xray…" : "保存并起 xray"}</button>
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
                        setJumpText("");
                        try {
                            const save = isGpt ? api.setGptJumpPool : api.setMailJumpPool;
                            await save("", false);
                            setJumpItems([]);
                            toast("已清空跳板池并停掉跳板 xray");
                        } catch (e: any) { toast(e.message); }
                    }} style={{height: 32, padding: "0 10px", border: "none", background: "transparent", fontSize: 12, color: "#9ca3af", cursor: "pointer"}}>清空</button>
                </div>
                {jumpItems.length > 0 && (
                    <div style={{marginTop: 6, display: "flex", flexDirection: "column", gap: 3}}>
                        {jumpItems.map((it, i) => (
                            <div key={i} style={{fontSize: 11, color: it.ok === false || it.xray === false ? "#b45309" : "#374151", fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace"}}>
                                {it.ok === true ? "通" : it.ok === false ? "死" : "?"}
                                {it.xray === false ? " xray没起" : it.port ? ` xray:${it.port}` : ""}
                                {it.node ? ` ${it.node}` : ""} {it.source || it.masked} · {it.leased}/{it.cap}
                                {it.ip ? ` · ${it.ip}` : ""}
                                {it.xrayError || it.reason ? ` · ${it.xrayError || it.reason}` : ""}
                            </div>
                        ))}
                    </div>
                )}
                <div style={{fontSize: 11, color: jumpItems.some((x) => x.xray === false || x.ok === false) ? "#b91c1c" : "#4338ca", marginTop: 8}}>
                    {jumpText.trim()
                        ? "保存后每条 vless 起一个独立 xray（10811 起往上排）。10808 是你自己的，任务不占用。"
                        : (isGpt
                            ? "没贴跳板时注册直连上面的出口代理池。"
                            : "还没贴跳板。把机场/节点的 vless:// 整行复制进来，点「保存并起 xray」。")}
                </div>
            </div>
            <div style={{fontSize: 12, color: "#374151", marginBottom: 4}}>出口代理（kookeey / socks5，一行一个）</div>
            <textarea value={poolText} onChange={(e) => setPoolText(e.target.value)}
                      placeholder={"一行一个，支持：\ngate-hk.kookeey.info:1000:user:pass-US-session-5m\nip:port:user:pass\nsocks5://user:pass@host:port"}
                      style={{width: "100%", height: 140, resize: "vertical", padding: 10, fontFamily: "monospace", fontSize: 12, border: "1px solid #e5e7eb", borderRadius: 8, outline: "none", boxSizing: "border-box"}}/>
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
