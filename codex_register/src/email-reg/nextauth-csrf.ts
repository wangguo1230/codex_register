/**
 * NextAuth csrf 预取。
 *
 * chatgpt.com 首页（GET /）现在只下发 oai-did，不再 set NextAuth 的
 * `__Host-next-auth.csrf-token`。纯邮箱注册的 openSignupPage 走的是 chatgpt.com 的
 * `/api/auth/signin/openai` 端点，必须带 csrfToken；所以要在 boot 后显式打一次
 * `/api/auth/csrf`，让 NextAuth 把这个 cookie set 进 cookie jar。
 *
 * 注意：cookie 的落盘由调用方的 fetch（makeFetchCookie 包装）负责，这里只管把请求打出去。
 */

export type FetchFn = (input: string, init?: Record<string, unknown>) => Promise<Response>;

/**
 * @param fetchFn  已绑定 cookie jar 的 fetch（this.fetch）
 * @param baseUrl  chatgpt.com base（CHATGPT_BASE_URL）
 * @param headers  调用方用 createBrowserHeaders 造好的请求头
 */
export async function ensureNextAuthCsrf(
    fetchFn: FetchFn,
    baseUrl: string,
    headers: Headers,
): Promise<void> {
    const resp = await fetchFn(`${baseUrl}/api/auth/csrf`, {
        method: "GET",
        redirect: "follow",
        headers,
    });
    if (!resp.ok) {
        throw new Error(`获取 NextAuth csrf 失败: ${resp.status}`);
    }
}
