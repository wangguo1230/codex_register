// 浏览器端 RFC 6238 TOTP，详情页即时显示当前 6 位码。

function base32Decode(raw: string): Uint8Array {
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
    const s = String(raw || "").replace(/\s+/g, "").replace(/-/g, "").toUpperCase();
    let bits = "";
    for (const c of s) {
        const v = alphabet.indexOf(c);
        if (v < 0) continue;
        bits += v.toString(2).padStart(5, "0");
    }
    const bytes: number[] = [];
    for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2));
    return new Uint8Array(bytes);
}

export function totpRemain(atMs = Date.now(), step = 30): number {
    return step - (Math.floor(atMs / 1000) % step);
}

export async function generateTotp(secret: string, atMs = Date.now(), step = 30): Promise<string> {
    const key = base32Decode(secret);
    if (!key.length || !globalThis.crypto?.subtle) return "";
    let counter = Math.floor(atMs / 1000 / step);
    const buf = new ArrayBuffer(8);
    const view = new DataView(buf);
    for (let i = 7; i >= 0; i--) {
        view.setUint8(i, counter & 0xff);
        counter = Math.floor(counter / 256);
    }
    const cryptoKey = await globalThis.crypto.subtle.importKey("raw", key, {name: "HMAC", hash: "SHA-1"}, false, ["sign"]);
    const sig = new Uint8Array(await globalThis.crypto.subtle.sign("HMAC", cryptoKey, buf));
    const offset = sig[sig.length - 1] & 0x0f;
    const bin = ((sig[offset] & 0x7f) << 24) | (sig[offset + 1] << 16) | (sig[offset + 2] << 8) | sig[offset + 3];
    return String(bin % 10 ** 6).padStart(6, "0");
}
