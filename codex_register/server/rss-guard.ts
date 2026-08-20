// 3100 主进程内存监控。只负责阻止新的浏览器任务，不负责重启或强杀进程。

const WARN_MB = Math.max(400, Number(process.env.RSS_WARN_MB || 900));
const BLOCK_MB = Math.max(WARN_MB, Number(process.env.RSS_BLOCK_MB || 1800));

interface RssGuardOptions {
    name?: string;
    readRss?: () => number;
    warn?: (...args: unknown[]) => void;
    intervalMs?: number;
    setIntervalFn?: (callback: () => void, delayMs: number) => NodeJS.Timeout;
    clearIntervalFn?: (timer: NodeJS.Timeout) => void;
}

export function rssMb() {
    return Math.round(process.memoryUsage().rss / 1024 / 1024);
}

export function createRssGuard({
    name = "3100",
    readRss = rssMb,
    warn = console.warn,
    intervalMs = 4000,
    setIntervalFn = setInterval,
    clearIntervalFn = clearInterval,
}: RssGuardOptions = {}) {
    let blocked = false;
    let timer: NodeJS.Timeout | null = null;

    const tick = () => {
        const mb = Number(readRss());
        if (!Number.isFinite(mb) || mb < 0) return;
        if (mb >= BLOCK_MB) {
            if (!blocked) warn(`[rss] ${name} RSS=${mb}MB，暂停新建浏览器任务（进行中的任务不杀）`);
            blocked = true;
        } else if (mb < Math.floor(BLOCK_MB * 0.7)) {
            blocked = false;
        } else if (mb >= WARN_MB) {
            warn(`[rss] ${name} RSS=${mb}MB`);
        }
    };

    const stop = () => {
        if (!timer) return;
        clearIntervalFn(timer);
        timer = null;
    };
    const start = () => {
        if (timer) return stop;
        timer = setIntervalFn(tick, Math.max(1000, Number(intervalMs) || 4000));
        timer?.unref?.();
        tick();
        return stop;
    };

    return {
        tick,
        isBlocked: () => blocked,
        start,
        stop,
    };
}

const defaultGuard = createRssGuard();

export function isBrowserWorkBlocked() {
    return defaultGuard.isBlocked();
}

export function startRssGuard(_options: RssGuardOptions = {}) {
    return defaultGuard.start();
}
