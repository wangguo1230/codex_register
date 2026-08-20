// @ts-nocheck
// 受限并发执行器：单项异常隔离，调用者自行处理业务错误和统计。
export async function runBoundedPool(items, worker, concurrency = 1) {
    let cursor = 0;
    const count = Math.max(1, Math.min(Number(concurrency) || 1, Math.max(1, items.length)));
    const runners = Array.from({length: count}, async () => {
        while (cursor < items.length) {
            const item = items[cursor++];
            try { await worker(item); } catch { /* 单项失败不阻断整批 */ }
        }
    });
    await Promise.all(runners);
}
