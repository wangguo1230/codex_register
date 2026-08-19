// 子进程 stdout 必须有上限。worker 吐无换行的 HTML/JSON 时，
// `buf += chunk` 会单独把 :3100 吃到几十 GB。
export function attachBoundedStdio(child, {
    onLine = (_t: string) => {},
    maxBuf = 512 * 1024,
} = {}) {
    let buf = "";
    const feed = (chunk) => {
        buf += String(chunk || "");
        if (buf.length > maxBuf) buf = buf.slice(-Math.floor(maxBuf / 2));
        let idx;
        while ((idx = buf.indexOf("\n")) >= 0) {
            const line = buf.slice(0, idx);
            buf = buf.slice(idx + 1);
            const t = line.trim();
            if (t) {
                try { onLine(t); } catch { /* */ }
            }
        }
    };
    child.stdout?.on("data", feed);
    child.stderr?.on("data", feed);
    return () => buf;
}
