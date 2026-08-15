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
    ready: "可取件",
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
};

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
    if (s.stage === "blocked") return "blocked";
    if (s.imap === "ok" && s.totp_rotated) return "ready";
    if (s.login === "ok" && (s.password === "ok" || s.recovery === "ok" || s.phone === "ok" || s.imap === "ok" || s.totp_rotated)) return "partial";
    if (s.login === "ok") return "login_ok";
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
    if (s.login === "fail" && !s.last_error) {
        s.last_error = GOOGLE_LOGIN_ERROR_LABEL[s.login_error] || s.login_error || "登录失败";
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
    return /^✅改密/.test(String(mb.pw_status || ""));
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
    skip.left = ["phone", "recovery", "totp", "imap", "password", "devices"].filter((k) => !skip[k]);
    skip.requiredLeft = skip.left.filter((k) => k === "totp" || k === "imap");
    skip.all = skip.left.length === 0;
    skip.usable = skip.requiredLeft.length === 0;
    return skip;
}

/** 任一缺口（含改密/踢设备加分项）都应触发重跑。 */
export function needsHardenRetry(mb = {}) {
    return !planHardenSkip(mb).all;
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
