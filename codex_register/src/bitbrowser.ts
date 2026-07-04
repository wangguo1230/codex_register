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
    if (!j || j.success !== true) throw new Error(`比特API ${pathname} 失败: ${JSON.stringify(j).slice(0, 200)}`);
    return j.data;
}

// 健康检查(用于开关前探测比特是否在跑)
export async function bitHealth() {
    try { const r = await fetch(`${BIT_API}/health`, {method: "POST"}); const j = await r.json(); return j?.success === true; }
    catch { return false; }
}

// 创建随机指纹窗口(proxy 可选,格式 socks5://host:port 或 http://user:pass@host:port)。返回窗口 id。
export async function createBitWindow({proxy = "", name = "reg", remark = "codex-reg"} = {}) {
    const body = {
        name, remark,
        proxyMethod: 2,             // 2=自定义代理
        proxyType: "noproxy",       // 无代理时
        browserFingerPrint: {},     // 空对象=所有指纹随机(每号不同设备)
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
    return d.id;
}

// 打开窗口 → 返回 CDP 端点。data.ws 是 Playwright connectOverCDP 用的 ws:// 端点。
export async function openBitWindow(id) {
    const d = await bitPost("/browser/open", {id, args: [], loadExtensions: false, extractIp: false});
    return {ws: d.ws, http: d.http, driver: d.driver};
}

export async function closeBitWindow(id) { try { await bitPost("/browser/close", {id}); } catch { /* ignore */ } }
export async function deleteBitWindow(id) { try { await bitPost("/browser/delete", {id}); } catch { /* ignore */ } }
