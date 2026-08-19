// 3100 主进程内存看门狗。Playwright / 比特 CDP 一旦挂在 HTTP 进程里，
// RSS 会在十几分钟内冲到几十 GB，事件循环卡死，页面全超时。
import {spawn} from "node:child_process";
import path from "node:path";
import {fileURLToPath} from "node:url";

const WARN_MB = Math.max(400, Number(process.env.RSS_WARN_MB || 900));
const BLOCK_MB = Math.max(WARN_MB, Number(process.env.RSS_BLOCK_MB || 1800));
const RESTART_MB = Math.max(BLOCK_MB, Number(process.env.RSS_RESTART_MB || 3200));
const PARK_MS = Math.max(500, Number(process.env.RSS_PARK_MS || 2500));

let blocked = false;
let restarting = false;

export function rssMb() {
    return Math.round(process.memoryUsage().rss / 1024 / 1024);
}

export function isBrowserWorkBlocked() {
    return blocked || restarting;
}

export function startRssGuard({server = null, name = "3100", onBeforeRestart = null} = {}) {
    spawnExternalWatchdog();
    const tick = () => {
        const mb = rssMb();
        if (mb >= RESTART_MB) {
            if (restarting) return;
            restarting = true;
            console.error(`[rss] ${name} RSS=${mb}MB ≥ ${RESTART_MB}MB，先退回队列再重启`);
            void (async () => {
                try {
                    await Promise.race([
                        Promise.resolve(onBeforeRestart?.(mb)),
                        new Promise((r) => setTimeout(r, PARK_MS)),
                    ]);
                } catch (e) {
                    console.warn("[rss] 退回队列失败:", (e as Error)?.message || e);
                }
                reexec(server);
            })();
            return;
        }
        if (mb >= BLOCK_MB) {
            if (!blocked) console.warn(`[rss] ${name} RSS=${mb}MB，暂停本进程再开浏览器（进行中的任务不杀）`);
            blocked = true;
        } else if (mb < Math.floor(BLOCK_MB * 0.7)) {
            blocked = false;
        } else if (mb >= WARN_MB) {
            console.warn(`[rss] ${name} RSS=${mb}MB`);
        }
    };
    setInterval(tick, 4000).unref();
    tick();
}

function spawnExternalWatchdog() {
    try {
        const here = path.dirname(fileURLToPath(import.meta.url));
        const script = path.join(here, "rss-watchdog.mjs");
        const child = spawn(process.execPath, [script], {
            env: {
                ...process.env,
                WATCH_PID: String(process.pid),
                RSS_RESTART_MB: String(RESTART_MB),
            },
            detached: true,
            stdio: "ignore",
        });
        child.unref();
        console.log(`[rss] 外部看门狗 pid=${child.pid} 盯 ${process.pid} ≥${RESTART_MB}MB`);
    } catch (e) {
        console.warn("[rss] 外部看门狗未启动:", (e as Error)?.message || e);
    }
}

function reexec(server) {
    let launched = false;
    const launch = () => {
        if (launched) return;
        launched = true;
        const child = spawn(process.execPath, [...process.execArgv, ...process.argv.slice(1)], {
            cwd: process.cwd(),
            env: process.env,
            detached: true,
            stdio: "inherit",
        });
        child.unref();
        setTimeout(() => process.exit(0), 400);
    };
    try {
        server?.close?.(() => launch());
    } catch {
        launch();
        return;
    }
    setTimeout(launch, 2500);
}
