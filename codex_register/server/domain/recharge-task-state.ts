// @ts-nocheck
// 充值平台任务状态的单调转换规则，不包含数据库和网络职责。

const TERMINAL_TASK_STATUSES = new Set(["paid", "failed", "canceled", "returned"]);
const TERMINAL_FAILURE_STATUSES = new Set(["failed", "canceled", "returned"]);

export function resolveRechargeTaskSettlement(status, now = Date.now) {
    const normalized = String(status || "").toLowerCase();
    if (normalized === "paid") {
        return {
            terminal: true,
            releaseCard: false,
            queueStatus: "done",
            cardStatus: "done",
            finishedAt: now(),
        };
    }
    if (TERMINAL_FAILURE_STATUSES.has(normalized)) {
        return {
            terminal: true,
            releaseCard: true,
            queueStatus: "error",
            cardStatus: "unused",
            finishedAt: now(),
        };
    }
    return {
        terminal: false,
        releaseCard: false,
        queueStatus: "submitted",
        cardStatus: "submitted",
        finishedAt: 0,
    };
}

function taskRank(status) {
    if (TERMINAL_TASK_STATUSES.has(status)) return 3;
    if (["processing", "running"].includes(status)) return 2;
    if (["queued", "pending", "unknown"].includes(status)) return 1;
    return 0;
}

export function resolveRechargeTaskTransition(current, updates, now = Date.now) {
    const currentStatus = String(current?.status || "");
    const currentTaskStatus = String(current?.task_status || "").toLowerCase();
    const incomingTaskStatus = String(updates?.task_status || "").toLowerCase();
    if (currentStatus === "done" || currentTaskStatus === "paid") {
        return {applied: false, reason: "队列已完成，忽略旧轮询结果"};
    }
    if (currentStatus === "error" || TERMINAL_TASK_STATUSES.has(currentTaskStatus)) {
        return {applied: false, reason: "队列已到失败终态，忽略旧轮询结果"};
    }
    const effectiveUpdates = {...updates};
    if (taskRank(incomingTaskStatus) < taskRank(currentTaskStatus)) {
        delete effectiveUpdates.task_status;
        delete effectiveUpdates.task_message;
    }
    if (!effectiveUpdates.status && ["submitting", "submitted"].includes(currentStatus)
        && incomingTaskStatus && !TERMINAL_TASK_STATUSES.has(incomingTaskStatus)) {
        effectiveUpdates.status = "submitted";
        if (!Number(current?.submitted_at || 0)) effectiveUpdates.submitted_at = now();
    }
    return {applied: true, updates: effectiveUpdates};
}
