// @ts-nocheck
// 已认领邮箱任务执行器：分派改密、2FA、整备并收敛任务结果，不负责认领和槽位计算。

function parsePayload(job) {
    const payload = job?.payload;
    if (!payload) return {};
    if (typeof payload === "string") {
        try { return JSON.parse(payload); } catch { return {}; }
    }
    return payload;
}

export function createMailJobExecutor({
    store,
    services,
    classifiers,
    runtime,
    effects,
    instanceId,
} = {}) {
    return async function runClaimedMailJob(job) {
        runtime.localMailboxIds.add(job.mailbox_id);
        try {
            const kind = String(job.kind || "harden");
            if (kind === "pw") {
                const payload = parsePayload(job);
                const result = await services.changePassword(
                    job.mailbox_id,
                    job.email,
                    payload.oldPw || "",
                    payload.newPassword || "",
                );
                await store.complete(job.id, !!result.ok, result.detail || "", {newPassword: result.np || ""});
                if (result.ok && payload.afterAllocate?.usage) {
                    try {
                        await store.allocateMailbox(
                            payload.afterAllocate.usage,
                            [job.mailbox_id],
                            payload.afterAllocate.batch || "",
                        );
                        await effects.syncAccounts();
                    } catch (error) {
                        effects.warn("[mail-jobs] 改密后分配失败:", error?.message || error);
                    }
                }
            } else if (kind === "2fa") {
                const mailbox = await store.getMailbox(job.mailbox_id);
                if (!mailbox) throw new Error("邮箱不存在");
                const result = await services.changeTotp(mailbox, (message) => {
                    effects.logMailbox(job.mailbox_id, `[2FA] ${message}`);
                    store.setLine(job.id, String(message).slice(0, 140)).catch(() => {});
                });
                if (result?.ok && result.totpSecret) {
                    const committed = await store.commitTotp(job.mailbox_id, result.totpSecret, mailbox.totp_secret);
                    if (committed.ok) {
                        await store.complete(job.id, true, "", {totpSecret: committed.totp || result.totpSecret});
                    } else {
                        await store.complete(
                            job.id,
                            false,
                            committed.reason === "stale"
                                ? "库里已是其他实例验证过的 2FA"
                                : (result?.error || "2FA 落库失败"),
                        );
                    }
                } else {
                    await store.complete(job.id, false, result?.error || "2FA 失败");
                }
            } else {
                const result = await services.harden(job.mailbox_id, {jobId: job.id});
                const error = classifiers.formatHardenError(result);
                if (!result.ok && classifiers.isBitTransient(error)) {
                    await services.parkForBitDown(error);
                    await store.requeue(job.id, "比特异常，退回排队");
                } else if (!result.ok && classifiers.isProxyInfra(error)) {
                    await store.requeue(job.id, "跳板/代理异常，退回排队");
                } else {
                    await store.complete(job.id, !!result.ok, error, {
                        instanceId,
                        imap: !!result.imapPassword || !!result.imap,
                        totp: !!result.totpSecret,
                        totpRotated: !!result.totpRotated,
                        password: !!result.passwordChanged,
                        recovery: !!result.recoveryCleared,
                        phone: !!result.phoneCleared,
                        devices: !!result.devicesDone,
                        missing: result.missing || [],
                        errors: (result.errors || []).map((item) => String(item).split("\n")[0].slice(0, 120)),
                        skipped: !!result.skipped,
                    });
                }
            }
        } catch (error) {
            const message = String(error?.message || error);
            if (classifiers.isBitTransient(message)) {
                await services.parkForBitDown(message);
                await store.requeue(job.id, "比特异常，退回排队").catch(() => {});
            } else if (classifiers.isProxyInfra(message)) {
                await store.requeue(job.id, "跳板/代理异常，退回排队").catch(() => {});
            } else {
                await store.complete(job.id, false, message).catch(() => {});
            }
        } finally {
            runtime.localMailboxIds.delete(job.mailbox_id);
            runtime.abortControllers.delete(job.mailbox_id);
            runtime.current.delete(job.mailbox_id);
            effects.scheduleBroadcast();
            effects.scheduleNext();
        }
    };
}
