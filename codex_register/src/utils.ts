import { createHash, randomBytes } from "node:crypto";

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
