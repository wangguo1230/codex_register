// 子进程输出必须有上限。worker 吐无换行的 HTML/JSON 时，
// 无界 `buffer += chunk` 会持续撑大主进程内存。
const EVENT_PREFIX = /^@@(?:EVENT|RESULT)@@/;

export function createBoundedOutputParser({
    onLine = (_text: string) => {},
    onEvent = (_event: unknown) => {},
    maxBuf = 512 * 1024,
    lineLimit = Number.POSITIVE_INFINITY,
    stderrLineLimit = lineLimit,
    stderrPrefix = "",
    stderrMode = "line",
} = {}) {
    const limit = Math.max(1024, Number(maxBuf) || 512 * 1024);
    const buffers = {stdout: "", stderr: ""};

    const emit = (raw, source) => {
        const text = String(raw || "").trim();
        if (!text) return;
        if (EVENT_PREFIX.test(text)) {
            try { onEvent(JSON.parse(text.replace(EVENT_PREFIX, ""))); } catch { /* 损坏帧不影响 worker 生命周期 */ }
            return;
        }
        const max = source === "stderr" ? stderrLineLimit : lineLimit;
        const body = Number.isFinite(max) ? text.slice(0, Math.max(0, Number(max))) : text;
        try { onLine(`${source === "stderr" ? stderrPrefix : ""}${body}`); } catch { /* 观测回调不影响业务 */ }
    };

    const feed = (source, chunk) => {
        const value = String(chunk || "");
        if (!value) return;
        if (source === "stderr" && stderrMode === "chunk") {
            emit(value, source);
            return;
        }
        buffers[source] += value;
        if (buffers[source].length > limit) {
            buffers[source] = buffers[source].slice(-Math.floor(limit / 2));
        }
        let index;
        while ((index = buffers[source].indexOf("\n")) >= 0) {
            const line = buffers[source].slice(0, index).replace(/\r$/, "");
            buffers[source] = buffers[source].slice(index + 1);
            emit(line, source);
        }
    };

    const flush = () => {
        for (const source of ["stdout", "stderr"]) {
            if (buffers[source]) emit(buffers[source], source);
            buffers[source] = "";
        }
    };

    return {
        feedStdout: (chunk) => feed("stdout", chunk),
        feedStderr: (chunk) => feed("stderr", chunk),
        pending: () => [buffers.stdout, buffers.stderr].filter(Boolean).join("\n"),
        flush,
    };
}

export function attachBoundedStdio(child, options = {}) {
    const parser = createBoundedOutputParser(options);
    child.stdout?.on("data", parser.feedStdout);
    child.stderr?.on("data", parser.feedStderr);
    const pending = () => parser.pending();
    pending.flush = parser.flush;
    return pending;
}
