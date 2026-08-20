import type {RechargeQueueItem} from "./api";

export interface RechargeQueueFilters {
    status?: string;
    batch?: string;
    mailboxType?: string;
    rebind?: string;
    email?: string;
}

function mailboxTypeOf(email: string) {
    if (/@(gmail|googlemail)\.com$/i.test(email)) return "gmail";
    if (/@mail\.com$/i.test(email)) return "mailcom";
    if (/@icloud\.com$/i.test(email)) return "icloud";
    return "other";
}

function isRebound(item: RechargeQueueItem, currentEmail: string, from: string) {
    return item.rebind_status === "ok" || !!(from && currentEmail && from !== currentEmail);
}

function matchesStatus(item: RechargeQueueItem, status: string) {
    if (!status || status === "all") return true;
    if (status === "undone") return item.status !== "done" && item.status !== "error";
    if (status === "finished" || status === "done") return item.status === "done";
    return item.status === status;
}

export function filterRechargeQueue(queue: RechargeQueueItem[], filters: RechargeQueueFilters) {
    const status = String(filters.status || "all");
    const batch = String(filters.batch || "");
    const mailboxType = String(filters.mailboxType || "");
    const rebindFilter = String(filters.rebind || "");
    const emailTerms = String(filters.email || "").trim().toLowerCase().split(/[\s,;，；]+/).filter(Boolean);

    return queue.filter((item) => {
        if (!matchesStatus(item, status)) return false;
        if (batch && String(item.recharge_group || item.batch || "") !== batch) return false;

        const currentEmail = String(item.email || "").trim().toLowerCase();
        if (mailboxType && mailboxTypeOf(currentEmail) !== mailboxType) return false;

        const from = String(item.rebind_from || "").trim().toLowerCase();
        const reboundTo = String(item.rebind_email || "").trim().toLowerCase();
        const attempted = String(item.rebind_attempt_email || "").trim().toLowerCase();
        const rebound = isRebound(item, currentEmail, from);
        const notRebound = !rebound && !from && (!item.rebind_status || item.rebind_status === "skipped");
        if (rebindFilter === "none" && !notRebound) return false;
        if (rebindFilter === "ok" && !rebound) return false;
        if (["pending", "unknown", "fail"].includes(rebindFilter) && item.rebind_status !== rebindFilter) return false;
        if (rebindFilter === "gmail") {
            const target = reboundTo || attempted || (rebound ? currentEmail : "");
            if (item.rebind_target !== "gmail" && mailboxTypeOf(target) !== "gmail") return false;
        }
        if (rebindFilter === "mailcom") {
            const target = reboundTo || attempted || (rebound ? currentEmail : "");
            if (item.rebind_target !== "mailcom" && mailboxTypeOf(target) !== "mailcom") return false;
        }

        if (emailTerms.length) {
            const emails = [currentEmail, from, reboundTo, attempted];
            if (!emailTerms.some((term) => emails.some((email) => email.includes(term)))) return false;
        }
        return true;
    });
}
