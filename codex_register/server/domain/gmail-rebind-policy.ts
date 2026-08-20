// @ts-nocheck
// Gmail 换绑的纯业务规则：不读取数据库、调度器或进程内队列。

export function normalizeRebindTarget(value) {
    const target = String(value || "").trim().toLowerCase();
    if (target === "mail" || target === "mail.com" || target === "mailcom") return "mailcom";
    if (target === "gmail" || target === "google") return "gmail";
    return "";
}

export function rebindTargetLabel(target) {
    return target === "mailcom" ? "mail.com" : "Gmail";
}

export function resolveRebindTarget(queueItem, {
    force = false,
    target,
    defaultTarget,
} = {}) {
    const explicit = normalizeRebindTarget(target);
    if (explicit) return explicit;
    const stored = normalizeRebindTarget(queueItem?.rebind_target);
    if (force && stored) return stored;
    const automatic = normalizeRebindTarget(defaultTarget);
    if (automatic) return automatic;
    return force ? "gmail" : "";
}

export function normalizeRebindPool(raw = {}, extractEmails = () => []) {
    const emails = [...new Set(
        (Array.isArray(raw.emails) ? raw.emails : [])
            .map((item) => String(item || "").trim().toLowerCase())
            .filter((item) => item.includes("@")),
    )];
    for (const email of extractEmails(String(raw.text || ""))) {
        if (!emails.includes(email)) emails.push(email);
    }
    const group = raw.grp;
    const hasGroup = group !== undefined && group !== null
        && group !== "__ALL__" && group !== "__PICK__" && String(group) !== "undefined";
    const pool = {};
    if (emails.length) pool.emails = emails;
    if (hasGroup) pool.grp = String(group);
    return pool;
}

export function rebindPoolHint(pool = {}) {
    const parts = [];
    if (pool.grp !== undefined) parts.push(`分组「${pool.grp || "无分组"}」`);
    if (pool.emails?.length) parts.push(`${pool.emails.length} 个指定邮箱`);
    return parts.length ? `，范围=${parts.join(" ")}` : "";
}

export function formatRebindUntil(timestamp) {
    const value = Number(timestamp);
    if (!Number.isFinite(value)) return "稍后";
    const date = new Date(value);
    if (!Number.isFinite(date.getTime())) return "稍后";
    const pad = (value) => String(value).padStart(2, "0");
    return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
