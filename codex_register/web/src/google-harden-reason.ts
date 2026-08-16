/** 列表一眼能看的整备原因。只认邮箱对象上已有字段，不引服务端模块。 */
export function classifyHardenIssue(raw = "") {
    const s = String(raw || "");
    if (/听写验证|type the text you hear/i.test(s)) return "登不上·听写验证";
    if (/页面故障|Something went wrong 消不掉/i.test(s)) return "登不上·页面故障";
    if (/要验证辅助邮箱|Confirm your recovery/i.test(s)) return "登不上·要验证辅助邮箱";
    if (/密码页过不去|Loading Welcome/i.test(s)) return "登不上·密码页过不去";
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

export function formatHardenListReason(mb: {
    google_stage?: string;
    google_state?: {
        last_error?: string;
        login_error?: string;
        login?: string;
        totp_rotated?: boolean;
        imap_gen_fail?: number;
        imap_next_try?: number;
    } | null;
    totp_secret?: string;
    imap_password?: string;
    pw_status?: string;
} = {}) {
    const st = mb.google_state && typeof mb.google_state === "object" ? mb.google_state : {};
    const usable = !!(st.totp_rotated && String(mb.imap_password || "").trim());
    if (String(mb.google_stage || "") === "gpt_ok" || usable) return "";
    const classified = classifyHardenIssue(st.last_error || "") || classifyHardenIssue(st.login_error || "");
    const loginDead = st.login === "fail" || mb.google_stage === "login_fail" || mb.google_stage === "blocked";
    if (loginDead) return classified || "登不上";
    const gap = classified.startsWith("登不上") ? "" : classified;
    const needTotp = !st.totp_rotated;
    const needImap = !String(mb.imap_password || "").trim();
    if (needImap && needTotp) return (gap.startsWith("缺") ? gap : "") || "缺2FA和IMAP";
    if (needImap) {
        if (Number(st.imap_gen_fail || 0) >= 3) return "缺IMAP·拒发应用密码(已停自动)";
        if (Number(st.imap_next_try || 0) > Date.now()) return gap || "缺IMAP·拒发后冷却中";
        return gap.startsWith("缺IMAP") ? gap : (gap || "缺IMAP");
    }
    if (needTotp) return gap || "缺换2FA";
    return gap;
}

/** 列表一眼：可用=已换我们的 2FA + 有 IMAP。缺换 2FA 必须处理。 */
export type GmailHealth = "ok" | "need_totp" | "need_imap" | "need_both" | "login_dead";

export const GMAIL_HEALTH_LABEL: Record<GmailHealth, string> = {
    ok: "可用",
    need_totp: "缺换2FA",
    need_imap: "缺IMAP",
    need_both: "缺2FA和IMAP",
    login_dead: "登不上",
};

export const GMAIL_HEALTH_COLOR: Record<GmailHealth, string> = {
    ok: "#059669",
    need_totp: "#c2410c",
    need_imap: "#d97706",
    need_both: "#b45309",
    login_dead: "#dc2626",
};

export function gmailHealth(mb: {
    google_stage?: string;
    google_state?: {totp_rotated?: boolean; login?: string} | null;
    imap_password?: string;
} = {}): GmailHealth {
    const st = mb.google_state && typeof mb.google_state === "object" ? mb.google_state : {};
    const totp = !!st.totp_rotated;
    const imap = !!String(mb.imap_password || "").trim();
    if (String(mb.google_stage || "") === "gpt_ok" || (totp && imap)) return "ok";
    if (imap && !totp) return "need_totp";
    if (totp && !imap) return "need_imap";
    const loginDead = st.login === "fail" || mb.google_stage === "login_fail" || mb.google_stage === "blocked";
    if (loginDead) return "login_dead";
    return "need_both";
}
