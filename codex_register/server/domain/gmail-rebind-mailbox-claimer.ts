// @ts-nocheck
// 换绑目标邮箱认领器：候选筛选、原子预占、可选探活以及失败补偿。

export function createRebindMailboxClaimer({
    listGmailCandidates,
    claimGmail,
    claimMailcom,
    explainGmailMiss,
    releaseMailbox,
    markGmailUnavailable,
    quarantineMailbox,
    refreshGoogleState,
    probeGmailLogin,
    shouldProbeGmailLogin,
    poolHintOf,
    liveMailboxIds,
    now = () => Date.now(),
    log = () => {},
} = {}) {
    return async function claimRebindMailbox({dest, pool = {}, excludeIds = [], accountEmail = "", signal} = {}) {
        const poolHint = dest === "gmail" ? poolHintOf(pool) : "";
        if (dest === "mailcom") {
            const mailbox = await claimMailcom();
            return mailbox
                ? {ok: true, mailbox, poolHint}
                : {ok: false, mailbox: null, poolHint, error: "没有独立且未使用的 mail.com（邮箱管理 · 独立）"};
        }

        const candidates = await listGmailCandidates({grp: pool.grp, emails: pool.emails, excludeIds});
        let mailbox = null;
        for (const row of candidates) {
            if (!row || excludeIds.includes(row.id)) continue;
            const claimed = await claimGmail(row.id, {
                grp: pool.grp,
                emails: pool.emails,
                excludeIds,
            });
            if (claimed) {
                mailbox = claimed;
                break;
            }
        }
        if (!mailbox) {
            let error = `没有独立且未使用、已开 IMAP 的 Gmail（邮箱管理 · 独立 / 换绑池）${poolHint}`;
            if (pool.emails?.length) {
                const detail = await explainGmailMiss(pool.emails).catch(() => "");
                if (detail) error = `${error}；${detail}`;
            }
            return {ok: false, mailbox: null, poolHint, error};
        }

        liveMailboxIds.add(mailbox.id);
        let probe = {ok: true, skipped: true, skipReason: "config"};
        if (shouldProbeGmailLogin()) {
            log(`换绑 ${accountEmail} → ${mailbox.email}：已预占，探登录${poolHint}`);
            probe = await probeGmailLogin(
                mailbox,
                (message) => log(`换绑 ${accountEmail}: ${message}`),
                {signal},
            );
        } else {
            log(`换绑 ${accountEmail} → ${mailbox.email}：已预占，跳过比特网页登录探活（IMAP 已验证）${poolHint}`);
        }

        if (!probe.ok) {
            const step = probe.step === "login" ? "登录" : "IMAP";
            const dead = !!probe.dead;
            if (probe.proxyDead && !dead) {
                log(`换绑 ${mailbox.email} 登录探活出口问题 (${probe.error})，号仍可用、放回池`);
                await releaseMailbox(mailbox.id);
                liveMailboxIds.delete(mailbox.id);
                return {
                    ok: false,
                    mailbox: null,
                    poolHint,
                    error: `Gmail 登录探活出口问题: ${String(probe.error || "").slice(0, 100)}（未标废）`,
                };
            }
            log(`换绑 ${mailbox.email} 不可用 ${step}失败 (${probe.error})，${dead ? "标已售废号" : "放回池"}`);
            if (dead) {
                if (probe.step === "login") {
                    await markGmailUnavailable([mailbox.id], `登录失败: ${String(probe.error || "").slice(0, 60)}`).catch(() => {});
                } else {
                    await quarantineMailbox(mailbox.id, "IMAP不通");
                    try {
                        await refreshGoogleState(mailbox.id, {
                            imap: "fail",
                            last_error: String(probe.error || "").slice(0, 120),
                        });
                    } catch { /* 阶段标记失败不改变隔离结果 */ }
                }
                liveMailboxIds.delete(mailbox.id);
            } else {
                await releaseMailbox(mailbox.id);
                liveMailboxIds.delete(mailbox.id);
            }
            return {
                ok: false,
                mailbox: null,
                poolHint,
                error: `${step}失败: ${String(probe.error || "").slice(0, 120)}`,
            };
        }

        if (!probe.skipped) {
            try {
                await refreshGoogleState(mailbox.id, {login: "ok", login_at: now()});
            } catch { /* 时间戳写失败不挡换绑 */ }
        }
        log(probe.skipped
            ? (probe.skipReason === "recent"
                ? `换绑 ${mailbox.email} 登录 1 小时内已验证，跳过开窗`
                : `换绑 ${mailbox.email} 跳过网页登录探活（按配置）`)
            : `换绑 ${mailbox.email} 登录 OK`);
        return {ok: true, mailbox, poolHint};
    };
}
