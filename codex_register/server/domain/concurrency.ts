// 并发配置规范化：只保证可执行的正整数，不设置业务侧隐藏上限。
export function normalizeConcurrency(value: unknown, fallback = 1): number {
    const fallbackValue = Number(fallback);
    const safeFallback = Number.isFinite(fallbackValue) && fallbackValue >= 1
        ? Math.floor(fallbackValue)
        : 1;
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return safeFallback;
    return Math.max(1, Math.floor(parsed));
}
