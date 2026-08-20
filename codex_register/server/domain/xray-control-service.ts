// @ts-nocheck
// Xray 控制服务：管理 Claude/跳板实例，并以异步子进程探测避免阻塞 HTTP 事件循环。
import {execFile} from "node:child_process";
import {promisify} from "node:util";

const execFileAsync = promisify(execFile);

export function createXrayControlService({scheduler, xray, runCommand = execFileAsync} = {}) {
    const validPort = (port) => Number.isInteger(port) && port >= 1024 && port <= 65535;

    function setClaudeProxy(proxy) {
        if (typeof proxy === "string") {
            scheduler.claudeProxy = proxy.trim();
            scheduler.saveSettings();
        }
        return {ok: true, claudeProxy: scheduler.claudeProxy};
    }

    function setProxyPorts({regPort, claudePort} = {}) {
        const requestedReg = Number(regPort);
        const requestedClaude = Number(claudePort);
        if (regPort != null && !validPort(requestedReg)) return {error: "reg 端口需为 1024-65535"};
        if (claudePort != null && !validPort(requestedClaude)) return {error: "claude 端口需为 1024-65535"};
        const nextReg = validPort(requestedReg) ? requestedReg : scheduler.regProxyPort;
        const nextClaude = validPort(requestedClaude) ? requestedClaude : scheduler.claudeProxyPort;
        if (nextReg === nextClaude) return {error: "reg 与 claude 端口不能相同"};
        const activeJumpPorts = new Set(xray.listJumpXrays()
            .filter((row) => row?.running)
            .map((row) => Number(row.port))
            .filter(Number.isInteger));
        if (activeJumpPorts.has(nextReg) || activeJumpPorts.has(nextClaude)) {
            return {error: "reg/claude 端口不能占用正在运行的跳板端口"};
        }
        scheduler.regProxyPort = nextReg;
        scheduler.claudeProxyPort = nextClaude;
        scheduler.saveSettings();
        try {
            if (scheduler.xrayVless) {
                const result = xray.start(scheduler.xrayVless, {
                    name: "reg",
                    localPort: scheduler.regProxyPort,
                    binPath: scheduler.xrayBinPath || undefined,
                });
                scheduler.regProxy = `socks5://127.0.0.1:${result.port}`;
            }
            if (scheduler.claudeXrayVless) {
                const result = xray.start(scheduler.claudeXrayVless, {
                    name: "claude",
                    localPort: scheduler.claudeProxyPort,
                    binPath: scheduler.xrayBinPath || undefined,
                });
                scheduler.claudeProxy = `socks5://127.0.0.1:${result.port}`;
            }
        } catch { /* 保持原配置，状态接口会暴露启动错误 */ }
        scheduler.saveSettings();
        return {
            ok: true,
            regProxyPort: scheduler.regProxyPort,
            claudeProxyPort: scheduler.claudeProxyPort,
            regProxy: scheduler.regProxy,
            claudeProxy: scheduler.claudeProxy,
        };
    }

    function startClaude(vlessUrl) {
        const url = String(vlessUrl || "").trim();
        if (!url) return {error: "缺少 vless 链接"};
        try {
            const result = xray.start(url, {
                name: "claude",
                localPort: scheduler.claudeProxyPort,
                binPath: scheduler.xrayBinPath || undefined,
            });
            scheduler.claudeXrayVless = url;
            scheduler.claudeProxy = `socks5://127.0.0.1:${result.port}`;
            scheduler.saveSettings();
            return {ok: true, xray: xray.status("claude"), claudeProxy: scheduler.claudeProxy};
        } catch (error) {
            return {error: String(error?.message ?? error)};
        }
    }

    function stopClaude() {
        xray.stop("claude");
        scheduler.claudeXrayVless = "";
        scheduler.saveSettings();
        return {ok: true, xray: xray.status("claude")};
    }

    async function startJump(vlessUrl) {
        const url = String(vlessUrl || scheduler.jumpXrayVless || "").trim();
        if (!url) return {error: "缺少 vless 链接"};
        if (!xray.isVlessUrl(url)) return {error: "跳板要 vless:// ，我会自己起 xray"};
        if (!(scheduler.mailJumpPool || []).includes(url)) {
            scheduler.mailJumpPool = [...(scheduler.mailJumpPool || []), url];
            scheduler.gptJumpPool = [...(scheduler.gptJumpPool || []), url];
        }
        scheduler.jumpXrayVless = url;
        try {
            await scheduler.ensureJumpFleet();
            scheduler.saveSettings();
            const row = (scheduler.jumpFleet || []).find((item) => item.vless === url) || (scheduler.jumpFleet || [])[0];
            return {
                ok: true,
                xray: row
                    ? {running: !!row.running, port: row.port, node: row.node, vless: row.vless, pid: 0, error: row.error || ""}
                    : xray.status("jump"),
                jump: row?.socks || "",
                jumpPool: scheduler.jumpPoolSnapshot(),
            };
        } catch (error) {
            return {error: String(error?.message ?? error)};
        }
    }

    function stopJump() {
        xray.stopJumpFleet();
        scheduler.jumpXrayVless = "";
        scheduler.jumpFleet = [];
        scheduler.saveSettings();
        return {ok: true, xray: xray.status("jump"), xrays: xray.listJumpXrays()};
    }

    function setBinaryPath(binPath) {
        scheduler.xrayBinPath = String(binPath ?? "").trim();
        scheduler.saveSettings();
        return {ok: true, xrayBinPath: scheduler.xrayBinPath};
    }

    function stopLegacy() {
        xray.stop();
        scheduler.xrayVless = "";
        scheduler.saveSettings();
        return {ok: true, xray: xray.status()};
    }

    async function probeLegacy() {
        const status = xray.status();
        if (!status.running) return {ok: false, reason: "独立 xray 未运行"};
        const proxy = `socks5h://127.0.0.1:${status.port}`;
        try {
            const [ipResult, chatResult] = await Promise.all([
                runCommand("curl", ["-s", "--max-time", "15", "--proxy", proxy, "https://api.ipify.org"], {timeout: 18_000}),
                runCommand("curl", ["-s", "-o", "/dev/null", "-w", "%{http_code}", "--max-time", "20", "--proxy", proxy, "https://chatgpt.com/"], {timeout: 23_000}),
            ]);
            const ip = String(ipResult.stdout || "").trim();
            const chatgpt = String(chatResult.stdout || "").trim();
            return {ok: true, ip, chatgpt, pass: chatgpt === "403" || chatgpt === "200"};
        } catch (error) {
            return {ok: false, reason: `经代理连接失败(节点可能失效): ${String(error?.message ?? error).slice(0, 120)}`};
        }
    }

    function state() {
        return {
            xray: xray.status(),
            claudeXray: xray.status("claude"),
            jumpXray: (scheduler.jumpFleet || [])[0] || xray.status("jump"),
            jumpXrays: xray.listJumpXrays(),
        };
    }

    return {
        setClaudeProxy,
        setProxyPorts,
        startClaude,
        stopClaude,
        startJump,
        stopJump,
        setBinaryPath,
        stopLegacy,
        probeLegacy,
        state,
    };
}
