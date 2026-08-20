// @ts-nocheck
// 单项充值提交：session、平台挑战与任务创建的状态机。
export function createRechargeSubmitter({
    getAccount,
    getAuthData,
    readAuthFile,
    extractSession,
    callApi,
    updateQueueItem,
    updateRechargeCard,
    beginSubmission,
    completeSubmission,
    failSubmission,
    cancelSubmission,
    markSubmissionUnknown,
    cardBoundToOtherAccount,
    onPaid = async () => {},
    onSubmitted = async () => {},
    log = () => {},
} = {}) {
    return async function submitOneQueueItem(item, card, label = "", {validation: validatedCard = null, account: preparedAccount = null} = {}) {
        let stage = "begin";
        let platformTask = null;
        try {
            await beginSubmission(item.id, card.id);
            stage = "session";
            const account = preparedAccount || await getAccount(item.account_id);
            const auth = getAuthData(account) || item.auth_data || readAuthFile(item.auth_file);
            const session = extractSession(auth);
            if (!session) throw new Error(`session 数据读取失败(account_id: ${item.account_id})`);
            const tokenInput = JSON.stringify(session);

            stage = "validate";
            const validation = validatedCard
                || (await callApi("POST", "/redeem-codes/validate", {redeem_code: card.code})).result
                || {};
            await updateRechargeCard(card.id, {
                plan_type: validation.plan_type || "", plan_name: validation.plan_name || "",
                product: validation.product || "", category: validation.category || "", auth_mode: validation.auth_mode || "",
            });
            if (validation.status !== "unused") throw new Error(`卡密状态异常: ${validation.status}`);
            if (cardBoundToOtherAccount(validation, item.email)) {
                throw new Error(`卡密仍绑着 ${validation.bound_email || "其他账号"}，换号核验未过，不能配给 ${item.email}`);
            }

            stage = "challenge";
            const challenge = await callApi("POST", "/submission-challenges", {
                redeem_code: card.code, token_input: tokenInput, plan_type: validation.plan_type || "",
            });
            stage = "tasks";
            const created = await callApi("POST", "/tasks", {
                redeem_code: card.code, token_input: tokenInput,
                challenge_token: challenge.challenge?.challenge_token || "",
                agreement_accepted: true, email_verified: true, plan_type: validation.plan_type || "",
            });
            const task = created.task || {};
            const taskNo = task.task_no || task.receipt_no || "";
            platformTask = {taskNo, status: String(task.status || "queued").toLowerCase(), message: task.message || ""};
            stage = "persist";
            const completion = await completeSubmission(item.id, card.id, platformTask);
            if (completion?.applied === false) {
                throw new Error(`充值任务状态未写入: ${completion.reason || "队列状态已变化"}`);
            }
            if (platformTask.status === "paid") {
                try {
                    await onPaid(item);
                } catch (error) {
                    log(`${label}? ${item.email} 已支付，但自动换绑入队失败: ${String(error?.message || error).slice(0, 120)}`);
                }
            }
            if (!(["failed", "canceled", "returned", "paid"].includes(String(platformTask.status).toLowerCase()))) {
                await onSubmitted(item).catch((error) => {
                    log(`${label}? ${item.email} 已提交，但轮询任务入队失败: ${String(error?.message || error).slice(0, 120)}`);
                });
            }
            if (["failed", "canceled", "returned"].includes(String(platformTask.status).toLowerCase())) {
                log(`${label}✗ ${item.email} 平台任务立即结束 → ${platformTask.status}: ${platformTask.message}`);
                return {ok: false, taskNo, terminal: true, taskStatus: platformTask.status};
            }
            log(`${label}✓ ${item.email} 已提交 → ${taskNo || "等待中"}`);
            return {ok: true, taskNo, paid: platformTask.status === "paid", taskStatus: platformTask.status};
        } catch (error) {
            const message = String(error?.message || error).slice(0, 200);
            if (stage === "begin" || error?.kind === "configuration") {
                let canceled = false;
                try {
                    const result = await cancelSubmission?.(item.id, card.id);
                    canceled = result?.released === true;
                } catch { /* 最终由孤儿卡回收兜底 */ }
                const failureKind = stage === "begin" ? "提交初始化失败" : "平台配置不可用";
                log(`${label}✗ ${item.email} ${failureKind}: ${message}；${canceled ? "卡密已归还" : "保留现场等待回收"}`);
                return {ok: false, stage, msg: message, retryable: true, canceled, configuration: error?.kind === "configuration"};
            }
            if (platformTask) {
                let recovered = false;
                let persistError = message;
                try {
                    const completion = await completeSubmission(item.id, card.id, platformTask);
                    recovered = completion?.applied !== false;
                    if (!recovered) persistError = String(completion?.reason || "队列状态已变化").slice(0, 200);
                } catch (retryError) {
                    persistError = String(retryError?.message || retryError).slice(0, 200);
                }
                if (recovered && platformTask.status === "paid") {
                    try {
                        await onPaid(item);
                    } catch (notifyError) {
                        log(`${label}? ${item.email} 已支付，但自动换绑入队失败: ${String(notifyError?.message || notifyError).slice(0, 120)}`);
                    }
                }
                if (recovered && !(["failed", "canceled", "returned", "paid"].includes(String(platformTask.status).toLowerCase()))) {
                    await onSubmitted(item).catch(() => {});
                }
                const terminalFailure = ["failed", "canceled", "returned"].includes(String(platformTask.status).toLowerCase());
                log(`${label}? ${item.email} 平台已接单 ${platformTask.taskNo || "等待中"}，本地事务写回失败: ${message}；${recovered ? "已通过单调事务补写" : "保留 submitting 等待平台对账"}`);
                return {ok: !terminalFailure, taskNo: platformTask.taskNo, taskStatus: platformTask.status, terminal: terminalFailure, indeterminate: true, recovered, persistError};
            }
            if (stage === "tasks" && error?.indeterminate === true) {
                if (markSubmissionUnknown) {
                    await markSubmissionUnknown(item.id, card.id, message).catch(() => {});
                } else {
                    await updateQueueItem?.(item.id, {task_status: "unknown", task_message: message}).catch(() => {});
                    await updateRechargeCard?.(card.id, {task_status: "unknown", task_message: message}).catch(() => {});
                }
                log(`${label}? ${item.email} 创建任务结果未知: ${message}；保留卡密并交给平台对账`);
                return {ok: true, indeterminate: true, stage, msg: message};
            }
            await failSubmission(item.id, card.id, {
                message,
                cardCode: card.code || item.card_code || "",
            }).catch(() => {});
            log(`${label}✗ ${item.email} 提交失败(${stage}阶段): ${message}；卡密已锁定，不给后面的号`);
            return {ok: false, stage, msg: message};
        }
    };
}
