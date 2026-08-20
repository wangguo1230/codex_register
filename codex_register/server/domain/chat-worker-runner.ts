// @ts-nocheck
import {rmSync, writeFileSync} from "node:fs";
import os from "node:os";
import path from "node:path";

export function createChatWorkerRunner({runtime, credentials, proxy, effects, tempDir = os.tmpdir()} = {}) {
    function createAuthFile(account) {
        const authData = credentials.readAuth(account);
        if (!authData) return {file: account.auth_file || "", cleanup() {}};
        const file = path.join(tempDir, `chat-auth-${account.id}-${Date.now()}.json`);
        writeFileSync(file, JSON.stringify(authData));
        return {
            file,
            cleanup: () => {
                try { rmSync(file, {force: true}); } catch { /* */ }
            },
        };
    }

    async function run(account, message) {
        await effects.setStatus(account.id, "chat", "聊天中…");
        effects.log(account.id, "[chat] 启动浏览器发消息…");
        const auth = createAuthFile(account);
        let proxyUrl;
        try {
            proxyUrl = await proxy.pick();
        } catch (error) {
            auth.cleanup();
            const reason = String(error?.message || error);
            await effects.setStatus(account.id, "chat", "❌启动失败:" + reason);
            return {ok: false, reason};
        }
        if (!proxyUrl) {
            auth.cleanup();
            await effects.setStatus(account.id, "chat", "❌无xray");
            return {ok: false, reason: "浏览器必须走 xray，本机没有 10811/10808"};
        }

        return new Promise((resolve) => {
            let settled = false;
            let result = null;
            const finish = async (value, status) => {
                if (settled) return;
                settled = true;
                auth.cleanup();
                await effects.setStatus(account.id, "chat", status);
                resolve(value);
            };
            let child;
            try {
                child = runtime.spawn(["src/worker-chat.ts"], runtime.cleanEnv({
                    CHAT_AUTH_FILE: auth.file,
                    CHAT_MESSAGE: message || "",
                    PROXY_URL: proxyUrl,
                    MAIL_PROXY_JUMP: "",
                }));
            } catch (error) {
                const reason = String(error?.message || error);
                effects.logError(account.id, `[chat] worker 启动失败: ${reason}`);
                void finish({ok: false, reason}, "❌启动失败:" + reason);
                return;
            }
            runtime.pipeOutput(child, {
                onLine: (line) => effects.log(account.id, `[chat] ${line}`),
                onEvent: (event) => {
                    if (event?.type === "progress") effects.log(account.id, `[chat] ${event.message}`);
                    else if (event?.type === "result") result = event;
                },
            });
            child.once("error", (error) => {
                const reason = String(error?.message || error);
                effects.logError(account.id, `[chat] worker 启动失败: ${reason}`);
                void finish({ok: false, reason}, "❌启动失败:" + reason);
            });
            child.once("close", () => {
                const status = result
                    ? (result.ok ? "✅回复成功" : "❌" + (result.error || "无回复"))
                    : "❌进程异常退出";
                void finish(result || {ok: false}, status);
            });
        });
    }

    return {run};
}
