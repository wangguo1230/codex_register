// @ts-nocheck
import {previewDeliveredSend, testSendDelivered} from "./delivered-mail-service.js";

const sendJob = {
    running: false,
    stop: false,
    to: "",
    queued: 0,
    sent: 0,
    failed: 0,
    skipped: 0,
    error: "",
    startedAt: 0,
    finishedAt: 0,
};

function publicSendJob() {
    return {
        running: !!sendJob.running,
        stop: !!sendJob.stop,
        to: sendJob.to,
        queued: sendJob.queued,
        sent: sendJob.sent,
        failed: sendJob.failed,
        skipped: sendJob.skipped,
        error: sendJob.error,
        startedAt: sendJob.startedAt,
        finishedAt: sendJob.finishedAt,
    };
}

export function getDeliveredSendJob() {
    return publicSendJob();
}

export function stopDeliveredSend() {
    const running = !!sendJob.running;
    sendJob.stop = true;
    return {ok: true, running, ...publicSendJob()};
}

/** 立刻返回，真正发信在后台跑。前端不能把 Playwright 登录堵在一次 HTTP 里，否则代理一卡就 500。 */
export async function startTestSendDelivered(ids, opts: any = {}) {
    if (sendJob.running) throw new Error("已有测试发信在跑，先停止或等它跑完");
    const to = String(opts.to || "").trim();
    if (!to) throw new Error("请填写测试收件人");
    const list = (ids || []).map(Number).filter(Number.isInteger);
    if (!list.length) throw new Error("未选择账号");
    const preview = await previewDeliveredSend(list, to);
    const sendable = preview.items.filter((x) => x.canSend);
    if (!sendable.length) throw new Error(preview.items[0]?.reason || "没有可发的号");

    sendJob.running = true;
    sendJob.stop = false;
    sendJob.to = to;
    sendJob.queued = sendable.length;
    sendJob.sent = 0;
    sendJob.failed = 0;
    sendJob.skipped = preview.items.length - sendable.length;
    sendJob.error = "";
    sendJob.startedAt = Date.now();
    sendJob.finishedAt = 0;

    const log = typeof opts.log === "function" ? opts.log : (m) => console.log(m);
    const onDone = typeof opts.onDone === "function" ? opts.onDone : null;
    setImmediate(() => {
        testSendDelivered(sendable.map((x) => x.id), {
            ...opts,
            to,
            log,
            shouldStop: () => sendJob.stop,
        }).then((r) => {
            sendJob.sent = r.sent || 0;
            sendJob.failed = r.failed || 0;
            sendJob.skipped = r.skipped || 0;
            sendJob.error = r.ok ? "" : r.error || (r.items || []).find((x) => !x.ok && !x.skipped)?.error || "";
            onDone?.(r);
        }).catch((e) => {
            sendJob.error = String((e as Error)?.message || e).slice(0, 240);
            onDone?.({ok: false, error: sendJob.error, sent: 0, failed: sendJob.queued, skipped: sendJob.skipped, to, items: []});
        }).finally(() => {
            sendJob.running = false;
            sendJob.finishedAt = Date.now();
        });
    });

    return {
        ok: true,
        async: true,
        queued: sendable.length,
        skipped: preview.items.length - sendable.length,
        to,
        preview: preview.items,
    };
}
