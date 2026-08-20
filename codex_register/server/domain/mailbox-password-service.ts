// @ts-nocheck
// 邮箱密码变更用例：按 provider 执行真实改密并统一落库，不负责队列调度。

export function formatMailboxPasswordStamp(now = new Date()) {
    const pad = (value) => String(value).padStart(2, "0");
    return `${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`;
}

export function createMailboxPasswordService({
    store,
    gmailMaintenance,
    withProxy,
    changeMailcomPassword,
    ensureMailcomProfile,
    randomPassword,
    sessionOf,
    maskProxy,
    stamp = formatMailboxPasswordStamp,
    syncMailboxes = async () => {},
    log = () => {},
} = {}) {
    const applyResult = async (mailboxId, {ok, newPassword, verified, detail}) => {
        const latest = await store.getMailbox(mailboxId);
        if (ok) {
            await store.setPassword(mailboxId, newPassword, `✅已改 ${stamp()}${verified ? "(验证)" : "?未验证"}`);
        } else {
            await store.setPassword(mailboxId, latest?.password ?? "", `❌试过 ${newPassword}·${String(detail).slice(0, 30)}`);
        }
        await syncMailboxes();
    };

    return async function changeMailboxPassword(mailboxId, email, oldPassword, forcedNewPassword = "") {
        const newPassword = String(forcedNewPassword || "").trim() || randomPassword(20);
        const mailbox = await store.getMailbox(mailboxId);
        log(mailboxId, `[改密] 新密码=${newPassword} provider=${mailbox?.provider || "mailcom"}`);
        try {
            const result = mailbox?.provider === "google"
                ? await gmailMaintenance.changePassword(mailbox, newPassword,
                    (message) => log(mailboxId, `[改密] ${message}`))
                : await withProxy(email, async (proxyUrl, jumpUrl) => {
                    const session = sessionOf(proxyUrl);
                    const profile = ensureMailcomProfile(mailbox?.browser_fp, proxyUrl);
                    if (mailbox?.id) store.setBrowserFingerprint(mailbox.id, profile).catch(() => {});
                    log(mailboxId, `[改密] 记住出口 ${maskProxy(proxyUrl)}${session ? ` session=${session}` : ""} tz=${profile.timezoneId}${jumpUrl ? " · 跳板" : ""}`);
                    return changeMailcomPassword(
                        email,
                        oldPassword,
                        newPassword,
                        (message) => log(mailboxId, `[改密] ${message}`),
                        {proxy: proxyUrl, jump: jumpUrl, profile},
                    );
                }, mailbox);
            const ok = !!result?.ok;
            await applyResult(mailboxId, {
                ok,
                newPassword,
                verified: result?.verified,
                detail: result?.detail || "失败",
            });
            log(mailboxId, ok ? "[改密] 成功" : `[改密] 失败(新密码 ${newPassword} 已记录)`);
            return {ok, np: newPassword, detail: result?.detail || ""};
        } catch (error) {
            const detail = String(error?.message || error);
            await applyResult(mailboxId, {ok: false, newPassword, detail});
            log(mailboxId, `[改密] 异常(新密码 ${newPassword} 已记录): ${detail}`);
            return {ok: false, np: newPassword, detail};
        }
    };
}
