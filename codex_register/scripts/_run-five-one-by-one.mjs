import pg from "pg";
import {classifyHardenIssue, formatHardenListReason, planHardenSkip} from "../src/mail/google-state.ts";

const MAC = "http://127.0.0.1:3100";
const WIN = "http://192.168.1.126:3100";
const ITEMS = [
    {id: 3992, email: "anaknyabubidan@gmail.com", expect: "换2FA"},
    {id: 4000, email: "trtrtrtrtrtr90@gmail.com", expect: "取IMAP"},
    {id: 4001, email: "resklamb123@gmail.com", expect: "2FA+IMAP"},
    {id: 4006, email: "segundobuslon1965@gmail.com", expect: "换2FA"},
    {id: 4008, email: "zeynep35hd35@gmail.com", expect: "换2FA"},
];

const c = new pg.Client({connectionString: "postgresql://postgres:123456@192.168.1.126:5432/all_register"});
await c.connect();

async function j(url, body) {
    const r = await fetch(url, {
        method: body ? "POST" : "GET",
        headers: body ? {"content-type": "application/json"} : undefined,
        body: body ? JSON.stringify(body) : undefined,
    });
    const t = await r.text();
    try { return JSON.parse(t); } catch { return {raw: t.slice(0, 200), status: r.status}; }
}

async function latestJob(id) {
    const {rows} = await c.query(
        `SELECT id, status, ok, last_line, error, claimed_at, finished_at
         FROM mail_jobs WHERE mailbox_id=$1 AND kind='harden' ORDER BY id DESC LIMIT 1`,
        [id],
    );
    return rows[0] || null;
}

async function snap(id) {
    const {rows: [mb]} = await c.query(`SELECT * FROM mailboxes WHERE id=$1`, [id]);
    const skip = planHardenSkip(mb);
    const {rows: logs} = await c.query(
        `SELECT line FROM mailbox_logs WHERE mailbox_id=$1 ORDER BY id DESC LIMIT 16`,
        [id],
    );
    return {
        email: mb.email,
        stage: mb.google_stage,
        usable: !!skip.usable,
        totp: !!mb.google_state?.totp_rotated,
        imap: !!(mb.imap_password && String(mb.imap_password).trim()),
        pw: mb.pw_status,
        attempts: mb.google_state?.harden_attempts,
        last_error: mb.google_state?.last_error,
        reason: formatHardenListReason(mb) || classifyHardenIssue(mb.google_state?.last_error || ""),
        logs: logs.map((r) => String(r.line).slice(0, 180)),
    };
}

await j(`${WIN}/api/mailboxes/batch-google-harden/stop`, {}).catch(() => ({}));
console.log("windows stop requested");

const out = [];
for (const it of ITEMS) {
    const before = await snap(it.id);
    if (before.usable) {
        console.log("SKIP already usable", it.email);
        out.push({...it, skipped: true, after: before});
        continue;
    }
    const prev = await latestJob(it.id);
    console.log("\n==== START", it.email, "expect", it.expect, "attempts", before.attempts, "====");
    const enq = await j(`${MAC}/api/mailboxes/batch-google-harden`, {ids: [it.id]});
    console.log("enq", JSON.stringify(enq));
    const t0 = Date.now();
    let job;
    while (Date.now() - t0 < 16 * 60 * 1000) {
        await new Promise((r) => setTimeout(r, 8000));
        job = await latestJob(it.id);
        if (!job) continue;
        if (prev && job.id === prev.id) continue;
        if (job.status === "pending" || job.status === "running") {
            if ((Date.now() - t0) % 40000 < 9000) console.log("  ..", it.email, job.status, String(job.last_line || "").slice(0, 120));
            continue;
        }
        break;
    }
    const after = await snap(it.id);
    const rec = {
        ...it,
        job: job && {id: job.id, status: job.status, ok: job.ok, line: String(job.last_line || job.error || "").slice(0, 220)},
        after,
        ms: Date.now() - t0,
    };
    out.push(rec);
    console.log("DONE", it.email, rec.job?.status, rec.job?.line);
    console.log("state", after.stage, "usable", after.usable, "totp", after.totp, "imap", after.imap, "reason", after.reason);
    console.log("logs:");
    for (const line of after.logs) console.log(" ", line);
}

await c.query("UPDATE mail_control SET claim_paused=true, updated_at=$1 WHERE id=1", [Date.now()]);
console.log("\nPAUSED");
console.log(JSON.stringify(out, null, 2));
await c.end();
