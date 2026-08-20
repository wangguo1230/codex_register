// @ts-nocheck
// 子进程探 Gmail 登录。比特 CDP 绝不能跑在 :3100。
import {readFileSync} from "node:fs";
import {probeGmailWebLogin} from "../server/domain/gmail-rebind-probe.ts";

const jobFile = process.argv[2] || "";
if (!jobFile) {
    process.stdout.write("@@RESULT@@" + JSON.stringify({ok: false, error: "缺少任务文件", dead: false, proxyDead: true}) + "\n");
    process.exit(1);
}

const job = JSON.parse(readFileSync(jobFile, "utf8"));
const log = (m) => {
    const s = String(m || "").replace(/\s+/g, " ").trim();
    if (s) process.stdout.write(s + "\n");
};

try {
    const {sweepRebindProbeWindows, closeTrackedBitWindows} = await import("../src/bitbrowser.js");
    // 只清已经关掉的配置。开着的窗可能是其它并发探登录，杀了会变成「已到密码页」假失败。
    const n = await sweepRebindProbeWindows({log, onlyClosed: true});
    if (n) log(`开探前清掉 ${n} 个已关残留窗`);
    const bye = () => { closeTrackedBitWindows().catch(() => {}); };
    process.once("SIGTERM", bye);
    process.once("SIGINT", bye);
} catch { /* 清窗失败不挡探登录 */ }

let emitted = false;
const emitVerdict = (r) => {
    if (emitted) return;
    emitted = true;
    process.stdout.write("@@RESULT@@" + JSON.stringify({
        ok: !!r.ok,
        error: r.error || "",
        dead: !!r.dead,
        proxyDead: !!r.proxyDead,
    }) + "\n");
};

try {
    const r = await probeGmailWebLogin(job, log, emitVerdict, {
        hasLease: job.probe_has_lease === true,
        proxyUrl: job.probe_proxy_url || "",
        jumpUrl: job.probe_jump_url || "",
    });
    emitVerdict(r);
    process.exit(r.ok ? 0 : 2);
} catch (e) {
    emitVerdict({
        ok: false,
        error: String(e?.message || e).slice(0, 240),
        dead: false,
        proxyDead: true,
    });
    process.exit(1);
}
