// 队列终态不能单独证明卡密可复用：paid/unknown 等平台状态仍必须保留卡密关系。
export const RECHARGE_CARD_REUSE_BLOCKING_REFERENCE_SQL = `(
    COALESCE(rq.status,'pending') NOT IN ('done','error')
    OR COALESCE(LOWER(BTRIM(rq.task_status)),'') NOT IN ('','failed','canceled','returned')
)`;
