// @ts-nocheck
// Gmail 改密与换 2FA 的 Worker 适配器，统一代理租约和邮箱级互斥锁。

export function createGmailMaintenanceService({
    withProxy,
    withMailboxLock,
    runWorker,
    maskProxy,
} = {}) {
    const describeProxy = (mailbox, proxyUrl, jumpUrl) =>
        `代理 ${maskProxy(proxyUrl)}（一号一代理 · ${mailbox.proxy_url ? "复用出口" : "新出口"}${jumpUrl ? " · 跳板 " + jumpUrl : ""}）`;

    async function changePassword(mailbox, newPassword, log) {
        return withProxy(mailbox.email, (proxyUrl, jumpUrl, remember) => {
            log(describeProxy(mailbox, proxyUrl, jumpUrl));
            return runWorker({
                kind: "password",
                proxyUrl,
                jumpUrl,
                newPassword,
                mailbox,
            }, {log, onProxy: remember});
        }, mailbox);
    }

    async function changeTotp(mailbox, log) {
        return withMailboxLock(mailbox.id, () => withProxy(mailbox.email, (proxyUrl, jumpUrl, remember) => {
            log(describeProxy(mailbox, proxyUrl, jumpUrl));
            return runWorker({
                kind: "totp",
                proxyUrl,
                jumpUrl,
                mailbox,
            }, {log, onProxy: remember});
        }, mailbox));
    }

    return {changePassword, changeTotp};
}
