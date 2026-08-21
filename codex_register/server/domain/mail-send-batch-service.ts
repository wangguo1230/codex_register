// @ts-nocheck
import * as db from "../db.js";
import {scheduler} from "../scheduler.js";
import {publicMailSendLog} from "./mail-send-policy.js";
import {sendMailcomViaPool} from "./mailcom-send-service.js";

// 一个 CATS 发信任务会启动独立 Chrome。默认串行，最多允许显式放宽到 2，避免多个浏览器同时把 RSS 推高。
const MAIL_SEND_CONCURRENCY_LIMIT = Math.max(
    1,
    Math.min(2, Number(process.env.MAILCOM_SEND_CONCURRENCY || 1)),
);

export function resolveMailSendConcurrency(requested, configured = scheduler.pwConcurrency, limit = MAIL_SEND_CONCURRENCY_LIMIT) {
    return Math.max(1, Math.min(Math.max(1, Number(limit) || 1), Number(requested || configured || 1)));
}

export async function sendMailcomBatch(items, {concurrency, log, shouldStop} = {} as any) {
    const list = Array.isArray(items) ? items : [];
    const cap = Math.min(resolveMailSendConcurrency(concurrency, scheduler.pwConcurrency), list.length || 1);
    const out = [];
    let i = 0;
    const workers = Array.from({length: Math.min(cap, list.length || 1)}, async () => {
        while (i < list.length) {
            const idx = i++;
            const item = list[idx];
            if (typeof shouldStop === "function" && shouldStop()) {
                out[idx] = {ok: false, email: item?.email, error: "已停止"};
                continue;
            }
            try {
                out[idx] = await sendMailcomViaPool({...item, log});
            } catch (e) {
                out[idx] = {ok: false, email: item?.email, error: String((e as Error)?.message || e).slice(0, 240)};
            }
        }
    });
    await Promise.all(workers);
    return {
        ok: out.every((x) => x?.ok),
        total: list.length,
        sent: out.filter((x) => x?.ok).length,
        failed: out.filter((x) => !x?.ok).length,
        items: out,
    };
}

export async function listMailSendLogsPublic(opts = {}) {
    const rows = await db.listMailSendLogs(opts);
    return rows.map(publicMailSendLog);
}
