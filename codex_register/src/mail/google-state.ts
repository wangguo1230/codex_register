import {looksLikeTotpSecret} from "../mfa.js";

/**
 * Gmail 老号管理状态。
 * 目标：每号都留下「现在卡在哪、缺哪一步」，后面整备/取件/注册按缺口跑，而不是一套流程打天下。
 *
 * 阶段（stage）是给人和筛选看的；细节字段是给自动化决策看的。
 *   imported  刚导入，还没验证能不能登
 *   login_ok  能进 Google，整备还没做完
 *   login_fail 登不上（错密/验证码/插页）
 *   partial   整备做了一部分（2FA/IMAP 还没齐）
 *   ready     最低限度已齐：2FA 已换成我们的 + IMAP 通。改密/踢设备是加分项，缺了仍会重跑
 *   gpt_ok    GPT 已注册
 *   blocked   自动化过不去，要换策略或人工
 */
export const GOOGLE_STAGES = [
    "imported", "login_ok", "login_fail", "partial", "ready", "gpt_ok", "blocked",
];

export const GOOGLE_STAGE_LABEL = {
    imported: "刚导入",
    login_ok: "能登录",
    login_fail: "登不上",
    partial: "整备未齐",
    ready: "已整备",
    gpt_ok: "已注册 GPT",
    blocked: "卡住",
};

export const GOOGLE_LOGIN_ERROR_LABEL = {
    wrong_password: "密码错误",
    interstitial_doritos: "登录后插页(doritos/通行密钥)",
    captcha: "图片/人机验证",
    ssl: "SSL/代理中断",
    cf: "Cloudflare 拦截",
    workspace: "落到 Gmail 营销页",
    rejected: "出口被拒",
    login_fail: "登录失败",
    not_found: "找不到账号",
    disabled: "账号已停用",
};

const HARDEN_IP_RE = /代理中断|换 session|signin\/rejected|拒绝页|SSL\/代理|ERR_PROXY|ERR_SSL|ERR_CONNECTION|ERR_TUNNEL|邮箱页卡住/i;
const HARDEN_LOGIN_DEAD_RE = /登录失败|Wrong password|密码错误|Senha incorreta|找不到您的 Google|Couldn't find your Google|帐号已被停用|账号已停用|account has been disabled|尝试次数过多|Too many failed|This account cannot be accessed|账号已停用/i;
const HARDEN_CRED_DEAD_RE = /Wrong password|密码错误|Senha incorreta|Kata sandi salah|找不到您的 Google|Couldn't find your Google|帐号已被停用|账号已停用|account has been disabled|尝试次数过多|Too many failed|This account cannot be accessed/i;

export function isHardenIpError(msg = "") {
    return HARDEN_IP_RE.test(String(msg || ""));
}

/** 真把号判死：错密 / 找不到 / 停用 / 试太多次。笼统「登录失败」不算。 */
export function isCredentialDead(msg = "") {
    return HARDEN_CRED_DEAD_RE.test(String(msg || ""));
}

export function isHardenLoginDead(msg = "") {
    const s = String(msg || "");
    if (isHardenIpError(s)) return false;
    return HARDEN_LOGIN_DEAD_RE.test(s);
}

/** 已经登进去并做成过改密/换 2FA 的号，后一轮笼统失败不能再打成登不上。 */
export function hardenAlreadyProven(mb = {}, st = {}) {
    const s = st && typeof st === "object" ? st : {};
    return !!(s.totp_rotated || s.login === "ok" || s.password === "ok" || /^✅/.test(String(mb.pw_status || "")));
}

export function classifyHardenLoginError(msg = "") {
    const s = String(msg || "");
    if (/Wrong password|密码错误|Senha incorreta|Kata sandi salah/i.test(s)) return "wrong_password";
    if (/Couldn't find|找不到您的 Google/i.test(s)) return "not_found";
    if (/disabled|停用/i.test(s)) return "disabled";
    if (/rejected|拒绝页/i.test(s)) return "rejected";
    if (isHardenIpError(s)) return "rejected";
    return "login_fail";
}

export const HARDEN_PROXY_ROTATE_MAX = 2;
/** 同一号整备最多开窗登录次数，避免反复撞 Google。 */
export const HARDEN_ATTEMPT_MAX = 3;

export function emptyGoogleState() {
    return {
        stage: "imported",
        login: "unknown",
        login_error: "",
        phone: "unknown",
        recovery: "unknown",
        totp: "none",
        password: "unknown",
        devices: "unknown",
        imap: "none",
        gpt: "none",
        last_error: "",
        updated_at: Date.now(),
    };
}

function hasText(v) {
    return String(v || "").trim().length > 0;
}

function pickStage(s) {
    if (s.gpt === "ok") return "gpt_ok";
    if (s.login === "fail") return s.login_error || s.last_error ? "blocked" : "login_fail";
    if (s.imap === "ok" && s.totp_rotated) return "ready";
    if (s.totp_rotated || s.password === "ok") return "partial";
    if (s.login === "ok" && (s.recovery === "ok" || s.phone === "ok" || s.imap === "ok")) return "partial";
    if (s.login === "ok") return "login_ok";
    if (s.stage === "blocked") return "blocked";
    return "imported";
}

/**
 * 用库里的事实推导状态，再用 overlay 盖上跑批时亲眼看到的卡点。
 */
export function deriveGoogleState(facts = {}, overlay = {}) {
    const prev = facts.google_state && typeof facts.google_state === "object" ? facts.google_state : {};
    const s = {...emptyGoogleState(), ...prev};

    s.totp_rotated = !!(prev.totp_rotated || overlay.totp_rotated);
    s.totp = looksLikeTotpSecret(facts.totp_secret) ? "ok" : "none";
    s.imap = hasText(facts.imap_password) ? "ok" : (s.imap === "fail" ? "fail" : "none");
    s.recovery = hasText(facts.recovery_email) ? "fail" : "ok";
    if (/^✅改密/.test(String(facts.pw_status || ""))) s.password = "ok";

    const gptStatus = String(facts.gpt_status || "");
    if (gptStatus === "success") s.gpt = "ok";
    else if (gptStatus === "failed") s.gpt = "fail";
    else if (facts.usage === "gpt" && s.gpt === "none") s.gpt = "none";

    if (s.imap === "ok" || s.gpt === "ok") {
        if (s.login !== "fail") s.login = "ok";
    }

    Object.assign(s, overlay || {});
    if (overlay?.login_error && !overlay.login) s.login = "fail";
    const proven = hardenAlreadyProven(facts, s);
    if (s.login === "fail" && proven && !isCredentialDead(s.login_error || s.last_error || "")) {
        s.login = "ok";
        s.login_error = "";
    }
    if (s.login === "fail" && !s.last_error) {
        s.last_error = GOOGLE_LOGIN_ERROR_LABEL[s.login_error] || s.login_error || "登录失败";
    }
    if (proven && s.login !== "fail" && /登录失败|^登不上/.test(String(s.last_error || ""))) {
        s.last_error = hasText(facts.imap_password)
            ? (s.totp_rotated ? "" : "缺换2FA")
            : (s.totp_rotated ? "缺IMAP" : "缺2FA和IMAP");
    }
    if (s.gpt === "fail" && facts.gpt_error && !overlay.last_error) {
        s.last_error = s.last_error || String(facts.gpt_error).slice(0, 160);
    }

    s.updated_at = Date.now();
    s.stage = pickStage(s);
    return s;
}

function passwordChangedByUs(mb = {}, st = {}) {
    if (st.password === "ok") return true;
    return /^✅(改密|整备)/.test(String(mb.pw_status || ""));
}

/** 整备失败但部分步骤已做成时，任务文案要带上已做成的项。 */
export function formatHardenPartialError(r = {}) {
    const done = [
        (r.totpRotated || r.totpSecret || r.totp) && "已换2FA",
        (r.passwordChanged || r.password) && "已改密",
        (r.imapPassword || r.imap) && "已IMAP",
    ].filter(Boolean);
    const miss = (r.missing || []).filter(Boolean);
    const raw = (r.errors || [r.error]).filter(Boolean).map((e) => String(e).split("\n")[0]).join("; ");
    if (r.ok) return raw;
    if (/^部分成功/.test(raw)) return raw.slice(0, 240);
    return [done.length ? `部分成功(${done.join("/")})` : "", miss.length ? `缺${miss.join("/")}` : "", raw].filter(Boolean).join(" · ").slice(0, 240);
}

/** 再跑整备时跳过已经做成的步。换 2FA 只在本轮成功换过才跳（有卖家密钥不算）。 */
export function planHardenSkip(mb = {}) {
    const st = mb.google_state && typeof mb.google_state === "object" ? mb.google_state : {};
    const skip = {
        totp: st.totp_rotated === true,
        password: passwordChangedByUs(mb, st),
        imap: String(mb.imap_password || "").trim().length > 0,
        recovery: !String(mb.recovery_email || "").trim() || st.recovery === "ok",
        phone: st.phone === "ok",
        devices: st.devices === "ok",
    };
    skip.left = ["phone", "recovery", "imap", "totp", "password", "devices"].filter((k) => !skip[k]);
    skip.requiredLeft = skip.left.filter((k) => k === "totp" || k === "imap");
    skip.all = skip.left.length === 0;
    skip.usable = skip.requiredLeft.length === 0;
    return skip;
}

/** 把整备失败收成列表上一眼能看懂的短句。 */
export function classifyHardenIssue(raw = "") {
    const s = String(raw || "");
    if (/拒绝生成应用密码|error generating your app password/i.test(s)) return "缺IMAP·Google拒发应用密码";
    if (/未能提取应用专用密码/i.test(s)) return "缺IMAP·页面没抽出密码";
    if (/应用专用密码页二次验证未过|二次验证未过/i.test(s)) return "缺IMAP·二次验证未过";
    if (/刚换2FA|IMAP 留|下轮再取/i.test(s)) return "缺IMAP·刚换2FA下轮再取";
    if (/signin\/rejected|拒绝页/i.test(s)) return "登不上·出口被拒";
    if (/邮箱页卡住|仍在邮箱页/i.test(s)) return "登不上·邮箱页不走";
    if (/Wrong password|密码错误|Senha incorreta/i.test(s)) return "登不上·密码错";
    if (/找不到您的 Google|Couldn't find your Google/i.test(s)) return "登不上·找不到账号";
    if (/已停用|disabled/i.test(s)) return "登不上·账号停用";
    if (/reCAPTCHA|人机验证|not a robot/i.test(s)) return "登不上·人机验证";
    if (/登录失败/.test(s)) return "登不上";
    if (/窗口被关/.test(s)) return "中途关窗";
    if (/已停止/.test(s)) return "任务被停止";
    if (/SSL|代理中断|chrome-error|chromewebdata/i.test(s)) return "网络/代理中断";
    if (/比特窗口|上限/.test(s)) return "比特窗满了";
    return "";
}

/** 列表「改密状态」旁展示：缺哪一步 + 为什么。已齐则空。 */
export function formatHardenListReason(mb = {}) {
    const st = mb.google_state && typeof mb.google_state === "object" ? mb.google_state : {};
    const skip = planHardenSkip(mb);
    if (String(mb.google_stage || "") === "gpt_ok" || skip.usable) return "";
    const classified = classifyHardenIssue(st.last_error || "") || classifyHardenIssue(st.login_error || "");
    const loginDead = st.login === "fail" || mb.google_stage === "login_fail" || mb.google_stage === "blocked";
    if (loginDead) return classified || GOOGLE_LOGIN_ERROR_LABEL[st.login_error] || "登不上";
    const gap = classified.startsWith("登不上") ? "" : classified;
    const left = skip.requiredLeft || [];
    if (left.includes("imap") && left.includes("totp")) return (gap.startsWith("缺") ? gap : "") || "缺2FA和IMAP";
    if (left.includes("imap")) {
        if (Number(st.imap_gen_fail || 0) >= 3) return "缺IMAP·拒发应用密码(已停自动)";
        if (Number(st.imap_next_try || 0) > Date.now()) return gap || "缺IMAP·拒发后冷却中";
        return gap.startsWith("缺IMAP") ? gap : (gap || "缺IMAP");
    }
    if (left.includes("totp")) return gap || "缺换2FA";
    return gap;
}

/** 继续完成：还缺 2FA/IMAP 才进队。登录失败判死不再扣；出口被拒只换有限次 IP。 */
export function needsHardenRetry(mb = {}) {
    if (String(mb.google_stage || "") === "blocked") return false;
    if (String(mb.google_stage || "") === "gpt_ok") return false;
    if (String(mb.google_stage || "") === "login_fail") return false;
    const st = mb.google_state && typeof mb.google_state === "object" ? mb.google_state : {};
    if (st.login === "fail") return false;
    if (Number(st.harden_attempts || 0) >= HARDEN_ATTEMPT_MAX) return false;
    if (Number(st.proxy_rotates || 0) >= HARDEN_PROXY_ROTATE_MAX) return false;
    const skip = planHardenSkip(mb);
    if (skip.usable) return false;
    if (skip.requiredLeft.length === 1 && skip.requiredLeft[0] === "imap") {
        if (Number(st.imap_next_try || 0) > Date.now()) return false;
        if (Number(st.imap_gen_fail || 0) >= 3) return false;
    }
    return true;
}

/** 列表/详情用：按库里的 2FA+IMAP 事实出阶段，避免关窗后还停在「整备未齐」。 */
export function liveGoogleStage(mb = {}) {
    if (String(mb.google_stage || "") === "gpt_ok") return "gpt_ok";
    return deriveGoogleState(mb, {}).stage;
}

export function googleStageLabel(stage) {
    return GOOGLE_STAGE_LABEL[stage] || stage || "未知";
}

export function googleStateSummary(state) {
    const s = state && typeof state === "object" ? state : emptyGoogleState();
    const bits = [];
    bits.push(googleStageLabel(s.stage));
    if (s.login === "fail") bits.push(GOOGLE_LOGIN_ERROR_LABEL[s.login_error] || s.login_error || "登不上");
    if (s.imap === "ok") bits.push("IMAP");
    else if (s.imap === "none") bits.push("无IMAP");
    if (s.totp_rotated) bits.push("2FA已换");
    else if (s.totp === "ok") bits.push("2FA未换");
    if (s.password === "ok") bits.push("已改密");
    else bits.push("密码未换");
    if (s.devices === "ok") bits.push("已踢设备");
    else if (s.devices !== "ok") bits.push("未踢设备");
    if (s.recovery === "fail") bits.push("有辅助邮箱");
    else if (s.recovery === "ok") bits.push("辅助已清");
    if (s.gpt === "ok") bits.push("GPT");
    if (s.last_error && s.stage === "blocked") bits.push(s.last_error);
    return bits.join(" · ");
}

export function googleChecklist(state) {
    const s = state && typeof state === "object" ? state : emptyGoogleState();
    const mark = (v, okText, failText, noneText) => {
        if (v === "ok") return {ok: true, text: okText};
        if (v === "fail") return {ok: false, text: failText};
        if (v === "none") return {ok: false, text: noneText};
        return {ok: null, text: "未知"};
    };
    return [
        {key: "login", label: "登录", ...mark(s.login, "能进", GOOGLE_LOGIN_ERROR_LABEL[s.login_error] || "失败", "未验证")},
        {key: "phone", label: "恢复手机", ...mark(s.phone, "没有/已删", "还在", "未查")},
        {key: "recovery", label: "辅助邮箱", ...mark(s.recovery, "没有/已删", "还在", "未查")},
        {key: "totp", label: "Google 2FA", ...(s.totp_rotated
            ? {ok: true, text: "已换成我们的"}
            : s.totp === "ok" ? {ok: false, text: "还是卖家的"}
            : mark(s.totp, "有密钥", "失败", "没有"))},
        {key: "password", label: "密码", ...mark(s.password, "已换成我们的", "未换", "仍是卖家的")},
        {key: "devices", label: "其它设备", ...mark(s.devices, "已登出", "未登出", "跳过/未知")},
        {key: "imap", label: "IMAP 取件", ...mark(s.imap, "应用专用密码已开", "开通失败", "未开")},
        {key: "gpt", label: "GPT", ...mark(s.gpt, "已注册", "注册失败", "未注册")},
    ];
}
