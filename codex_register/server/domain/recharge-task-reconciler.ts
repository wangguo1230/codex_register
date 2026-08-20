// @ts-nocheck
// 已提交充值任务的状态收敛与卡密补偿，不负责 HTTP 轮询调度。
import {resolveRechargeTaskSettlement} from "./recharge-task-state.js";

function normalizeCode(value) {
    return String(value || "").replace(/-/g, "");
}

export function createRechargeTaskReconciler({
    lookupTasks,
    updateQueueItem,
    updateRechargeCard,
    unpairRechargeCards,
    applyResult,
    onPaid = async () => {},
    log = () => {},
} = {}) {
    return async function reconcileSubmittedTasks(items, {
        onLookup = () => {},
        onResult = () => {},
        onUnmatched = () => {},
    } = {}) {
        let settled = 0;
        const byCode = new Map();
        for (const item of items) {
            if (!item.card_code) continue;
            const key = normalizeCode(item.card_code);
            const matches = byCode.get(key) || [];
            matches.push(item);
            byCode.set(key, matches);
        }
        const codes = [...byCode.values()].map((matches) => matches[0].card_code);

        for (let offset = 0; offset < codes.length; offset += 50) {
            const data = await lookupTasks(codes.slice(offset, offset + 50));
            try { onLookup(data?.results || []); } catch { /* 观测回调不影响状态收敛 */ }
            for (const result of data?.results || []) {
                if (!result.ok) {
                    try { onResult({result, item: null, task: null, updates: null}); } catch { /* */ }
                    continue;
                }
                const task = result.task || {};
                const matches = byCode.get(normalizeCode(result.redeem_code)) || [];
                if (matches.length !== 1) {
                    if (matches.length > 1) {
                        log(`  卡密 ${result.redeem_code} 在本地匹配 ${matches.length} 个队列项，拒绝模糊收敛`);
                    }
                    try { onUnmatched({result, task}); } catch { /* */ }
                    continue;
                }
                const item = matches[0];

                const updates = {task_status: task.status || "", task_message: task.message || ""};
                const settlement = resolveRechargeTaskSettlement(task.status);
                if (task.task_no && !item.task_no) updates.task_no = task.task_no;
                if (settlement.terminal) {
                    updates.status = settlement.queueStatus;
                    updates.finished_at = settlement.finishedAt;
                } else if (item.status === "submitting") {
                    updates.status = "submitted";
                    updates.submitted_at = Date.now();
                }
                if (settlement.releaseCard) {
                    updates.card_id = 0;
                }

                const releaseCard = settlement.releaseCard;
                if (applyResult) {
                    const applied = await applyResult(item.id, item.card_id, updates, {releaseCard});
                    if (!applied?.applied) {
                        log(`  跳过 ${item.email} 的旧轮询结果: ${applied?.reason || "队列状态已变化"}`);
                        continue;
                    }
                } else {
                    await updateQueueItem(item.id, updates);
                    if (item.card_id) {
                        if (releaseCard) await unpairRechargeCards([item.card_id]);
                        else await updateRechargeCard(item.card_id, updates);
                    }
                }
                if (updates.status === "done" || updates.status === "error") settled++;
                if (item.card_id && releaseCard) log(`  卡密 ${item.card_code} 任务${task.status}，已放回未使用`);
                if (updates.status) log(`${updates.status === "done" ? "✓" : "✗"} ${item.email} → ${task.status}: ${task.message || ""}`);
                if (settlement.queueStatus === "done") {
                    try {
                        await onPaid(item);
                    } catch (error) {
                        log(`  ${item.email} 已支付，但自动换绑入队失败: ${String(error?.message || error).slice(0, 120)}`);
                    }
                }
                try { onResult({result, item, task, updates}); } catch { /* */ }
            }
        }
        return settled;
    };
}
