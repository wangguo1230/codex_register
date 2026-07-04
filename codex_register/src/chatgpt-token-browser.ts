import {existsSync} from "node:fs";
import {chromium} from "playwright-core";

function resolveBrowserExecutablePath(): string {
    const candidates = [
        process.env.CHATGPT_TOKEN_BROWSER_PATH,
        process.env.SENTINEL_BROWSER_PATH,
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
        "/Applications/Chromium.app/Contents/MacOS/Chromium",
        "/usr/bin/google-chrome",
        "/usr/bin/chromium",
        "/usr/bin/chromium-browser",
        "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
        "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
        "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
        "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    ].filter(Boolean) as string[];

    const matched = candidates.find((c) => existsSync(c));
    if (!matched) {
        throw new Error("未找到可用浏览器,请设置 CHATGPT_TOKEN_BROWSER_PATH 或 SENTINEL_BROWSER_PATH");
    }
    return matched;
}

function parseProxy(rawProxy: string): {server: string; username?: string; password?: string} | undefined {
    if (!rawProxy) return undefined;
    try {
        const u = new URL(rawProxy);
        const protocol = u.protocol.startsWith("socks") ? "http:" : u.protocol;
        const cfg: {server: string; username?: string; password?: string} = {
            server: `${protocol}//${u.host}`,
        };
        if (u.username) cfg.username = decodeURIComponent(u.username);
        if (u.password) cfg.password = decodeURIComponent(u.password);
        return cfg;
    } catch {
        return {server: rawProxy};
    }
}

export interface FetchChatGPTAccessTokenOptions {
    callbackURL: string;
    proxy?: string;
    headless?: boolean;
    timeoutMs?: number;
    userAgent?: string;
}

export async function fetchChatGPTAccessTokenViaBrowser(
    opts: FetchChatGPTAccessTokenOptions,
): Promise<string> {
    if (!opts.callbackURL) {
        throw new Error("callbackURL 为空");
    }
    const proxyCfg = parseProxy(opts.proxy ?? "");
    const timeout = opts.timeoutMs ?? 60000;

    const browser = await chromium.launch({
        headless: opts.headless ?? true,
        executablePath: resolveBrowserExecutablePath(),
        proxy: proxyCfg,
    });

    try {
        const context = await browser.newContext({
            userAgent:
                opts.userAgent ??
                "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
            locale: "en-US",
        });
        const page = await context.newPage();

        // 完成 callback,让 chatgpt.com 的 session cookie 落到 context
        await page.goto(opts.callbackURL, {
            waitUntil: "domcontentloaded",
            timeout,
        });
        // 等 cookie 写入 + 任何 redirect 完成
        await page.waitForLoadState("networkidle", {timeout}).catch(() => undefined);
        await page.waitForTimeout(1500);

        // 用 context.request 共享同一 cookie jar 调 /api/auth/session
        const sessionResp = await context.request.get(
            "https://chatgpt.com/api/auth/session",
            {
                headers: {accept: "application/json"},
                timeout,
            },
        );
        const status = sessionResp.status();
        const text = await sessionResp.text();
        if (status >= 400) {
            throw new Error(`/api/auth/session HTTP ${status}: ${text.slice(0, 200)}`);
        }
        let json: any;
        try {
            json = JSON.parse(text);
        } catch {
            throw new Error(`/api/auth/session 非 JSON: ${text.slice(0, 200)}`);
        }
        const accessToken = String(json?.accessToken ?? json?.access_token ?? "").trim();
        if (!accessToken) {
            throw new Error(
                `/api/auth/session 无 accessToken: ${JSON.stringify(json).slice(0, 300)}`,
            );
        }
        return accessToken;
    } finally {
        await browser.close().catch(() => undefined);
    }
}
