// @ts-nocheck
// 充值卡平台返回值的兼容与换号资格判定。
export function isPlatformFlagOn(value) {
    return value === true || value === 1 || value === "1" || /^true|yes|on|allowed$/i.test(String(value || "").trim());
}

export function emailMatchesMasked(masked, email) {
    const source = String(masked || "").trim().toLowerCase();
    const target = String(email || "").trim().toLowerCase();
    if (!source || !target) return false;
    if (source === target) return true;
    const [sourceLocal, sourceDomain] = source.split("@");
    const [targetLocal, targetDomain] = target.split("@");
    if (!sourceLocal || !sourceDomain || !targetLocal || sourceDomain !== targetDomain) return false;
    if (!sourceLocal.includes("*")) return sourceLocal === targetLocal;
    const prefix = sourceLocal.slice(0, sourceLocal.indexOf("*"));
    const suffix = sourceLocal.slice(sourceLocal.lastIndexOf("*") + 1);
    return targetLocal.startsWith(prefix) && targetLocal.endsWith(suffix);
}

/** 仅平台明确锁死且未授权换号时，禁止把 unused 卡分给其它账号。 */
export function cardBoundToOtherAccount(cardState, email) {
    if (String(cardState?.status || "") !== "unused") return false;
    const boundEmail = String(cardState?.bound_email || "").trim();
    if (!boundEmail || emailMatchesMasked(boundEmail, email)) return false;
    if (isPlatformFlagOn(cardState?.account_change_allowed)
        || isPlatformFlagOn(cardState?.change_allowed)
        || isPlatformFlagOn(cardState?.allow_account_change)) return false;
    const verdict = cardState?.account_change_verdict || {};
    if (String(verdict.result || "") === "allowed" || isPlatformFlagOn(verdict.allowed)) return false;
    return cardState?.account_change_locked === true
        || cardState?.account_change_locked === "true"
        || cardState?.account_change_locked === 1;
}

export function describeCardAllocationFailure(result) {
    if (result?.rateLimited) return result.reason || "平台 429 限流，已停止配卡";
    if (result?.empty) return "没有未使用卡密";
    return result?.skipped?.at(-1)?.reason || "无可用卡密";
}
