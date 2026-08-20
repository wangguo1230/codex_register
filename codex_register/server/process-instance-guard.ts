// @ts-nocheck
// HTTP 实例守卫：识别残留服务进程、清理监听端口并维护端口级 PID 文件。
import {execFileSync} from "node:child_process";
import {existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync} from "node:fs";
import path from "node:path";

const defaultFiles = {
    exists: existsSync,
    mkdir: (directory) => mkdirSync(directory, {recursive: true}),
    read: (file) => readFileSync(file, "utf8"),
    write: (file, value) => writeFileSync(file, value, "utf8"),
    unlink: unlinkSync,
};

const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

export function createProcessInstanceGuard({
    port,
    dataDir,
    runtime = process,
    execute = execFileSync,
    files = defaultFiles,
    logger = console,
    now = Date.now,
    sleep = sleepSync,
} = {}) {
    const pidPath = path.resolve(dataDir, `http-${Number(port)}.pid`);
    const executeText = (file, args) => String(execute(file, args, {encoding: "utf8", windowsHide: true}) || "");

    function killPid(pid) {
        if (runtime.platform === "win32") execute("taskkill", ["/F", "/PID", String(pid)], {stdio: "ignore", windowsHide: true});
        else runtime.kill(pid, "SIGKILL");
    }

    function collectPidsOnPort() {
        const pids = new Set();
        try {
            if (runtime.platform === "win32") {
                const output = executeText("netstat", ["-ano"]);
                for (const line of output.split(/\r?\n/)) {
                    if (!/LISTENING/i.test(line)) continue;
                    if (!line.includes(`:${port} `) && !new RegExp(`:${port}\\s`).test(line)) continue;
                    const pid = Number(line.trim().split(/\s+/).pop());
                    if (pid && pid !== runtime.pid) pids.add(pid);
                }
            } else {
                const output = executeText("lsof", ["-ti", `tcp:${port}`, "-sTCP:LISTEN"]);
                for (const pid of output.split(/\s+/).map(Number).filter(Boolean)) {
                    if (pid !== runtime.pid) pids.add(pid);
                }
            }
        } catch { /* 没有监听进程时 lsof 会返回非零 */ }
        try {
            const previous = files.exists(pidPath) ? Number(String(files.read(pidPath) || "").trim()) : 0;
            if (previous && previous !== runtime.pid) pids.add(previous);
        } catch { /* PID 文件不可读时忽略 */ }
        return [...pids];
    }

    function killExistingHttp() {
        for (const pid of collectPidsOnPort()) {
            try {
                killPid(pid);
                logger.log(`[server] 先结束旧 :${port} pid=${pid}，再启动（强制结束，不走关窗收尾）`);
            } catch { /* 已退出 */ }
        }
        const deadline = now() + 3_000;
        while (now() < deadline && collectPidsOnPort().length) sleep(80);
    }

    function writePid() {
        try {
            files.mkdir(path.dirname(pidPath));
            files.write(pidPath, String(runtime.pid));
            return true;
        } catch {
            return false;
        }
    }

    function dropPid() {
        try {
            if (!files.exists(pidPath)) return;
            const owner = Number(String(files.read(pidPath) || "").trim());
            if (owner === runtime.pid) files.unlink(pidPath);
        } catch { /* */ }
    }

    function registerPid() {
        writePid();
        runtime.on("exit", dropPid);
        return () => {
            runtime.off?.("exit", dropPid);
            dropPid();
        };
    }

    return {pidPath, collectPidsOnPort, killExistingHttp, registerPid, dropPid};
}
