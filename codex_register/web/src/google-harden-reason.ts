/** 列表一眼能看的整备原因。只认邮箱对象上已有字段，不引服务端模块。 */
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
    if (st.login === "fail" || mb.google_stage === "login_fail" || mb.google_stage === "blocked") {
        return classified || "登不上";
    }
    const needTotp = !st.totp_rotated;
    const needImap = !String(mb.imap_password || "").trim();
    if (needImap && needTotp) return classified || "缺2FA和IMAP";
    if (needImap) {
        if (Number(st.imap_gen_fail || 0) >= 3) return "缺IMAP·拒发应用密码(已停自动)";
        if (Number(st.imap_next_try || 0) > Date.now()) return classified || "缺IMAP·拒发后冷却中";
        return classified.startsWith("缺IMAP") ? classified : (classified || "缺IMAP");
    }
    if (needTotp) return classified || "缺换2FA";
    return classified;
}
