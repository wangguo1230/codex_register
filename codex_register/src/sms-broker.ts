// @ts-nocheck
// 接码基础工具：拼收码链接 + 解析验证码 + 轮询收码。兼容两类接码平台：
//   1) JSON 报文(如 eccaptcha)：{"status":true,"data":{"yzm":"747353","full_sms":"...code is 747353..."}}
//   2) 纯文本报文(如 k8sms)  ："【OpenAI/ChatGPT】暂无短信,..." 或含验证码的短信原文
// 验证码统一为 6 位纯数字。

const CODE_RE = /(?<!\d)(\d{6})(?!\d)/; // 6 位纯数字(前后非数字，避免从 10 位手机号/时间戳里误截)

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

/**
 * 用接码链接【模板】+ 手机号拼出实际收码链接(eccaptcha 的 key/project 通用，只 phone 变)。
 *   - 模板含 {phone} 占位符：直接替换
 *   - 否则替换 URL 里 phone= 参数值(用户可直接粘一个后台示例链接)
 * 例: buildSmsLink("https://eccaptcha.com/api/GetVerifyCode?key=K&phone=000&project=45", "16567687998")
 *   → "https://eccaptcha.com/api/GetVerifyCode?key=K&phone=16567687998&project=45"
 */
export function buildSmsLink(template, phone) {
    const tpl = String(template || "").trim();
    const p = encodeURIComponent(String(phone || "").trim());
    if (!tpl || !p) return "";
    if (tpl.includes("{phone}")) return tpl.replace(/\{phone\}/g, p);
    if (/[?&]phone=/i.test(tpl)) return tpl.replace(/([?&]phone=)[^&]*/i, `$1${p}`);
    return ""; // 模板既无 {phone} 也无 phone= 参数 → 无法定位号码位置
}

/** 访问接码链接一次，返回原始短信报文(JSON 字符串或纯文本，供前端"测收码"展示) */
export async function peekSms(link) {
    const res = await fetch(link, {headers: {"user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"}});
    return (await res.text()).trim();
}

/**
 * 从接码报文中解析 6 位验证码；未收到/暂无短信返回 null(继续轮询)。
 * JSON 报文：优先取 data.yzm 等结构化字段，取不到再从 full_sms 短信正文提；
 *           【关键】JSON 有效但无验证码时返回 null，绝不对整段 JSON 盲跑正则(否则会误命中 phone/timestamp)。
 * 纯文本报文：直接正则提 6 位。
 */
export function extractSmsCode(raw) {
    const text = String(raw || "");
    let parsed = null;
    try { parsed = JSON.parse(text); } catch { /* 非 JSON，走纯文本分支 */ }
    if (parsed && typeof parsed === "object") {
        const d = (parsed.data && typeof parsed.data === "object") ? parsed.data : parsed;
        // 1) 结构化验证码字段(不同平台字段名兜底)，必须是 6 位纯数字
        for (const key of ["yzm", "verify_code", "vcode", "verifyCode", "sms_code", "code"]) {
            const v = d[key];
            if (v != null && /^\d{6}$/.test(String(v).trim())) return String(v).trim();
        }
        // 2) 从短信正文里提(full_sms / sms / content / message)
        const smsText = d.full_sms || d.sms || d.content || parsed.full_sms || "";
        const m = String(smsText).match(CODE_RE);
        if (m) return m[1];
        return null; // JSON 有效但暂无验证码 → 继续轮询
    }
    // 纯文本报文
    const m = text.match(CODE_RE);
    return m ? m[1] : null;
}

// 终结性错误关键词：号未注册/不在项目/无效/欠费等——继续轮询也永远不会有码，应【立即停止】不傻等
const FATAL_RE = /未注册|未登记|不存在|不在项目|无此号|号码错误|号码无效|无效号|余额不足|欠费|账户异常|项目不存在|参数错误|key\s*错误|检查\s*token|token\s*(无效|错误|失效|过期)|not\s*found|no\s*such|unregist|invalid|insufficient|no\s*project/i;
// 明确"还在等短信"的临时状态(即使 status:false 也别误判成终结错误)
const WAITING_RE = /暂无短信|暂无|等待|waiting|pending|no\s*sms|empty|没有短信|查询中|请稍后/i;

/**
 * 判定一次接码报文：有码 / 还在等 / 终结性错误。
 * 终结错误(如 eccaptcha 号未注册返回 {"status":false,"message":"网络错误"}) → 立即停止轮询，避免浪费 120s。
 */
export function classifySms(raw) {
    const text = String(raw || "");
    const code = extractSmsCode(text);
    if (code) return {kind: "code", code};
    // peekSms 自身网络异常返回"接码请求失败:..."→ 临时，继续重试(不算平台终结错误)
    if (/^接码请求失败/.test(text)) return {kind: "waiting"};
    let parsed = null;
    try { parsed = JSON.parse(text); } catch { /* 纯文本 */ }
    if (parsed && typeof parsed === "object") {
        const msg = String(parsed.message || parsed.msg || (parsed.data && parsed.data.message) || "");
        const okFlag = parsed.status === true || parsed.status === "success" || parsed.code === 200 || parsed.success === true;
        if (WAITING_RE.test(msg)) return {kind: "waiting"};
        if (FATAL_RE.test(msg)) return {kind: "fatal", reason: msg};
        // 平台明确失败(status:false / success:false)且不是"等待类"消息 → 视为终结错误(号无效/未注册/参数问题)
        if (!okFlag && msg) return {kind: "fatal", reason: msg};
        return {kind: "waiting"}; // status ok 但暂无码
    }
    // 纯文本报文
    if (WAITING_RE.test(text)) return {kind: "waiting"};
    if (FATAL_RE.test(text)) return {kind: "fatal", reason: text.slice(0, 60)};
    return {kind: "waiting"};
}

/**
 * 轮询接码链接收验证码。
 *   - 收到码 → 返回
 *   - 终结性错误(号未注册/无效/欠费) → 立即抛错停止(不傻等满 attempts)
 *   - 其余(暂无短信/临时网络) → 继续轮询
 * 超时或终结错误都抛错，由调用方决定(注意：提交手机号已成功=号已消耗时，上层不换号)。
 */
export async function fetchSmsCode(link, {attempts = 24, intervalMs = 5000, log = () => {}, excludeCode = ""} = {}) {
    let lastText = "";
    for (let i = 0; i < attempts; i += 1) {
        try {
            lastText = await peekSms(link);
        } catch (e) {
            lastText = "接码请求失败: " + (e && e.message ? e.message : e);
        }
        const r = classifySms(lastText);
        if (r.kind === "code") {
            // excludeCode:上次验证失败的旧码(短信残留),跳过它继续轮询,直到收到【新】码
            if (excludeCode && r.code === excludeCode) {
                log(`接码轮询 ${i + 1}/${attempts}: 仍是旧码 ${r.code}，等新短信…`);
                if (i < attempts - 1) { await sleep(intervalMs); continue; }
                throw new Error(`接码超时:一直是旧码 ${excludeCode}，未收到新验证码`);
            }
            log(`✅ 接码收到验证码: ${r.code}`);
            return r.code;
        }
        if (r.kind === "fatal") {
            log(`⛔ 接码终结性错误(号未注册/无效/欠费)，停止轮询: ${r.reason}`);
            throw new Error(`接码平台终结性错误(号未注册/无效): ${r.reason}`);
        }
        log(`接码轮询 ${i + 1}/${attempts}: ${lastText.slice(0, 60)}`);
        if (i < attempts - 1) await sleep(intervalMs);
    }
    throw new Error(`接码超时未收到验证码(最后返回: ${lastText.slice(0, 80)})`);
}
