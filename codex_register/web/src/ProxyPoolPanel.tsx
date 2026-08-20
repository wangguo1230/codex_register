import {SharedProxyPoolPanel, type SharedProxyPoolMeta} from "./SharedProxyPoolPanel";

export type ProxyPoolMeta = SharedProxyPoolMeta;

/** 旧页面入口的兼容包装，代理池配置统一由 SharedProxyPoolPanel 负责。 */
export function ProxyPoolPanel({
    notify,
    title = "统一代理池",
    onMeta,
}: {
    notify?: (message: string) => void;
    title?: string;
    kind?: "mail" | "gpt";
    hint?: string;
    onMeta?: (meta: ProxyPoolMeta) => void;
}) {
    return <SharedProxyPoolPanel notify={notify} title={title} onMeta={onMeta} />;
}
