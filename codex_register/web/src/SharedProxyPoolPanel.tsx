import {useEffect, useState} from "react";
import {api, connectStream, type SharedProxyPoolSnap} from "./api";

export type SharedProxyPoolMeta = {total: number; slots: number; leased: number; free: number; jump: string};

/** 统一代理池：一份出口、一份跳板；邮箱/GPT 通过范围开关选择是否使用。 */
export function SharedProxyPoolPanel({
    notify,
    title = "统一代理池",
    onMeta,
}: {
    notify?: (message: string) => void;
    title?: string;
    onMeta?: (meta: SharedProxyPoolMeta) => void;
}) {
    const [snapshot, setSnapshot] = useState<SharedProxyPoolSnap | null>(null);
    const [poolText, setPoolText] = useState("");
    const [poolCopies, setPoolCopies] = useState(1);
    const [jumpText, setJumpText] = useState("");
    const [useForMail, setUseForMail] = useState(true);
    const [useForGpt, setUseForGpt] = useState(true);
    const [jumpForMail, setJumpForMail] = useState(true);
    const [jumpForGpt, setJumpForGpt] = useState(true);
    const [jumpBusy, setJumpBusy] = useState(false);

    const toast = (message: string) => notify?.(message);
    const applySnapshot = (next: SharedProxyPoolSnap) => {
        setSnapshot(next);
        setPoolText((next.lines || []).join("\n"));
        setJumpText((next.jump?.lines || []).join("\n"));
        setUseForMail(next.useForMail !== false);
        setUseForGpt(next.useForGpt !== false);
        setJumpForMail(next.jump?.useForMail !== false);
        setJumpForGpt(next.jump?.useForGpt !== false);
        onMeta?.({
            total: next.total || 0,
            slots: next.slots || 0,
            leased: next.leased || 0,
            free: next.free || 0,
            jump: next.jump?.lines?.[0] || "",
        });
    };

    useEffect(() => {
        api.sharedProxyPool().then(applySnapshot).catch(() => {});
        const off = connectStream((event, data) => {
            if (event !== "hello" || !data?.state?.proxyPoolSnap) return;
            const state = data.state;
            applySnapshot({
                ok: true,
                urls: state.proxyPool || [],
                lines: state.proxyPoolLines || state.proxyPool || [],
                ...state.proxyPoolSnap,
                useForMail: state.proxyPoolMailEnabled !== false,
                useForGpt: state.proxyPoolGptEnabled !== false,
                jump: {
                    ...(state.jumpPoolSnap || {total: 0, maxPerJump: 4, items: []}),
                    lines: state.proxyJumpPool || [],
                    useForMail: state.proxyJumpMailEnabled !== false,
                    useForGpt: state.proxyJumpGptEnabled !== false,
                },
            });
        });
        return off;
    }, []);

    const savePool = async (append: boolean) => {
        try {
            const next = await api.setSharedProxyPool(poolText, {append, copies: append ? poolCopies : 1});
            applySnapshot(next);
            toast(append
                ? `导入完成：新增 ${next.inserted ?? 0} / 跳过 ${next.skipped ?? 0} / 共 ${next.total} 条`
                : next.total ? `统一代理池已覆盖保存 ${next.total} 条` : "统一代理池已清空");
        } catch (error: any) { toast(`保存代理池失败：${error.message}`); }
    };

    const togglePoolScope = async (scope: "mail" | "gpt", checked: boolean) => {
        const previous = scope === "mail" ? useForMail : useForGpt;
        if (scope === "mail") setUseForMail(checked); else setUseForGpt(checked);
        try {
            applySnapshot(await api.setSharedProxyScopes(scope === "mail" ? {mail: checked} : {gpt: checked}));
        } catch (error: any) {
            if (scope === "mail") setUseForMail(previous); else setUseForGpt(previous);
            toast(`保存代理池范围失败：${error.message}`);
        }
    };

    const toggleJumpScope = async (scope: "mail" | "gpt", checked: boolean) => {
        const previous = scope === "mail" ? jumpForMail : jumpForGpt;
        if (scope === "mail") setJumpForMail(checked); else setJumpForGpt(checked);
        try {
            applySnapshot(await api.setSharedJumpScopes(scope === "mail" ? {mail: checked} : {gpt: checked}));
        } catch (error: any) {
            if (scope === "mail") setJumpForMail(previous); else setJumpForGpt(previous);
            toast(`保存跳板范围失败：${error.message}`);
        }
    };

    const saveJump = async () => {
        setJumpBusy(true);
        try {
            const next = await api.setSharedJumpPool(jumpText, {check: true});
            applySnapshot(next);
            const ok = next.jump.items.filter((item) => item.ok).length;
            toast(`跳板已保存，探活通过 ${ok}/${next.jump.total}`);
        } catch (error: any) { toast(`保存跳板失败：${error.message}`); }
        finally { setJumpBusy(false); }
    };

    const checkJump = async () => {
        setJumpBusy(true);
        try { applySnapshot(await api.checkSharedJumpPool()); toast("跳板探活完成"); }
        catch (error: any) { toast(`跳板探活失败：${error.message}`); }
        finally { setJumpBusy(false); }
    };

    const clearJump = async () => {
        setJumpBusy(true);
        try { applySnapshot(await api.setSharedJumpPool("")); toast("已清空跳板池并停止独立跳板"); }
        catch (error: any) { toast(`清空跳板失败：${error.message}`); }
        finally { setJumpBusy(false); }
    };

    const pool = snapshot || {total: 0, slots: 0, leased: 0, free: 0};
    const jump = snapshot?.jump || {total: 0, items: [], lines: []};
    const failedJumps = jump.items.filter((item) => item.ok === false || item.xray === false).length;

    return (
        <div className="bg-white border border-gray-200 rounded-xl p-4 shadow-sm max-w-[1180px]">
            <div className="flex items-center gap-3 flex-wrap mb-3">
                <strong className="text-sm text-gray-800">{title}</strong>
                <span className="text-xs text-gray-500">同一代理全局只允许一个租约，避免邮箱和 GPT 互相抢同一出口</span>
                <span className="text-xs text-indigo-700">共 {pool.total || 0} 条 · 空闲 {pool.free || 0} · 占用 {pool.leased || 0}</span>
            </div>
            <div className="flex items-center gap-5 flex-wrap mb-3 text-sm">
                <span className="text-gray-500">代理池使用范围</span>
                <label className="inline-flex items-center gap-1.5 cursor-pointer"><input type="checkbox" checked={useForMail} onChange={(e) => void togglePoolScope("mail", e.target.checked)}/><span>邮箱管理</span></label>
                <label className="inline-flex items-center gap-1.5 cursor-pointer"><input type="checkbox" checked={useForGpt} onChange={(e) => void togglePoolScope("gpt", e.target.checked)}/><span>GPT 管理</span></label>
            </div>
            <textarea value={poolText} onChange={(e) => setPoolText(e.target.value)} placeholder={"出口代理一行一个，支持：\ngate-hk.kookeey.info:1000:user:pass-US-session-5m\nip:port:user:pass\nsocks5://user:pass@host:port"} className="w-full h-28 px-2.5 py-2 border border-gray-200 rounded-lg text-xs font-mono resize-y outline-none box-border"/>
            <div className="flex items-center gap-2 flex-wrap mt-2">
                <button onClick={() => void savePool(true)} className="px-3 py-1.5 bg-teal-600 text-white rounded-lg text-xs">批量追加</button>
                <button onClick={() => void savePool(false)} className="px-3 py-1.5 bg-indigo-600 text-white rounded-lg text-xs">覆盖保存</button>
                <label className="inline-flex items-center gap-1 text-xs text-gray-500">每条生成<input type="number" min={1} max={200} value={poolCopies} onChange={(e) => setPoolCopies(Math.max(1, Math.min(200, Number(e.target.value) || 1)))} className="w-14 px-1.5 py-1 border rounded text-center"/>个 session</label>
            </div>
            <div className="mt-4 pt-3 border-t border-gray-100">
                <div className="flex items-center gap-3 flex-wrap mb-2"><strong className="text-sm text-gray-700">统一跳板池</strong><span className="text-xs text-gray-500">VLESS 自动启动 Xray，SOCKS 直接作为跳板；不占用 10808</span></div>
                <div className="flex items-center gap-5 flex-wrap mb-2 text-sm">
                    <span className="text-gray-500">跳板使用范围</span>
                    <label className="inline-flex items-center gap-1.5 cursor-pointer"><input type="checkbox" checked={jumpForMail} onChange={(e) => void toggleJumpScope("mail", e.target.checked)}/><span>邮箱管理</span></label>
                    <label className="inline-flex items-center gap-1.5 cursor-pointer"><input type="checkbox" checked={jumpForGpt} onChange={(e) => void toggleJumpScope("gpt", e.target.checked)}/><span>GPT 管理</span></label>
                    <span className={failedJumps ? "text-amber-700 text-xs" : "text-gray-500 text-xs"}>跳板 {jump.total || 0} 条{failedJumps ? ` · 异常 ${failedJumps}` : ""}</span>
                </div>
                <textarea value={jumpText} onChange={(e) => setJumpText(e.target.value)} placeholder={"vless://uuid@host:port?security=reality&pbk=...#name\nsocks5://user:pass@host:8001"} className="w-full h-20 px-2.5 py-2 border border-gray-200 rounded-lg text-xs font-mono resize-y outline-none box-border"/>
                <div className="flex items-center gap-2 flex-wrap mt-2">
                    <button onClick={() => void saveJump()} disabled={jumpBusy} className="px-3 py-1.5 bg-indigo-600 text-white rounded-lg text-xs">{jumpBusy ? "处理中..." : "保存并探活"}</button>
                    <button onClick={() => void checkJump()} disabled={jumpBusy} className="px-3 py-1.5 border border-gray-200 rounded-lg text-xs">重新探活</button>
                    <button onClick={() => void clearJump()} disabled={jumpBusy} className="px-3 py-1.5 text-gray-500 text-xs">清空跳板</button>
                </div>
                {!!jump.items.length && <div className="mt-2 space-y-1">{jump.items.map((item, index) => <div key={`${item.url}-${index}`} className={`text-[11px] font-mono ${item.ok === false || item.xray === false ? "text-amber-700" : "text-gray-500"}`}>{item.ok === true ? "通" : item.ok === false ? "死" : "?"}{item.xray === false ? " xray未启动" : item.port ? ` xray:${item.port}` : ""} {item.source || item.masked} · {item.leased}/{item.cap}{item.reason || item.xrayError ? ` · ${item.reason || item.xrayError}` : ""}</div>)}</div>}
            </div>
        </div>
    );
}
