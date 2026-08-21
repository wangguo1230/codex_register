// @ts-nocheck
// 单次换绑应用服务：编排认证、邮箱认领、官方换绑以及结果补偿，不负责 HTTP 和并发队列。
import {createChildProcessRegistry} from "./child-process-registry.js";

const CHANGE_NETWORK_FAILURE = /fetch failed|eligibility:|TLS|timed out|timeout|ECONN|ENOTFOUND|EPIPE|socket|Proxy connection|disconnected/i;
const VERIFY_NETWORK_FAILURE = /fetch failed|timeout|timed out|ECONN|ENOTFOUND|EPIPE|socket|TLS|disconnected|Proxy connection/i;

export function createGmailRebindExecutor({
    queueStore,
    accountStore,
    mailboxStore,
    authService,
    claimMailbox,
    changeEmail,
    currentLoginEmailOf,
    credentialStore,
    policy,
    runtime,
    effects: baseEffects,
    getAuthData,
    now = () => Date.now(),
} = {}) {
    return async function runGmailRebind(queueId, {signal, metadata} = {}) {
        let accountIdForLog = 0;
        const effects = {
            ...baseEffects,
            log: (line) => {
                baseEffects.log(line);
                if (accountIdForLog && typeof baseEffects.accountLog === "function") {
                    try { baseEffects.accountLog(accountIdForLog, line); } catch { /* 账号日志不影响换绑 */ }
                }
            },
        };
        const queueItem = await queueStore.claimExecution(queueId);
        if (!queueItem) {
            effects.log(`换绑跳过 ${queueId}: 已由其他实例处理或状态已变化`);
            return;
        }
        let reconcileRequested = false;
        const childProcesses = createChildProcessRegistry({signal});
        const operation = {signal, onChild: childProcesses.track};
        const isCancelled = () => signal?.aborted || runtime.isCancelled(queueId);
        try {
        if (isCancelled()) {
            effects.log(`换绑 ⏭ ${queueItem.email}: 已取消`);
            return;
        }
            const queued = metadata || runtime.getMetadata(queueId) || {};
        const destination = queued.target || policy.normalizeTarget(queueItem.rebind_target) || "gmail";
        const destinationLabel = policy.targetLabel(destination);
        effects.log(`换绑开始 ${queueItem.email} → ${destinationLabel}`);

        const account = await accountStore.get(queueItem.account_id);
        if (!account) {
            await queueStore.update(queueId, {rebind_status: "fail", rebind_error: "找不到 GPT 账号"});
            effects.log(`换绑 ✗ ${queueItem.email}: 找不到 GPT 账号`);
            await effects.syncQueue();
            return;
        }
        accountIdForLog = Number(account.id) || 0;

        let claimed = null;
        let claimedKept = false;
        let claimedReleased = false;
        let fresh = account;

        const releaseClaimed = async () => {
            if (!claimed?.id || claimedReleased) return;
            claimedReleased = true;
            try {
                await mailboxStore.release(claimed.id);
                runtime.liveMailboxIds.delete(claimed.id);
            } catch (error) {
                claimedReleased = false;
                throw error;
            }
        };
        const fail = async (message, release = true) => {
            if (release) await releaseClaimed();
            await queueStore.update(queueId, {
                rebind_status: "fail",
                rebind_error: String(message || "换绑失败").slice(0, 200),
                rebind_target: destination,
            });
            effects.log(`换绑 ✗ ${account.email}${claimed?.email ? " → " + claimed.email : ""}: ${message}`);
            await effects.syncQueue();
        };

        const rememberClaimed = (mailbox) => {
            if (destination === "gmail" || credentialStore.isGoogleMailbox(mailbox)) {
                credentialStore.rememberGoogle({
                    email: mailbox.email,
                    password: mailbox.password,
                    totpSecret: mailbox.totp_secret,
                    recoveryEmail: mailbox.recovery_email,
                    imapPassword: mailbox.imap_password,
                });
            } else {
                credentialStore.rememberMailcom(mailbox.email, mailbox.password);
            }
        };

        const doChange = async (accessToken, token, mailbox) => {
            await queueStore.markAttempt(queueId, {
                email: mailbox.email,
                mailboxId: mailbox.id,
                stage: "begin",
            }).catch(() => {});
            let stageWrites = Promise.resolve();
            const persistStage = (stage) => {
                const value = String(stage || "");
                stageWrites = stageWrites
                    .then(() => queueStore.update(queueId, {rebind_attempt_stage: value}))
                    .catch((error) => {
                        effects.log(`换绑 ${account.email}: 阶段 ${value || "?"} 写回失败: ${String(error?.message || error).slice(0, 120)}`);
                    });
                return stageWrites;
            };
            const result = await changeEmail({
                accessToken,
                accountId: token?.accountId || "",
                cookie: String(getAuthData(fresh)?.cookie || getAuthData(account)?.cookie || "").trim(),
                newEmail: mailbox.email,
                imapPassword: mailbox.imap_password,
                mailPassword: mailbox.password,
                totpSecret: mailbox.totp_secret || "",
                signal,
                onStage: persistStage,
                log: (message) => effects.log(`换绑 ${account.email}: ${message}`),
            });
            if (result?.stage) {
                persistStage(result.stage);
            }
            await stageWrites;
            return result;
        };

        const holdForReconcile = async (mailbox, reason) => {
            claimedKept = true;
            reconcileRequested = true;
            runtime.liveMailboxIds.delete(mailbox.id);
            await mailboxStore.setNote(mailbox.id, "换绑待核对，勿分配").catch(() => {});
            await queueStore.update(queueId, {
                    rebind_status: "unknown",
                    rebind_target: destination,
                    rebind_attempt_email: mailbox.email,
                    rebind_attempt_mailbox_id: mailbox.id,
                    rebind_error: `状态待核对: ${String(reason || "").slice(0, 150)}`,
                })
                .catch((error) => {
                    effects.log(`换绑 ${account.email}: 待对账状态写回失败: ${String(error?.message || error).slice(0, 120)}`);
                });
            effects.log(`换绑 ? ${account.email} → ${mailbox.email}: ${reason}；官方是否已改未知，挂起等对账（邮箱暂不回池）`);
            await effects.syncQueue().catch((error) => {
                effects.log(`换绑 ${account.email}: 待对账视图刷新失败: ${String(error?.message || error).slice(0, 120)}`);
            });
        };

        try {
            const prepared = await authService.prepare(account, queueItem.auth_data, operation);
            if (isCancelled() || prepared.cancelled) {
                effects.log(`换绑 ⏭ ${account.email}: 已取消`);
                return;
            }
            if (!prepared.ok) return fail(prepared.reason, false);
            fresh = prepared.fresh;
            let token = prepared.token;
            let accessToken = prepared.accessToken;

            const pool = destination === "gmail" ? (queued.pool || {}) : {};
            const excludeIds = [];
            const currentMailboxId = Number(account.mailbox_id || fresh.mailbox_id || 0);
            if (Number.isInteger(currentMailboxId) && currentMailboxId > 0) excludeIds.push(currentMailboxId);
            if (isCancelled()) {
                effects.log(`换绑 ⏭ ${account.email}: 已取消`);
                return;
            }

            const claimResult = await claimMailbox({
                dest: destination,
                pool,
                excludeIds,
                accountEmail: account.email,
                signal,
            });
            const poolHint = claimResult.poolHint || "";
            if (claimResult.ok && claimResult.mailbox) claimed = claimResult.mailbox;
            if (isCancelled()) {
                await releaseClaimed();
                effects.log(`换绑 ⏭ ${account.email}: 已取消`);
                return;
            }
            if (!claimResult.ok || !claimResult.mailbox) return fail(claimResult.error, false);
            if (!claimed) return fail(`范围内已无可用 ${destinationLabel}${poolHint}`, false);
            await queueStore.markAttempt(queueId, {
                email: claimed.email,
                mailboxId: claimed.id,
                stage: "claimed",
            }).catch(() => {});
            rememberClaimed(claimed);
            effects.log(`换绑 ${account.email} → ${claimed.email} (独立未售 ${destinationLabel})`);

            let result = await doChange(accessToken, token, claimed);
            const isNetworkFailure = (value) => CHANGE_NETWORK_FAILURE.test(String(value?.reason || ""));
            const isRateLimited = (value) => !!(value?.rateLimited || policy.isRateLimited(value?.reason));
            if (result.indeterminate) return holdForReconcile(claimed, result.reason || "verify 后失联");
            if (result.cancelled || isCancelled()) {
                await releaseClaimed();
                effects.log(`换绑 ⏭ ${account.email}: 已取消，目标邮箱已归还`);
                return;
            }
            if (!result.ok && isRateLimited(result)) {
                effects.log(`换绑 ${account.email}: 官方限流 429，停止（不再换出口/重登）`);
                return fail("官方换绑限流 429，过几分钟再点", true);
            }
            if (!result.ok && result.pwdWindowExpired) {
                effects.log(`换绑 ${account.email}: ${result.reason}`);
                return fail(String(result.reason || "取码超出官方密码验证窗口"), true);
            }
            if (!result.ok && !result.needReauth && !result.alreadyLinked && !result.badTarget && isNetworkFailure(result)) {
                effects.log(`换绑 ${account.email}: 官方换绑出口断了 (${String(result.reason || "").slice(0, 80)})，换一条再试`);
                result = await doChange(accessToken, token, claimed);
                if (result.indeterminate) return holdForReconcile(claimed, result.reason || "verify 后失联");
                if (result.cancelled || isCancelled()) {
                    await releaseClaimed();
                    effects.log(`换绑 ⏭ ${account.email}: 已取消，目标邮箱已归还`);
                    return;
                }
                if (!result.ok && isRateLimited(result)) {
                    effects.log(`换绑 ${account.email}: 官方限流 429，停止`);
                    return fail("官方换绑限流 429，过几分钟再点", true);
                }
                if (!result.ok && result.pwdWindowExpired) {
                    effects.log(`换绑 ${account.email}: ${result.reason}`);
                    return fail(String(result.reason || "取码超出官方密码验证窗口"), true);
                }
            }

            if (!result.ok && result.needReauth) {
                const refreshed = await authService.reauthenticate(account, {fresh, token, accessToken}, operation);
                if (isCancelled() || refreshed.cancelled) {
                    await releaseClaimed();
                    effects.log(`换绑 ⏭ ${account.email}: 已取消，目标邮箱已归还`);
                    return;
                }
                if (!refreshed.ok) return fail(refreshed.reason);
                fresh = refreshed.fresh;
                token = refreshed.token;
                accessToken = refreshed.accessToken;
                effects.log(`换绑 ${account.email}: 重登成功，继续向 ${claimed.email} 发换绑码`);
                result = await doChange(accessToken, token, claimed);
                if (result.indeterminate) return holdForReconcile(claimed, result.reason || "verify 后失联");
                if (result.cancelled || isCancelled()) {
                    await releaseClaimed();
                    effects.log(`换绑 ⏭ ${account.email}: 已取消，目标邮箱已归还`);
                    return;
                }
                if (!result.ok && isRateLimited(result)) {
                    effects.log(`换绑 ${account.email}: 重登后官方限流 429，停止`);
                    return fail("官方换绑限流 429，过几分钟再点", true);
                }
                if (!result.ok && result.pwdWindowExpired) {
                    effects.log(`换绑 ${account.email}: 重登后仍 ${result.reason}`);
                    return fail(String(result.reason || "取码超出官方密码验证窗口"), true);
                }
                if (!result.ok && !result.alreadyLinked && !result.badTarget && !result.needReauth && isNetworkFailure(result)) {
                    effects.log(`换绑 ${account.email}: 重登后官方换绑出口断了 (${String(result.reason || "").slice(0, 80)})，换一条再试`);
                    result = await doChange(accessToken, token, claimed);
                    if (result.indeterminate) return holdForReconcile(claimed, result.reason || "verify 后失联");
                    if (result.cancelled || isCancelled()) {
                        await releaseClaimed();
                        effects.log(`换绑 ⏭ ${account.email}: 已取消，目标邮箱已归还`);
                        return;
                    }
                    if (!result.ok && isRateLimited(result)) {
                        effects.log(`换绑 ${account.email}: 官方限流 429，停止`);
                        return fail("官方换绑限流 429，过几分钟再点", true);
                    }
                    if (!result.ok && result.pwdWindowExpired) {
                        effects.log(`换绑 ${account.email}: ${result.reason}`);
                        return fail(String(result.reason || "取码超出官方密码验证窗口"), true);
                    }
                }
            }

            if (!result.ok && !result.indeterminate
                && /^verify\b/i.test(String(result.reason || ""))
                && VERIFY_NETWORK_FAILURE.test(String(result.reason || ""))) {
                return holdForReconcile(claimed, result.reason || "verify 后失联");
            }
            if (!result.ok && result.alreadyLinked) {
                effects.log(`换绑 ${account.email}: begin 报已占用，先对账确认官方当前邮箱`);
                const current = await currentLoginEmailOf(fresh);
                const expected = String(claimed.email || "").trim().toLowerCase();
                if (current.ok && current.email && current.email === expected) {
                    effects.log(`换绑 ${account.email}: 对账确认官方已是 ${expected}，按成功记账`);
                    result = {...result, ok: true, reason: "对账确认官方已是目标邮箱"};
                } else if (!current.ok || !current.email) {
                    return holdForReconcile(claimed, `begin 报占用但对账读不到官方邮箱: ${current.reason || "未知"}`);
                }
            }

            if (result.ok) {
                claimedKept = true;
                const fromEmail = String(queueItem.rebind_from || account.email || queueItem.email || "").trim();
                try {
                    await accountStore.completeRebind(queueId, account.id, claimed.id, {fromEmail, destination});
                } catch (error) {
                    return holdForReconcile(claimed, `平台已换绑但回写失败: ${String(error?.message || error).slice(0, 100)}`);
                }
                if (destination === "gmail") {
                    await mailboxStore.refreshGoogleState(claimed.id, {gpt: "ok"}).catch(() => {});
                }
                effects.log(`换绑 ✓ ${fromEmail || account.email} → ${claimed.email}（新邮箱已售并移出换绑池，旧邮箱已售，都不回池）`);
                await effects.syncQueue().catch((error) => {
                    effects.log(`换绑 ${claimed.email}: 队列视图刷新失败: ${String(error?.message || error).slice(0, 120)}`);
                });
                await effects.syncSuccess().catch((error) => {
                    effects.log(`换绑 ${claimed.email}: 账号视图刷新失败: ${String(error?.message || error).slice(0, 120)}`);
                });
                return;
            }

            if (result.alreadyLinked || result.badTarget) {
                const tag = result.alreadyLinked ? "官方已占用" : "目标邮箱废号";
                claimedKept = true;
                await mailboxStore.quarantine(claimed.id, tag);
                runtime.liveMailboxIds.delete(claimed.id);
                claimed = null;
                return fail(`${tag}: ${String(result.reason || "").slice(0, 120)}（已标废，请再点换绑领下一个）`, false);
            }
            if (result.capped24h) {
                const until = now() + policy.capCooldownMs;
                await queueStore.update(queueId, {rebind_blocked_until: until}).catch(() => {});
                return fail(`官方 24h 换绑次数已满，${policy.formatUntil(until)} 后可再试（目标邮箱无责，已放回池）`, true);
            }
            return fail(result.reason || "换绑失败");
        } catch (error) {
            if (claimedKept && claimed) {
                reconcileRequested = true;
                const reason = String(error?.message || error).slice(0, 150);
                effects.log(`换绑 ? ${account.email} → ${claimed.email}: 成功边界后收尾失败 ${reason}；目标邮箱保持占用`);
                await queueStore.update(queueId, {
                    rebind_status: "unknown",
                    rebind_target: destination,
                    rebind_attempt_email: claimed.email,
                    rebind_attempt_mailbox_id: claimed.id,
                    rebind_error: `状态待核对: ${reason}`,
                }).catch((persistError) => {
                    effects.log(`换绑 ${account.email}: 待对账状态写回仍失败: ${String(persistError?.message || persistError).slice(0, 120)}`);
                });
            } else {
                await fail(error?.message || error);
            }
        } finally {
            if (claimed?.id) runtime.liveMailboxIds.delete(claimed.id);
            if (claimed?.id && !claimedKept) await releaseClaimed().catch(() => {});
        }
        } finally {
            childProcesses.dispose();
            await queueStore.releaseExecution(queueId).catch(() => {});
            if (reconcileRequested) effects.scheduleReconcile();
        }
    };
}
