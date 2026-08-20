// @ts-nocheck

function isLocalProxyHost(raw) {
    try {
        const value = String(raw || "");
        const url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? value.split("#")[0] : `socks5://${value}`);
        return url.hostname === "127.0.0.1" || url.hostname === "localhost";
    } catch {
        return false;
    }
}

export function isImapAuthDead(error) {
    return /invalid credentials|authenticationfailed|login failed|application-specific password|disabled|web login required/i.test(String(error || ""));
}

function formatLoginAge(ageMs) {
    const minutes = Math.max(0, Math.round(Number(ageMs || 0) / 60_000));
    return minutes < 1 ? "不到 1 分钟" : `${minutes} 分钟`;
}

export function createRechargeMailboxPrecheckService({store, mailbox, imap, proxy, settings, web, effects, credentials} = {}) {
    async function probeGmailImap(email, imapPassword, log = () => {}) {
        const pool = proxy.mailPool.urls.length ? proxy.mailPool : proxy.gptPool;
        const jump = proxy.mailPool.urls.length ? settings.mailJump() : (settings.gptJump() || settings.mailJump());
        const poolName = proxy.mailPool.urls.length ? "邮箱代理池" : "GPT 代理池";
        const maxExits = pool.urls.length ? 3 : 0;
        let last = {ok: false, error: "IMAP 失败"};
        for (let index = 0; index < maxExits; index++) {
            let lease = null;
            try {
                lease = await pool.lease(`imap-precheck:${email}`, {
                    fallback: "",
                    maxPerTemplate: 4,
                    freshSession: true,
                    timeoutMs: 8_000,
                });
                const exit = String(lease?.url || "").trim();
                if (!exit) break;
                log(`[imap] ${poolName} ${index + 1}/${maxExits} ${proxy.mask(exit)}${jump && !isLocalProxyHost(exit) ? "（跳板不进 3100）" : ""}`);
                last = await imap.test(email, imapPassword, {
                    extraProxies: [exit],
                    skipDirect: true,
                    includeLocals: false,
                    log,
                });
                if (last.ok || isImapAuthDead(last.error)) return last;
            } catch (error) {
                last = {ok: false, error: String(error?.message || error).slice(0, 160)};
                log(`[imap] ${poolName} 第 ${index + 1} 条租约失败: ${last.error}`);
                if (/代理池全忙|等待超时|租约空/i.test(last.error)) break;
            } finally {
                try { lease?.release(); } catch { /* */ }
            }
        }
        log("[imap] 代理池未通，回退本机 10808/10811");
        return imap.test(email, imapPassword, {skipDirect: true, log});
    }

    async function precheck(queueItem, preparedAccount = null) {
        const account = preparedAccount || await store.getAccount(queueItem.account_id);
        if (!account) return {ok: false, reason: "找不到 GPT 账号"};
        if (credentials) {
            const auth = credentials.read(account) || queueItem.auth_data;
            if (!credentials.extractSession(auth)) {
                return {ok: false, reason: "GPT session 数据缺失，需先重新登录"};
            }
        }
        if (mailbox.isGoogle(account)) {
            const imapPassword = String(account.mailbox_imap || account.imap_password || "").trim();
            if (!imapPassword) return {ok: false, reason: "Gmail 没有 IMAP 应用密码"};
            effects.log(`预检 ${account.email}: 探 Gmail IMAP（先代理池，不通再换出口）`);
            const result = await probeGmailImap(account.email, imapPassword, (message) => effects.log(`预检 ${account.email}: ${message}`));
            if (!result.ok) {
                if (imap.isTransient(result.error)) {
                    return {
                        ok: false,
                        transient: true,
                        reason: `Gmail IMAP 线路抖动 (${result.error || "Unexpected close"})，未配卡，可再提交`,
                    };
                }
                return {ok: false, reason: `Gmail IMAP 不可用 (${result.error || "不通"})`};
            }
            effects.log(`预检 ${account.email}: IMAP 通（收件箱 ${result.messages ?? 0} 封）`);
            return {ok: true};
        }
        if (mailbox.isMailcom(account)) {
            const password = String(account.password || "").trim();
            if (!password) return {ok: false, reason: "mail.com 没有邮箱密码"};
            mailbox.rememberMailcomPassword(account.email, password);
            const proxyUrl = settings.rechargeProxy();
            effects.log(`预检 ${account.email}: 验 mail.com 密码（代理=${proxyUrl ? proxy.mask(proxyUrl) : "直连"}）`);
            const result = await mailbox.verifyMailcom(
                account.email,
                password,
                (message) => effects.log(`预检 ${account.email}: ${message}`),
                {proxy: proxyUrl, tries: 1, headless: true},
            );
            if (!result.ok) {
                return {ok: false, reason: `mail.com 密码不可用 (${String(result.reason || "登录失败").slice(0, 100)})`};
            }
            effects.log(`预检 ${account.email}: mail.com 密码可用`);
        }
        return {ok: true};
    }

    const probeWebLogin = (mailboxRecord, log = () => {}, options = {}) => web.probe(mailboxRecord, log, options);

    async function probeRebindLogin(mailboxRecord, log = () => {}, options = {}) {
        const imapPassword = String(mailboxRecord?.imap_password || mailboxRecord?.mailbox_imap || "").trim();
        if (!imapPassword) return {ok: false, step: "imap", error: "无 IMAP 应用密码", dead: true};
        const recent = web.fresh(mailboxRecord);
        if (recent.fresh) {
            log(`网页登录 ${formatLoginAge(recent.ageMs)}前已验证过，1 小时内跳过开窗`);
            return {ok: true, skipped: true, skipReason: "recent"};
        }
        log("探网页登录（比特浏览器；IMAP 迁入时已探过）");
        const result = await probeWebLogin(mailboxRecord, log, options);
        if (!result.ok) {
            return {
                ok: false,
                step: "login",
                error: String(result.error || "登录失败"),
                dead: !!result.dead,
                proxyDead: !!result.proxyDead,
            };
        }
        log("网页登录 OK");
        try {
            await store.refreshGoogleState(mailboxRecord.id, {login: "ok", login_at: Date.now()});
        } catch { /* 时间戳写失败不挡换绑 */ }
        return {ok: true};
    }

    return {precheck, probeGmailImap, probeWebLogin, probeRebindLogin, isImapAuthDead};
}
