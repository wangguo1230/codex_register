import { createHash, randomBytes } from "node:crypto";

/** 北京时间 YYYY-MM-DD HH:mm 或带秒；收件箱/日志展示用（固定 Asia/Shanghai，不跟机器时区） */
export function formatBeijingDateTime(ts: number | Date | string | null | undefined, withSeconds = false): string {
  if (ts == null || ts === "") return "";
  const d = ts instanceof Date
    ? ts
    : new Date(typeof ts === "number" ? ts : (Number(ts) || Date.parse(String(ts))));
  if (!Number.isFinite(d.getTime()) || d.getTime() <= 0) return "";
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: withSeconds ? "2-digit" : undefined,
    hour12: false,
  }).formatToParts(d);
  const g = (t: string) => parts.find((p) => p.type === t)?.value || "00";
  const base = `${g("year")}-${g("month")}-${g("day")} ${g("hour")}:${g("minute")}`;
  return withSeconds ? `${base}:${g("second")}` : base;
}

export function randomUrlSafeString(length: number): string {
  const size = length > 0 ? length : 32;
  return randomBytes(size).toString("base64url");
}

export function pkceCodeChallenge(codeVerifier: string): string {
  return createHash("sha256").update(codeVerifier).digest("base64url");
}

/** 随机密码:默认 20 位，保证含大小写+数字(去掉易混字符 0O1lI)。用于改邮箱密码/生成新密码。 */
export function randomPassword(length = 20): string {
  const U = "ABCDEFGHJKLMNPQRSTUVWXYZ";
  const L = "abcdefghijkmnpqrstuvwxyz";
  const D = "23456789";
  const all = U + L + D;
  const pick = (s: string) => s[randomBytes(1)[0] % s.length];
  const n = Math.max(4, length);
  const chars = [pick(U), pick(L), pick(D)]; // 至少各一
  for (let i = chars.length; i < n; i += 1) chars.push(pick(all));
  // Fisher-Yates 洗牌(用 crypto 随机)
  for (let i = chars.length - 1; i > 0; i -= 1) {
    const j = randomBytes(1)[0] % (i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join("");
}
