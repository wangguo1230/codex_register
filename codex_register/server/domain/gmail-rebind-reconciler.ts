// @ts-nocheck
// 将不确定的换绑意图与官方当前邮箱对账，负责数据库状态收敛和邮箱补偿。

export function createGmailRebindReconciler({
    instanceId,
    claimRows,
    claimSelectedRows,
    releaseRows,
    getAccount,
    updateQueueItem,
    rebindGptMailbox,
    completeRebind,
    setMailboxNote,
    releaseMailboxToFree,
    currentLoginEmailOf,
    sync = async () => {},
    log = () => {},
} = {}) {
    let busy = false;

    async function reconcileOne(queueItem) {
        const queueId = Number(queueItem.id);
        const targetEmail = String(queueItem.rebind_attempt_email || "").trim().toLowerCase();
        const mailboxId = Number(queueItem.rebind_attempt_mailbox_id || 0);
        const account = await getAccount(queueItem.account_id);
        if (!account) {
            await updateQueueItem(queueId, {rebind_status: "fail", rebind_error: "对账失败：找不到 GPT 账号"});
            log(`对账 ✗ ${queueItem.email}: 找不到 GPT 账号`);
            return "fail";
        }
        if (!targetEmail) {
            await updateQueueItem(queueId, {rebind_status: "fail", rebind_error: "对账失败：没有换绑意图记录"});
            log(`对账 ✗ ${account.email}: 没有换绑意图记录，无法判断`);
            return "fail";
        }

        const current = await currentLoginEmailOf(account);
        if (!current.ok || !current.email) {
            await updateQueueItem(queueId, {
                rebind_error: `对账未定论: ${String(current.reason || "官方未返回邮箱").slice(0, 150)}`,
            });
            log(`对账 ? ${account.email}: ${current.reason || "官方未返回邮箱"}，保持待核对`);
            return "unknown";
        }

        const beforeEmail = String(queueItem.rebind_from || queueItem.email || account.email || "").trim().toLowerCase();
        if (current.email === targetEmail) {
            try {
                if (mailboxId && completeRebind) {
                    await completeRebind(queueId, account.id, mailboxId, {
                        fromEmail: beforeEmail,
                        destination: queueItem.rebind_target || "gmail",
                    });
                } else if (mailboxId) {
                    await rebindGptMailbox(account.id, mailboxId);
                }
            } catch (error) {
                await updateQueueItem(queueId, {
                    rebind_error: `对账回写失败: ${String(error?.message || error).slice(0, 150)}`,
                });
                log(`对账 ? ${account.email} → ${targetEmail}: 官方已改但回写失败 ${error?.message || error}，保持待核对`);
                return "unknown";
            }
            if (!mailboxId || !completeRebind) {
                await updateQueueItem(queueId, {
                    email: targetEmail,
                    rebind_status: "ok",
                    rebind_email: targetEmail,
                    ...(beforeEmail && beforeEmail !== targetEmail ? {rebind_from: beforeEmail} : {}),
                    rebind_error: "",
                    rebind_attempt_email: "",
                    rebind_attempt_mailbox_id: 0,
                    rebind_attempt_at: 0,
                    rebind_attempt_stage: "",
                });
            }
            if (mailboxId) await setMailboxNote(mailboxId, "").catch(() => {});
            log(`对账 ✓ ${beforeEmail || account.email} → ${targetEmail}: 官方确认已换绑，库已补齐`);
            return "ok";
        }

        if (mailboxId) {
            await setMailboxNote(mailboxId, "").catch(() => {});
            await releaseMailboxToFree(mailboxId).catch(() => {});
        }
        await updateQueueItem(queueId, {
            rebind_status: "fail",
            rebind_error: `官方当前是 ${current.email}，本次换绑未生效，可重新点换绑`,
            rebind_attempt_email: "",
            rebind_attempt_mailbox_id: 0,
            rebind_attempt_at: 0,
            rebind_attempt_stage: "",
        });
        log(`对账 ✗ ${account.email}: 官方当前是 ${current.email}，未换到 ${targetEmail}，该号已放回池`);
        return "fail";
    }

    async function pump() {
        if (busy) return false;
        busy = true;
        try {
            const rows = await claimRows(5, instanceId);
            if (!rows.length) return true;
            log(`换绑对账：认领 ${rows.length} 个待核对`);
            for (const row of rows) {
                try {
                    await reconcileOne(row);
                } catch (error) {
                    log(`对账异常 ${row.email || row.id}: ${error?.message || error}`);
                } finally {
                    await releaseRows([row.id], instanceId).catch(() => {});
                }
            }
            await sync();
            return true;
        } catch (error) {
            log(`换绑对账出错: ${error?.message || error}`);
            return false;
        } finally {
            busy = false;
        }
    }

    async function reconcileSelected(ids) {
        const rows = await claimSelectedRows(ids, instanceId);
        const claimedIds = rows.map((row) => Number(row.id));
        const failures = [];
        let done = 0;
        for (const row of rows) {
            try {
                await reconcileOne(row);
                done++;
            } catch (error) {
                failures.push({id: Number(row.id), email: row.email || "", reason: String(error?.message || error).slice(0, 120)});
            } finally {
                await releaseRows([row.id], instanceId).catch(() => {});
            }
        }
        if (rows.length) await sync();
        return {done, claimedIds, failures};
    }

    return {reconcileOne, reconcileSelected, pump, isBusy: () => busy};
}
