// @ts-nocheck
// 充值管理应用服务：配置、日志、卡密库存和后台验证。
import {normalizeConcurrency} from "./concurrency.js";

export function createRechargeAdminService({settings, store, logs, api, effects, getJobState, instanceId} = {}) {
    let validationRunning = false;
    let validationStopped = false;
    let resetRunning = false;

    const normalizeIds = (ids) => [...new Set((ids || []).map(Number).filter(Number.isInteger))];
    const boundedNumber = (value, min, max, fallback) => {
        const parsed = Number(value);
        if (!Number.isFinite(parsed)) return fallback;
        return Math.max(min, Math.min(max, parsed));
    };
    const loadCards = async (ids) => {
        const list = normalizeIds(ids);
        if (!list.length) return [];
        if (store.getCards) return store.getCards(list);
        return (await Promise.all(list.map((id) => store.getCard(id)))).filter(Boolean);
    };
    const refreshCards = async (final = false) => {
        if (final && effects.flushAll) return effects.flushAll();
        if (effects.scheduleAll) {
            effects.scheduleAll();
            return;
        }
        return effects.syncCards();
    };

    async function getConfig() {
        const apiKey = settings.rechargeApiKey || "";
        const [gmailFreeImap, mailcomFree] = await Promise.all([
            store.countFreeGoogleImap(),
            store.countFreeMailcom(),
        ]);
        return {
            baseUrl: settings.rechargeBaseUrl || "",
            appId: settings.rechargeAppId || "",
            apiKey: apiKey ? `${apiKey.slice(0, 6)}****${apiKey.slice(-4)}` : "",
            forwardIp: settings.rechargeForwardIp || "",
            concurrency: normalizeConcurrency(settings.rechargeConcurrency, 3),
            rebindConcurrency: normalizeConcurrency(settings.rebindConcurrency, 3),
            interval: boundedNumber(settings.rechargeInterval, 0, 60, 3),
            hasKey: !!apiKey,
            rtProxy: settings.rtProxy || "",
            rtConcurrency: normalizeConcurrency(settings.rtConcurrency, 4),
            rebindAfterPaid: settings.rebindAfterPaid || "gmail",
            rebindGmailAfterPaid: settings.rebindAfterPaid === "gmail",
            rebindGmailProbeLogin: settings.rebindGmailProbeLogin === true,
            instanceId,
            jobs: getJobState(),
            gmailFreeImap,
            mailcomFree,
        };
    }

    async function updateConfig(body = {}) {
        if (typeof body.baseUrl === "string") settings.rechargeBaseUrl = body.baseUrl.trim();
        if (typeof body.appId === "string") settings.rechargeAppId = body.appId.trim();
        if (typeof body.apiKey === "string" && body.apiKey && !body.apiKey.includes("****")) settings.rechargeApiKey = body.apiKey.trim();
        if (typeof body.forwardIp === "string") settings.rechargeForwardIp = body.forwardIp.trim();
        if (body.concurrency !== undefined) settings.rechargeConcurrency = normalizeConcurrency(body.concurrency, 3);
        if (body.rebindConcurrency !== undefined) settings.rebindConcurrency = normalizeConcurrency(body.rebindConcurrency, 3);
        if (body.interval !== undefined) settings.rechargeInterval = boundedNumber(body.interval, 0, 60, 3);
        if (typeof body.rtProxy === "string") settings.rtProxy = body.rtProxy.trim();
        if (body.rtConcurrency !== undefined) settings.rtConcurrency = normalizeConcurrency(body.rtConcurrency, 4);
        if (["off", "gmail", "mailcom"].includes(body.rebindAfterPaid)) {
            settings.rebindAfterPaid = body.rebindAfterPaid;
        } else if (typeof body.rebindGmailAfterPaid === "boolean") {
            if (body.rebindGmailAfterPaid) settings.rebindAfterPaid = "gmail";
            else if (settings.rebindAfterPaid === "gmail") settings.rebindAfterPaid = "off";
        }
        if (typeof body.rebindGmailProbeLogin === "boolean") settings.rebindGmailProbeLogin = body.rebindGmailProbeLogin;
        settings.normalizeRebindAfterPaid();
        settings.saveSettings();
        const [gmailFreeImap, mailcomFree] = await Promise.all([
            store.countFreeGoogleImap(),
            store.countFreeMailcom(),
        ]);
        return {
            ok: true,
            concurrency: settings.rechargeConcurrency,
            rebindConcurrency: settings.rebindConcurrency,
            rtConcurrency: settings.rtConcurrency,
            rebindAfterPaid: settings.rebindAfterPaid || "gmail",
            rebindGmailAfterPaid: settings.rebindAfterPaid === "gmail",
            rebindGmailProbeLogin: settings.rebindGmailProbeLogin === true,
            gmailFreeImap,
            mailcomFree,
        };
    }

    async function importCards(text, batch = "") {
        const codes = String(text || "").split(/[\r\n]+/).map((line) => line.trim()).filter(Boolean);
        if (!codes.length) return {error: "未提供卡密", status: 400};
        const result = await store.importCards(codes, String(batch || ""));
        await effects.syncCards();
        return result;
    }

    async function deleteCards(ids) {
        const result = await store.deleteCards(ids);
        await effects.syncCards();
        return {ok: true, ...result};
    }

    async function unpairCards(ids) {
        const safe = [];
        const cards = await loadCards(ids);
        for (const card of cards) {
            if (!["unused", "error"].includes(card.status)) {
                effects.log(`⚠️ 卡密 ${card.code.slice(0, 8)}... 状态为 ${card.status}，拒绝解绑(需等待平台返回结果)`);
                continue;
            }
            safe.push(card.id);
        }
        if (safe.length) {
            const changed = await store.unpairCards(safe);
            const unpaired = Number.isFinite(Number(changed)) ? Number(changed) : safe.length;
            await effects.syncCards();
            return {ok: true, unpaired, skipped: normalizeIds(ids).length - unpaired};
        }
        return {ok: true, unpaired: 0, skipped: normalizeIds(ids).length};
    }

    async function startValidation(ids) {
        if (validationRunning || resetRunning) return {error: "卡密验证或重置正在进行中", status: 409};
        validationRunning = true;
        validationStopped = false;
        let cards;
        try {
            cards = await loadCards(ids);
        } catch (error) {
            validationRunning = false;
            validationStopped = false;
            throw error;
        }
        if (!cards.length) {
            validationRunning = false;
            return {error: "无有效卡密", status: 400};
        }
        void (async () => {
            try {
                for (const card of cards) {
                    if (validationStopped) {
                        effects.log("验证已停止");
                        break;
                    }
                    if (!["unused", "error"].includes(card.status)) {
                        effects.log(`验证卡密 ${card.code.slice(0, 8)}... 跳过（本地 ${card.status}，不可改库存状态）`);
                        continue;
                    }
                    try {
                        effects.log(`验证卡密 ${card.code.slice(0, 8)}...`);
                        const data = await api.call("POST", "/redeem-codes/validate", {redeem_code: card.code});
                        const result = data.result || {};
                        const updated = await store.applyValidation(card.id, card.status, result);
                        if (!updated) {
                            effects.log(`验证卡密 ${card.code.slice(0, 8)}... 写回跳过（验证期间状态已变化）`);
                        } else if (String(result.status || "") === "unused") {
                            effects.log(`✓ ${card.code.slice(0, 8)}... → ${result.plan_name || result.plan_type || "可用"}`);
                        } else {
                            effects.log(`✗ ${card.code.slice(0, 8)}... → 平台 ${result.status || "未知"}，已保持不可用`);
                        }
                    } catch (error) {
                        effects.log(`✗ ${card.code.slice(0, 8)}... → ${error?.message || error}`);
                    }
                    await refreshCards().catch((error) => {
                        effects.log(`刷新卡密列表失败: ${String(error?.message || error).slice(0, 120)}`);
                    });
                }
                await refreshCards(true).catch((error) => {
                    effects.log(`刷新卡密最终列表失败: ${String(error?.message || error).slice(0, 120)}`);
                });
                effects.log("验证完成");
            } finally {
                validationRunning = false;
                validationStopped = false;
            }
        })().catch((error) => {
            effects.log(`验证卡密任务异常: ${String(error?.message || error).slice(0, 160)}`);
        });
        return {ok: true, count: cards.length};
    }

    async function startReset(ids) {
        if (validationRunning || resetRunning) return {error: "卡密验证或重置正在进行中", status: 409};
        resetRunning = true;
        let cards;
        try {
            cards = await loadCards(ids);
        } catch (error) {
            resetRunning = false;
            throw error;
        }
        if (!cards.length) {
            resetRunning = false;
            return {error: "未选择卡密", status: 400};
        }
        void (async () => {
            try {
                let ok = 0;
                let skip = 0;
                let fail = 0;
                for (const card of cards) {
                    if (!["unused", "error"].includes(card.status)) {
                        skip++;
                        effects.log(`重置卡密 ${card.code.slice(0, 8)}… 跳过（本地 ${card.status}，等平台终态）`);
                        continue;
                    }
                    try {
                        effects.log(`重置卡密 ${card.code.slice(0, 8)}… 问平台`);
                        const data = await api.call("POST", "/redeem-codes/validate", {redeem_code: card.code});
                        const result = data.result || {};
                        if (String(result.status || "") !== "unused") {
                            skip++;
                            effects.log(`重置卡密 ${card.code.slice(0, 8)}… 平台=${result.status || ""}，不能重置`);
                            continue;
                        }
                        const updated = await store.applyValidation(card.id, card.status, result);
                        if (!updated) {
                            skip++;
                            effects.log(`重置卡密 ${card.code.slice(0, 8)}… 写回跳过（查询期间状态已变化）`);
                            continue;
                        }
                        ok++;
                        effects.log(`✓ 卡密 ${card.code.slice(0, 8)}… 已重置为未使用（平台 unused bound=${result.bound_email || "-"} locked=${result.account_change_locked} allowed=${result.account_change_allowed ?? result.account_change_verdict?.result ?? "-"}）`);
                    } catch (error) {
                        fail++;
                        effects.log(`✗ 重置卡密 ${card.code.slice(0, 8)}… ${String(error?.message || error).slice(0, 120)}`);
                    }
                    await refreshCards().catch((error) => {
                        effects.log(`刷新卡密列表失败: ${String(error?.message || error).slice(0, 120)}`);
                    });
                }
                await refreshCards(true).catch((error) => {
                    effects.log(`刷新卡密最终列表失败: ${String(error?.message || error).slice(0, 120)}`);
                });
                effects.log(`重置卡密完成: 成功 ${ok} / 跳过 ${skip} / 失败 ${fail}`);
            } finally {
                resetRunning = false;
            }
        })().catch((error) => {
            effects.log(`重置卡密任务异常: ${String(error?.message || error).slice(0, 160)}`);
        });
        return {ok: true, count: cards.length};
    }

    return {
        listLogs: () => logs.list(),
        clearLogs: () => { logs.clear(); return {ok: true}; },
        getConfig,
        getJobs: () => getJobState(),
        updateConfig,
        listCards: () => store.listCards(),
        importCards,
        deleteCards,
        unpairCards,
        startValidation,
        startReset,
        stopValidation: () => { validationStopped = true; },
    };
}
