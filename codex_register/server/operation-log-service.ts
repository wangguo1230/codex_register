// @ts-nocheck
// 操作日志端口：将账号和邮箱日志分别持久化，并发布对应实时事件。

export function createOperationLogService({store, publish, now = Date.now} = {}) {
    const write = (append, event, id, line) => {
        append(id, line).catch(() => {});
        publish(event, {id, line, ts: now()});
    };
    return {
        account: (id, line) => write(store.appendAccount, "log", id, line),
        mailbox: (id, line) => write(store.appendMailbox, "mbLog", id, line),
    };
}
