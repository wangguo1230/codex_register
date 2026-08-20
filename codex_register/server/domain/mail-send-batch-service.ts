// @ts-nocheck
import * as db from "../db.js";
import {scheduler} from "../scheduler.js";
import {publicMailSendLog} from "./mail-send-policy.js";
import {sendMailcomViaPool} from "./mailcom-send-service.js";

export async function sendMailcomBatch(items, {concurrency, log, shouldStop} = {} as any) {
    const list = Array.isArray(items) ? items : [];
    const cap = Math.max(1, Math.min(8, Number(concurrency || scheduler.pwConcurrency || 1)));
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

