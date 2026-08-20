// @ts-nocheck
// 充值平台 HTTP 客户端：统一鉴权、超时和结构化错误。

export class RechargeApiError extends Error {
    constructor(message, {method = "", apiPath = "", kind = "network", httpStatus = 0, cause} = {}) {
        super(message, cause ? {cause} : undefined);
        this.name = "RechargeApiError";
        this.method = method;
        this.apiPath = apiPath;
        this.kind = kind;
        this.httpStatus = Number(httpStatus) || 0;
    }

    get indeterminate() {
        return this.kind === "timeout"
            || this.kind === "network"
            || this.httpStatus === 408
            || this.httpStatus >= 500;
    }
}

export function createRechargeApiClient({getConfig, timeoutMs = 30_000, fetchImpl = globalThis.fetch} = {}) {
    return async function callRechargeApi(method, apiPath, body) {
        const config = getConfig?.() || {};
        const baseUrl = String(config.baseUrl || "").trim();
        const apiKey = String(config.apiKey || "").trim();
        if (!baseUrl || !apiKey) {
            throw new RechargeApiError("充值平台 API 未配置(缺少 Base URL 或 API Key)", {
                method,
                apiPath,
                kind: "configuration",
            });
        }

        const headers = {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
        };
        if (config.forwardIp) headers["X-Forwarded-For"] = String(config.forwardIp);

        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
            const response = await fetchImpl(`${baseUrl.replace(/\/+$/, "")}${apiPath}`, {
                method,
                headers,
                body: body ? JSON.stringify(body) : undefined,
                signal: controller.signal,
            });
            const text = await response.text();
            let data = {};
            try { data = JSON.parse(text); } catch { /* 平台可能返回纯文本错误 */ }
            if (!response.ok) {
                const detail = data.detail || (text.length < 200 ? text : "") || "";
                throw new RechargeApiError(
                    `${method} ${apiPath} → ${response.status}${detail ? ": " + detail : ""}`,
                    {method, apiPath, kind: "http", httpStatus: response.status},
                );
            }
            return data;
        } catch (error) {
            if (error instanceof RechargeApiError) throw error;
            const timedOut = controller.signal.aborted || error?.name === "AbortError";
            const kind = timedOut ? "timeout" : "network";
            const detail = timedOut ? `超过 ${timeoutMs}ms` : String(error?.message || error).slice(0, 160);
            throw new RechargeApiError(`${method} ${apiPath} ${timedOut ? "超时" : "网络失败"}: ${detail}`, {
                method,
                apiPath,
                kind,
                cause: error,
            });
        } finally {
            clearTimeout(timer);
        }
    };
}
