// @ts-nocheck
// 进程级异常策略：只处理已知可恢复的网络异常，其余异常保持原退出语义。

export function isImapTlsCrash(error) {
    const text = `${error?.code || ""} ${error?.reason || ""} ${error?.message || ""} ${error?.stack || ""}`;
    return /ERR_SSL_DECRYPTION_FAILED_OR_BAD_RECORD_MAC|bad record mac|tls_get_more_records|ImapFlow/i.test(text)
        && /SSL|TLS|imap/i.test(text);
}

export function installProcessErrorHandlers({runtime = process, logger = console} = {}) {
    const onUncaughtException = (error) => {
        if (isImapTlsCrash(error)) {
            logger.warn("[imap] TLS 记录损坏，已忽略（不退出进程）:", error?.message || error);
            return;
        }
        const message = `${error?.code || ""} ${error?.message || error || ""}`;
        if (/EPIPE|ECONNRESET|socks|SOCKS/i.test(message)) {
            logger.warn("[net] 忽略代理/管道异常（不退出）:", String(error?.message || error).slice(0, 160));
            return;
        }
        logger.error(error);
        runtime.exit(1);
    };

    const onUnhandledRejection = (reason) => {
        const message = String(reason?.message || reason || "");
        if (isImapTlsCrash(reason)) {
            logger.warn("[imap] TLS unhandledRejection 已忽略:", message.slice(0, 160));
            return;
        }
        logger.error("[unhandledRejection]", message.slice(0, 400));
    };

    runtime.on("uncaughtException", onUncaughtException);
    runtime.on("unhandledRejection", onUnhandledRejection);
    return () => {
        runtime.off?.("uncaughtException", onUncaughtException);
        runtime.off?.("unhandledRejection", onUnhandledRejection);
    };
}
