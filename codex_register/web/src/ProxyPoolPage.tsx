import {useState} from "react";
import {SharedProxyPoolPanel, type SharedProxyPoolMeta} from "./SharedProxyPoolPanel";

/** 代理基础设施独立页：配置入口集中在这里，业务页只消费租约状态。 */
export function ProxyPoolPage({notify}: {notify?: (message: string) => void}) {
    const [meta, setMeta] = useState<SharedProxyPoolMeta>({total: 0, slots: 0, leased: 0, free: 0, jump: ""});

    return (
        <main className="flex-1 min-h-0 overflow-auto bg-slate-50">
            <div className="mx-auto w-full max-w-[1320px] px-6 py-7">
                <header className="flex flex-wrap items-end justify-between gap-5 border-b border-slate-200 pb-6">
                    <div>
                        <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-indigo-600">Infrastructure / Routing</div>
                        <h1 className="mt-1 text-2xl font-semibold tracking-tight text-slate-900">代理池</h1>
                        <p className="mt-2 text-sm text-slate-500">统一管理出口代理、跳板和邮箱/GPT的使用范围。</p>
                    </div>
                    <div className="grid min-w-[290px] grid-cols-4 gap-2 text-center">
                        <div className="border border-slate-200 bg-white px-3 py-2">
                            <div className="text-lg font-semibold tabular-nums text-slate-900">{meta.total}</div>
                            <div className="text-[11px] text-slate-500">出口</div>
                        </div>
                        <div className="border border-slate-200 bg-white px-3 py-2">
                            <div className="text-lg font-semibold tabular-nums text-emerald-700">{meta.free}</div>
                            <div className="text-[11px] text-slate-500">空闲</div>
                        </div>
                        <div className="border border-slate-200 bg-white px-3 py-2">
                            <div className="text-lg font-semibold tabular-nums text-amber-700">{meta.leased}</div>
                            <div className="text-[11px] text-slate-500">占用</div>
                        </div>
                        <div className="border border-slate-200 bg-white px-3 py-2">
                            <div className="text-lg font-semibold tabular-nums text-indigo-700">{meta.jump ? "已配" : "未配"}</div>
                            <div className="text-[11px] text-slate-500">跳板</div>
                        </div>
                    </div>
                </header>

                <section className="pt-6">
                    <SharedProxyPoolPanel
                        notify={notify}
                        title="统一代理池配置"
                        onMeta={setMeta}
                    />
                </section>
            </div>
        </main>
    );
}
