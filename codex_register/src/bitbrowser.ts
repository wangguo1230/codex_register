// @ts-nocheck
// 比特浏览器(BitBrowser) Local API 对接。
// 每个注册号:动态创建一个【独立随机指纹】窗口(可绑代理)→ 打开拿 CDP(ws) → Playwright connectOverCDP 注册 → 用完关闭+删除。
// 这样 100 个号 = 100 套不同指纹(打散"同一设备批量"的封号聚类),循环用会员额度。
// 文档: https://doc2.bitbrowser.cn/jiekou/ben-di-fu-wu-zhi-nan.html  默认本地端口 54345,无需鉴权。
const BIT_API = process.env.BIT_API_URL || "http://127.0.0.1:54345";

async function bitPost(pathname, body) {
    const r = await fetch(`${BIT_API}${pathname}`, {
        method: "POST",
        headers: {"Content-Type": "application/json"},
        body: JSON.stringify(body || {}),
    });
    const j = await r.json().catch(() => ({}));
    if (!j || j.success !== true) {
        const msg = JSON.stringify(j).slice(0, 200);
        if (/频繁|频率|too many|rate/i.test(msg)) markListBackoff(60_000);
        if (/login out|未登录|please login|token 失效|检查登录状态/i.test(msg)) markBitLoggedOut(true);
        throw new Error(`比特API ${pathname} 失败: ${msg}`);
    }
    if (pathname === "/browser/list" || pathname === "/browser/update") markBitLoggedOut(false);
    return j.data;
}

// 健康检查(用于开关前探测比特是否在跑)
export async function bitHealth() {
    try { const r = await fetch(`${BIT_API}/health`, {method: "POST"}); const j = await r.json(); return j?.success === true; }
    catch { return false; }
}

/** health 在未登录时仍可能是 true，开窗前再确认会话。 */
export async function bitSessionReady() {
    if (!await bitHealth()) return {ok: false, reason: "比特浏览器未启动(127.0.0.1:54345)"};
    if (isBitLoggedOut()) return {ok: false, reason: "比特已退出登录，请先在客户端重新登录"};
    return {ok: true};
}

// 创建随机指纹窗口(proxy 可选,格式 socks5://host:port 或 http://user:pass@host:port)。返回窗口 id。
export async function createBitWindow({proxy = "", name = "reg", remark = "codex-reg", timeZone = ""} = {}) {
    const screen = await getScreenSize();
    const tile = tileLayout(plannedTileCount(), screen);
    const body = {
        name: `${String(name || "reg").slice(0, 24)}-${Date.now().toString(36).slice(-5)}`,
        remark,
        proxyMethod: 2,
        proxyType: "noproxy",
        browserFingerPrint: {
            ...(timeZone ? {timezone: timeZone, timeZone, isIpCreateTimeZone: false} : {}),
            isIpCreateLanguage: false,
            languages: "en-US",
            isIpCreateDisplayLanguage: false,
            displayLanguages: "en-US",
            openWidth: tile.width,
            openHeight: tile.height,
        },
        randomFingerprint: true,
        clearCookiesBeforeLaunch: true,
        clearCacheFilesBeforeLaunch: true,
        syncCookies: false,
        syncTabs: false,
        syncAuthorization: false,
        syncIndexedDb: false,
        syncLocalStorage: false,
        syncHistory: false,
    };
    if (proxy) {
        const u = new URL(proxy);
        body.proxyType = u.protocol.replace(":", "");   // socks5 / http / https
        body.host = u.hostname;
        body.port = u.port;
        if (u.username) body.proxyUserName = decodeURIComponent(u.username);
        if (u.password) body.proxyPassword = decodeURIComponent(u.password);
    }
    const d = await bitPost("/browser/update", body);   // 无 id = 新建
    if (d?.id) {
        await bitPost("/browser/update/partial", {
            ids: [d.id],
            browserFingerPrint: {
                isIpCreateLanguage: false,
                languages: "en-US",
                isIpCreateDisplayLanguage: false,
                displayLanguages: "en-US",
            },
        }).catch(() => {});
    }
    return d.id;
}

function gridForCount(n) {
    const count = Math.max(1, Number(n) || 1);
    if (count <= 1) return {cols: 1, rows: 1};
    if (count === 2) return {cols: 2, rows: 1};
    if (count <= 4) return {cols: 2, rows: 2};
    if (count <= 6) return {cols: 3, rows: 2};
    if (count <= 9) return {cols: 3, rows: 3};
    return {cols: 4, rows: Math.ceil(count / 4)};
}

let cachedScreen = null;
let expectedBitTiles = 0;

/** 按本机并发（代理槽）预排，避免第 1 个窗按整屏打开。 */
export function setExpectedBitTiles(n) {
    expectedBitTiles = Math.max(0, Math.min(16, Number(n) || 0));
}

function plannedTileCount() {
    const live = liveBitIds.size || 0;
    // 已经开了几个就按几个排：4 个必须是 2x2。不要用代理槽 5 排成 3x2 留一个大空洞。
    if (live >= 2) return live;
    return 4;
}

async function getScreenSize() {
    if (cachedScreen) return cachedScreen;
    try {
        const {execFile} = await import("node:child_process");
        const {promisify} = await import("node:util");
        const execFileAsync = promisify(execFile);
        if (process.platform === "darwin") {
            try {
                const {stdout} = await execFileAsync("osascript", [
                    "-e", "use framework \"AppKit\"",
                    "-e", "set vf to current application's NSScreen's mainScreen()'s visibleFrame()",
                    "-e", "set w to (vf's |size|()'s width()) as integer",
                    "-e", "set h to (vf's |size|()'s height()) as integer",
                    "-e", "return (w as text) & \" \" & (h as text)",
                ], {timeout: 8000});
                const nums = String(stdout).trim().split(/\s+/).map(Number).filter((n) => n > 200);
                if (nums.length >= 2) cachedScreen = {w: nums[0], h: nums[1]};
            } catch { /* 再退回 Finder */ }
            if (!cachedScreen) {
                const {stdout} = await execFileAsync("osascript", ["-e", 'tell application "Finder" to get bounds of window of desktop']);
                const nums = String(stdout).split(/[^\d]+/).filter(Boolean).map(Number);
                if (nums.length >= 4) cachedScreen = {w: Math.max(800, nums[2] - nums[0]), h: Math.max(600, nums[3] - nums[1] - 80)};
            }
        } else if (process.platform === "win32") {
            // 必须用工作区逻辑像素。Win32_VideoController 是物理分辨率，150% 缩放下会把每个窗算成接近整屏。
            const {stdout} = await execFileAsync("powershell", [
                "-NoProfile", "-STA", "-Command",
                "Add-Type -AssemblyName System.Windows.Forms; $w=[System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea; Write-Output $w.Width; Write-Output $w.Height",
            ], {timeout: 8000});
            const nums = String(stdout).trim().split(/\s+/).map(Number).filter((n) => n > 200);
            if (nums.length >= 2) cachedScreen = {w: nums[0], h: nums[1]};
        }
    } catch { /* 拿不到就用保守值 */ }
    if (!cachedScreen) cachedScreen = process.platform === "win32" ? {w: 1366, h: 768} : {w: 1440, h: 900};
    // 4K 物理值误当成逻辑值时压到常见桌面，避免 2x2 每格还接近 1080p
    if (cachedScreen.w > 3000 || cachedScreen.h > 1800) {
        cachedScreen = {w: Math.round(cachedScreen.w / 1.5), h: Math.round(cachedScreen.h / 1.5)};
    }
    return cachedScreen;
}

function tileLayout(count, screen) {
    const n = Math.max(1, Number(count) || 1);
    const {cols, rows} = gridForCount(n);
    const startX = 8;
    const startY = process.platform === "darwin" ? 28 : 8;
    const spaceX = 10;
    const spaceY = 10;
    const taskbar = process.platform === "darwin" ? 8 : 8;
    const availW = Math.max(640, Number(screen.w) - startX);
    const availH = Math.max(400, Number(screen.h) - startY - taskbar);
    let width = Math.floor((availW - (cols - 1) * spaceX) / cols);
    let height = Math.floor((availH - (rows - 1) * spaceY) / rows);
    width = Math.min(width, availW);
    height = Math.min(height, availH);
    if (width * cols + spaceX * (cols - 1) > availW) width = Math.floor((availW - (cols - 1) * spaceX) / cols);
    if (height * rows + spaceY * (rows - 1) > availH) height = Math.floor((availH - (rows - 1) * spaceY) / rows);
    width = Math.max(400, width);
    height = Math.max(240, height);
    return {cols, rows, startX, startY, spaceX, spaceY, width, height};
}

/** 按当前开着的窗数宫格排开，避免全叠在一起。 */
export async function arrangeBitWindows(count = 0) {
    const n = Math.max(1, Number(count) || plannedTileCount());
    const screen = await getScreenSize();
    const t = tileLayout(n, screen);
    await bitPost("/windowbounds", {
        type: "box",
        startX: t.startX,
        startY: t.startY,
        width: t.width,
        height: t.height,
        col: t.cols,
        spaceX: t.spaceX,
        spaceY: t.spaceY,
        offsetX: 40,
        offsetY: 40,
    });
}

let arrangeTimer = null;
function scheduleArrangeBitWindows() {
    clearTimeout(arrangeTimer);
    arrangeTimer = setTimeout(() => {
        arrangeBitWindows().catch(() => {});
    }, 450);
}

// 打开窗口 → 返回 CDP 端点。data.ws 是 Playwright connectOverCDP 用的 ws:// 端点。
// extractIp:true = 打开时按代理出口 IP 自动对齐浏览器时区/地理位置(消除"IP地理≠时区≠locale"的风控信号,
//   注册即封的高权重原因之一)。因此 worker 不再手动硬编码时区。
export async function openBitWindow(id, {extractIp = true} = {}) {
    const screen = await getScreenSize();
    const n = plannedTileCount();
    const t = tileLayout(n, screen);
    const idx = Math.max(0, liveBitIds.size - 1);
    const col = idx % t.cols;
    const row = Math.floor(idx / t.cols);
    const x = t.startX + col * (t.width + t.spaceX);
    const y = t.startY + row * (t.height + t.spaceY);
    // Chrome --window-size 是内容区，比特标题栏+标签还要再占一截，不扣就会互相叠住。
    const innerW = Math.max(400, t.width - 16);
    const innerH = Math.max(240, t.height - (process.platform === "darwin" ? 88 : 80));
    const args = [
        `--window-position=${x},${y}`,
        `--window-size=${innerW},${innerH}`,
        "--lang=en-US",
        "--accept-lang=en-US,en",
    ];
    const d = await bitPost("/browser/open", {id, args, loadExtensions: false, extractIp: extractIp !== false});
    scheduleArrangeBitWindows();
    return {ws: d.ws, http: d.http, driver: d.driver};
}

export async function closeBitWindow(id) {
    try { await bitPost("/browser/close", {id}); } catch { /* ignore */ }
    liveBitIds.delete(id);
    if (liveBitIds.size) scheduleArrangeBitWindows();
}
export async function deleteBitWindow(id) { try { await bitPost("/browser/delete", {id}); } catch { /* ignore */ } }

const liveBitIds = new Set();
const STALE_NAME_RE = /^(harden-|totp-|probe-|gmail-|recharge|pw-|2fa-)/i;
const STALE_REMARKS = new Set(["gmail-harden", "gmail-manage", "gmail-gpt", "gmail-pw", "gmail-2fa"]);

export function trackBitWindow(id) { if (id) liveBitIds.add(id); }
export function untrackBitWindow(id) { liveBitIds.delete(id); }
export function liveBitWindowIds() { return [...liveBitIds]; }

export async function listBitWindows({page = 0, pageSize = 100} = {}) {
    const d = await bitPost("/browser/list", {page, pageSize});
    return {list: d?.list || [], total: Number(d?.totalNum || 0), page: d?.page, pageSize: d?.pageSize};
}

const LIST_MIN_MS = 25_000;
let listCache = {at: 0, all: []};
let listInflight = null;
let listBackoffUntil = 0;

function markListBackoff(ms = 60_000) {
    listBackoffUntil = Date.now() + Math.max(10_000, ms);
}

let bitLoggedOutUntil = 0;
export function markBitLoggedOut(off = true) {
    bitLoggedOutUntil = off ? Date.now() + 3 * 60 * 1000 : 0;
}
export function isBitLoggedOut() {
    return Date.now() < bitLoggedOutUntil;
}

export async function listAllBitWindows({force = false} = {}) {
    const now = Date.now();
    if (now < listBackoffUntil && listCache.at) return listCache.all;
    if (!force && listCache.at && now - listCache.at < LIST_MIN_MS) return listCache.all;
    if (listInflight) return listInflight;
    listInflight = (async () => {
        try {
            const all = [];
            let page = 0;
            const pageSize = 100;
            while (true) {
                const {list, total} = await listBitWindows({page, pageSize});
                all.push(...list);
                if (!list.length || all.length >= total) break;
                page += 1;
            }
            listCache = {at: Date.now(), all};
            return all;
        } finally {
            listInflight = null;
        }
    })();
    return listInflight;
}

function isOurAutomationWindow(w) {
    const name = String(w?.name || "");
    const remark = String(w?.remark || "");
    return STALE_NAME_RE.test(name) || STALE_REMARKS.has(remark);
}

export async function listAutomationBitWindows() {
    const all = await listAllBitWindows();
    return all.filter(isOurAutomationWindow).map((w) => ({
        id: w.id,
        name: w.name || "",
        remark: w.remark || "",
        status: Number(w.status) || 0,
        createdTime: w.createdTime || "",
    }));
}

/** 停任务：关掉本进程登记的窗，再清自动化残留（含外部脚本开的窗）。 */
export async function stopAutomationBitWindows({includeClosed = true, log = () => {}} = {}) {
    const n1 = await closeTrackedBitWindows();
    const n2 = await sweepStaleBitWindows({keepIds: [], includeClosed, log});
    return n1 + n2;
}

/** 关掉并删除本进程登记的窗口（给 SIGINT/SIGTERM 用）。 */
export async function closeTrackedBitWindows() {
    const ids = [...liveBitIds];
    for (const id of ids) {
        await closeBitWindow(id);
        await deleteBitWindow(id);
        liveBitIds.delete(id);
    }
    return ids.length;
}

/**
 * 清掉自动化留下的比特指纹。keepIds / 当前登记的 live 窗口会留下。
 * includeClosed: 连已关但没删的配置也删掉（占会员额度）。
 */
export async function sweepStaleBitWindows({keepIds = [], includeClosed = true, log = () => {}} = {}) {
    const keep = new Set([...keepIds, ...liveBitIds].filter(Boolean));
    let windows = [];
    try { windows = await listAllBitWindows(); }
    catch (e) {
        log(`[指纹] 列举失败: ${e?.message || e}`);
        return 0;
    }
    const stale = windows.filter((w) => {
        if (!w?.id || keep.has(w.id)) return false;
        if (!includeClosed && Number(w.status) === 0) return false;
        return isOurAutomationWindow(w);
    });
    let n = 0;
    for (const w of stale) {
        if (Number(w.status) === 1) await closeBitWindow(w.id);
        await deleteBitWindow(w.id);
        n += 1;
        log(`[指纹] 清残留 ${w.name || w.id} status=${w.status}`);
    }
    return n;
}

let bitSignalsInstalled = false;
export function installBitCleanupSignals() {
    if (bitSignalsInstalled) return;
    bitSignalsInstalled = true;
    const onSignal = (sig) => {
        closeTrackedBitWindows()
            .catch(() => {})
            .finally(() => process.exit(sig === "SIGINT" ? 130 : 143));
    };
    process.on("SIGINT", () => onSignal("SIGINT"));
    process.on("SIGTERM", () => onSignal("SIGTERM"));
}
