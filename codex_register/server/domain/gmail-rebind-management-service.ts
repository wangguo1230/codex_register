// @ts-nocheck
// Gmail 换绑管理应用服务：池迁入/降级、排队、取消和人工对账。
import {normalizeConcurrency} from "./concurrency.js";

export function createGmailRebindManagementService({store, probes, queue, reconcile, policy, runPool, effects, defaultTarget, concurrency = () => 6} = {}) {
    const counts = async () => {
        const [gmailFreeImap, mailcomFree] = await Promise.all([
            store.countFreeGoogleImap(),
            store.countFreeMailcom(),
        ]);
        return {gmailFreeImap, mailcomFree};
    };
    const inInputOrder = (ids, rows) => {
        const byId = new Map((rows || []).map((row) => [Number(row.id), row]));
        return ids.map((id) => byId.get(Number(id)));
    };
    const loadMailboxes = async (ids) => inInputOrder(
        ids,
        store.getMailboxes
            ? await store.getMailboxes(ids)
            : (await Promise.all(ids.map((id) => store.getMailbox(id)))).filter(Boolean),
    );
    const loadQueueItems = async (ids) => inInputOrder(
        ids,
        store.getQueues
            ? await store.getQueues(ids)
            : (await Promise.all(ids.map((id) => store.getQueue(id)))).filter(Boolean),
    );

    async function markUnavailable(ids, reason = "登录不可用") {
        if (!ids.length) return {error: "未选择邮箱", status: 400};
        const normalized = String(reason || "登录不可用").slice(0, 80);
        const count = await store.markUnavailable(ids, normalized);
        effects.log(`Gmail 池：标记不可用 ${count} 个（${normalized}）`);
        return {ok: true, count, ...await counts()};
    }

    async function migrate(ids, {probeImap = true, probeLogin = false, imapConcurrency} = {}) {
        if (!ids.length) return {error: "未选择邮箱", status: 400};
        const probeConcurrency = normalizeConcurrency(imapConcurrency ?? concurrency(), 6);
        const blocked = new Set();
        const skipped = [];
        const movedIds = [];
        const rows = [];
        const mailboxes = await loadMailboxes(ids);
        for (const [index, id] of ids.entries()) {
            const mailbox = mailboxes[index];
            if (!mailbox) {
                skipped.push({id, email: "", reason: "不存在"});
                blocked.add(id);
            } else if (!String(mailbox.password || "").trim()) {
                skipped.push({id, email: mailbox.email, reason: "无登录密码"});
                blocked.add(id);
            } else if (!String(mailbox.totp_secret || "").trim()) {
                skipped.push({id, email: mailbox.email, reason: "无 Gmail 2FA（最低准则）"});
                blocked.add(id);
            } else if (!String(mailbox.imap_password || "").trim()) {
                skipped.push({id, email: mailbox.email, reason: "无 IMAP（最低准则）"});
                blocked.add(id);
            } else {
                rows.push(mailbox);
            }
        }

        const moveNow = async (mailbox) => {
            if (blocked.has(mailbox.id) || movedIds.includes(mailbox.id)) return false;
            const moved = await store.moveToPool([mailbox.id]);
            if ((moved?.count || 0) > 0) {
                movedIds.push(mailbox.id);
                effects.log(`迁入成功 ${mailbox.email} →「${store.poolGroup}」（已 ${movedIds.length} 个）`);
                return true;
            }
            const reason = moved?.skipped?.[0]?.reason || "不满足迁入条件";
            skipped.push({id: mailbox.id, email: mailbox.email, reason});
            blocked.add(mailbox.id);
            effects.log(`迁入失败 ${mailbox.email}: ${reason}`);
            return false;
        };

        const handleFailure = async (mailbox, result) => {
            const step = result.step === "login" ? "登录" : "IMAP";
            const reason = `${step}不通: ${String(result.error || "失败").slice(0, 80)}`;
            const dead = !!result.dead;
            const transient = result.step === "imap" && probes.isImapTransient(result.error) && !dead;
            skipped.push({id: mailbox.id, email: mailbox.email, reason});
            blocked.add(mailbox.id);
            try {
                await store.refreshGoogleState(mailbox.id, result.step === "login"
                    ? {login: "fail", last_error: reason.slice(0, 120), ...(dead ? {stage: "login_fail"} : {})}
                    : {imap: "fail", last_error: reason.slice(0, 120)});
            } catch { /* 状态观测失败不改变迁入判定 */ }
            if (dead) {
                if (result.step === "login") await store.markUnavailable([mailbox.id], reason.slice(0, 80)).catch(() => {});
                else await store.quarantine(mailbox.id, "IMAP不通").catch(() => {});
                effects.log(`迁入拒绝 ${mailbox.email}: ${reason}（已标废）`);
            } else {
                effects.log(`迁入拒绝 ${mailbox.email}: ${reason}${transient ? "（已标 IMAP 失败·可重试）" : "（已标记）"}`);
            }
        };

        if (probeImap && rows.length) {
            effects.log(`Gmail 池：并行探 IMAP 并边探边迁 ${rows.length} 个（并发 ${probeConcurrency}）`);
            await runPool(rows, async (mailbox) => {
                if (blocked.has(mailbox.id)) return;
                const result = await probes.imap(mailbox.email, mailbox.imap_password, {
                    log: (message) => effects.log(`迁入探 IMAP ${mailbox.email}: ${message}`),
                });
                if (result.ok) {
                    try { await store.refreshGoogleState(mailbox.id, {imap: "ok"}); } catch { /* */ }
                    if (!probeLogin) await moveNow(mailbox);
                } else {
                    const error = String(result.error || "IMAP 不通");
                    await handleFailure(mailbox, {step: "imap", error, dead: probes.isImapAuthDead(error)});
                }
            }, probeConcurrency);
        } else if (!probeLogin) {
            for (const mailbox of rows) await moveNow(mailbox);
        }

        if (probeLogin) {
            await runPool(rows, async (mailbox) => {
                if (blocked.has(mailbox.id) || movedIds.includes(mailbox.id)) return;
                const result = await probes.login(mailbox, (message) => effects.log(`迁入探登录 ${mailbox.email}: ${message}`));
                if (result.ok) {
                    try { await store.refreshGoogleState(mailbox.id, {login: "ok", login_at: Date.now()}); } catch { /* */ }
                    await moveNow(mailbox);
                } else {
                    await handleFailure(mailbox, {step: "login", error: String(result.error || "登录失败"), dead: !!result.dead});
                }
            }, probeConcurrency);
        }

        const probeNote = probeLogin ? "IMAP+登录" : (probeImap ? "IMAP" : "仅字段");
        effects.log(`Gmail 池：本批迁入「${store.poolGroup}」 ${movedIds.length} 个${skipped.length ? `，拒绝 ${skipped.length}` : ""}（${probeNote}；通的已即时入池）`);
        return {
            ok: true,
            count: movedIds.length,
            skipped,
            movedIds,
            poolGrp: store.poolGroup,
            ...await counts(),
        };
    }

    async function demote(ids, group = "") {
        if (!ids.length) return {error: "未选择邮箱", status: 400};
        const normalized = String(group || "");
        const count = await store.moveFromPool(ids, normalized);
        effects.log(`Gmail 池：移出「${store.poolGroup}」 ${count} 个 →「${normalized || "无分组"}」`);
        return {ok: true, count, ...await counts()};
    }

    async function enqueue(ids, input = {}) {
        if (!ids.length) return {error: "未选择队列项", status: 400};
        const target = policy.normalizeTarget(input.target);
        const allowDelivered = input.allowDelivered === true;
        let pool = policy.normalizePool(input, policy.extractEmails);
        if (target !== "mailcom" && !pool.emails?.length && pool.grp === undefined) pool = {grp: store.poolGroup};
        const skipped = [];
        let queued = 0;
        const items = await loadQueueItems(ids);
        for (const [index, id] of ids.entries()) {
            const item = items[index];
            if (!item) {
                skipped.push({email: String(id), reason: "不存在"});
                continue;
            }
            if (item.rebind_status === "pending" && queue.has(id)) {
                skipped.push({email: item.email, reason: "换绑中"});
                continue;
            }
            if (item.task_status !== "paid" && item.status !== "done") {
                skipped.push({email: item.email, reason: `未付费(${item.task_status || item.status || "—"})`});
                continue;
            }
            const destination = policy.resolveTarget(item, {force: true, target, defaultTarget: defaultTarget()});
            if (String(item.delivery_status || "undelivered") === "delivered"
                && (!allowDelivered || destination !== "gmail")) {
                skipped.push({
                    email: item.email,
                    reason: allowDelivered ? "已交付记录仅支持人工换绑 Gmail" : "已交付记录需明确开启人工换绑",
                });
                continue;
            }
            if (await queue.enqueue(item, {force: true, target: destination, pool})) {
                queued++;
                const hint = destination === "gmail" ? policy.poolHint(pool) : "";
                effects.log(`换绑排队 ${item.email} → ${policy.targetLabel(destination)}${hint ? hint.replace(/^，范围=/, "（") + "）" : ""}`);
            } else {
                skipped.push({email: item.email, reason: "已在换绑"});
            }
        }
        await effects.syncQueue();
        return {ok: true, queued, skipped, ...await counts()};
    }

    async function cancel(ids) {
        if (!ids.length) return {error: "未选择队列项", status: 400};
        let count = 0;
        const skipped = [];
        const items = await loadQueueItems(ids);
        for (const [index, id] of ids.entries()) {
            const item = items[index];
            if (!item || item.rebind_status !== "pending") continue;
            const result = queue.cancel(id);
            if (result.found) {
                await store.updateQueue(id, {rebind_status: "fail", rebind_error: "已取消换绑", rebind_pool: null});
            } else if (!await store.cancelUnclaimed(id)) {
                skipped.push({email: item.email, reason: `已由实例 ${item.rebind_instance || "其他实例"} 执行，无法跨实例中止`});
                effects.log(`换绑取消跳过 ${item.email}: 已由其他实例执行`);
                continue;
            }
            effects.log(`换绑已取消 ${item.email}${result.active ? "（当前任务将在下一步停下）" : ""}`);
            count++;
        }
        await effects.syncQueue();
        return {ok: true, count, skipped};
    }

    async function reconcileNow(ids) {
        if (!ids.length) {
            const pending = await store.countReconcile();
            if (!pending) return {ok: true, pending: 0, message: "没有待核对的换绑"};
            void reconcile.pump();
            return {ok: true, pending, message: `已开始对账 ${pending} 个待核对换绑`};
        }
        const skipped = [];
        const candidates = [];
        const byId = new Map();
        const items = await loadQueueItems(ids);
        for (const [index, id] of ids.entries()) {
            const item = items[index];
            if (!item) {
                skipped.push({email: String(id), reason: "不存在"});
            } else if (String(item.rebind_status || "") !== "unknown") {
                skipped.push({email: item.email, reason: `无需对账(${item.rebind_status || "—"})`});
            } else {
                candidates.push(Number(item.id));
                byId.set(Number(item.id), item);
            }
        }
        const result = candidates.length
            ? await reconcile.selected(candidates)
            : {done: 0, claimedIds: [], failures: []};
        const claimed = new Set(result.claimedIds || []);
        for (const id of candidates) {
            if (!claimed.has(id)) skipped.push({email: byId.get(id)?.email || String(id), reason: "已由其他实例认领或状态已变化"});
        }
        skipped.push(...(result.failures || []).map((item) => ({email: item.email || String(item.id), reason: item.reason})));
        await effects.syncQueue();
        return {ok: true, done: result.done || 0, skipped};
    }

    return {
        listPool: async () => ({ok: true, ...await store.listPool()}),
        markUnavailable,
        migrate,
        demote,
        enqueue,
        cancel,
        reconcileNow,
    };
}
