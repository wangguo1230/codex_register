// @ts-nocheck
// Token 域兼容门面；解析实现统一收敛到 bounded-stdio。
import {attachBoundedStdio} from "../bounded-stdio.js";

export function pipeWorkerOutput(child, {onLine, onEvent, maxBuf = 512 * 1024} = {}) {
    return attachBoundedStdio(child, {
        onLine,
        onEvent,
        maxBuf,
        lineLimit: 220,
        stderrLineLimit: 160,
        stderrPrefix: "[err] ",
        stderrMode: "chunk",
    });
}
