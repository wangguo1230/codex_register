import pg from "pg";
import {needsHardenRetry} from "../src/mail/google-state.ts";

const pool = new pg.Pool({connectionString: "postgresql://postgres:123456@192.168.1.126:5432/all_register"});
const GROUPS = ["8 月 15 日 200", "8 月 16 日 100"];

async function loadGroup(grp) {
    const {rows} = await pool.query(
        `SELECT id, email, password, pw_status, google_state, google_stage, totp_secret, imap_password, recovery_email, provider
         FROM mailboxes WHERE deleted_at=0 AND provider='google' AND grp=$1`,
        [grp],
    );
    return rows;
}

async function enqueueGaps(grp) {
    const rows = await loadGroup(grp);
    const need = rows.filter((m) => needsHardenRetry(m) && m.google_stage !== "blocked");
    if (!need.length) return 0;
    const bid = Date.now().toString(36);
    const now = Date.now();
    let n = 0;
    for (const m of need) {
        const r = await pool.query(
            `INSERT INTO mail_jobs(kind, mailbox_id, email, batch_id, status, created_at, payload)
             SELECT 'harden',$1,$2,$3,'pending',$4,NULL
             WHERE NOT EXISTS (
               SELECT 1 FROM mail_jobs WHERE kind='harden' AND mailbox_id=$1 AND status IN ('pending','running')
             )`,
            [m.id, m.email, bid, now],
        );
        n += r.rowCount || 0;
    }
    return n;
}

async function groupLeft(grp) {
    const rows = await loadGroup(grp);
    const gaps = rows.filter((m) => needsHardenRetry(m) && m.google_stage !== "blocked");
    const {rows: [j]} = await pool.query(
        `SELECT COUNT(*) FILTER (WHERE j.status='pending')::int pend,
                COUNT(*) FILTER (WHERE j.status='running')::int run
         FROM mail_jobs j JOIN mailboxes m ON m.id=j.mailbox_id
         WHERE j.kind='harden' AND m.grp=$1 AND j.status IN ('pending','running')`,
        [grp],
    );
    return {total: rows.length, gaps: gaps.length, pend: j.pend || 0, run: j.run || 0};
}

const started = Date.now();
const MAX_MS = 10 * 60 * 60 * 1000;

try {
    for (;;) {
        if (Date.now() - started > MAX_MS) {
            const a = await groupLeft(GROUPS[0]);
            const b = await groupLeft(GROUPS[1]);
            process.stdout.write(`FAILED timeout ${GROUPS[0]}=${a.gaps} ${GROUPS[1]}=${b.gaps}\n`);
            break;
        }
        const a = await groupLeft(GROUPS[0]);
        if (a.gaps > 0) {
            if (a.pend + a.run === 0) {
                const n = await enqueueGaps(GROUPS[0]);
                if (!n) {
                    process.stdout.write(`FAILED ${GROUPS[0]} stuck gaps=${a.gaps}\n`);
                    await new Promise((r) => setTimeout(r, 180000));
                    continue;
                }
            }
            await new Promise((r) => setTimeout(r, 90000));
            continue;
        }
        const b = await groupLeft(GROUPS[1]);
        if (b.gaps > 0) {
            if (b.pend + b.run === 0) {
                const n = await enqueueGaps(GROUPS[1]);
                if (n) process.stdout.write(`DONE 15th-clear enq16 +${n}\n`);
                else {
                    process.stdout.write(`FAILED ${GROUPS[1]} stuck gaps=${b.gaps}\n`);
                    await new Promise((r) => setTimeout(r, 180000));
                    continue;
                }
            }
            await new Promise((r) => setTimeout(r, 90000));
            continue;
        }
        if (a.pend + a.run + b.pend + b.run === 0) {
            process.stdout.write("DONE both-groups-ready\n");
            break;
        }
        await new Promise((r) => setTimeout(r, 90000));
    }
} catch (e) {
    process.stdout.write(`FAILED ${e?.message || e}\n`);
} finally {
    await pool.end();
}
