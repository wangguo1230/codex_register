// @ts-nocheck
// 卡密释放策略：只有本地双方都没有平台提交痕迹时，才允许重新进入未使用池。

export function hasRechargeSubmissionTrace(value) {
    return Boolean(
        String(value?.task_no || "").trim()
        || String(value?.task_status || "").trim()
        || Number(value?.submitted_at || 0) > 0
    );
}

export function canSafelyReleaseQueueCard(item, card) {
    if (!card) return true;
    if (!["paired", "unused"].includes(String(card.status || ""))) return false;
    const queueOwner = Number(item?.account_id || 0);
    const cardOwner = Number(card.account_id || 0);
    if (cardOwner && (!queueOwner || cardOwner !== queueOwner)) return false;
    return !hasRechargeSubmissionTrace(item) && !hasRechargeSubmissionTrace(card);
}
