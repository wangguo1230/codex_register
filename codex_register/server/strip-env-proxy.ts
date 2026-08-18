// 必须最先加载。本机 shell 常带 ALL_PROXY=10808，Node 24 的 fetch / Playwright
// 会把 PG、SSE、CDP、平台 API 全塞进代理，几分钟内把 :3100 吃到几十 GB。
const KEYS = [
    "ALL_PROXY", "all_proxy",
    "HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy",
    "NO_PROXY", "no_proxy",
];
const stripped = KEYS.filter((k) => process.env[k]).map((k) => {
    const v = String(process.env[k] || "");
    delete process.env[k];
    return `${k}=${v.slice(0, 48)}`;
});
if (stripped.length) {
    console.warn("[proxy-env] 已剥离系统代理，改走业务里显式配置:", stripped.join(" "));
}

export function cleanSpawnEnv(extra: Record<string, string> = {}) {
    const env = {...process.env, ...extra};
    for (const k of KEYS) delete env[k];
    return env;
}
