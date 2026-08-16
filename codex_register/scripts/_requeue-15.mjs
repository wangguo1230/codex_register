import pg from "pg";
import {needsHardenRetry} from "../src/mail/google-state.ts";

const pool = new pg.Pool({connectionString: "postgresql://postgres:123456@192.168.1.126:5432/all_register"});
const GRP = "8 月 15 日 200";

const {rows} = await pool.query(
    `SELECT id, email, password, pw_status, google_state, google_stage, totp_secret, imap_password, recovery_email, provider
     FROM mailboxes WHERE deleted_at=0 AND provider='google' AND grp=$1`,
    [GRP],
);
const need = rows.filter((m) => needsHardenRetry(m) && m.google_stage !== "blocked");
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
const {rows: [j]} = await pool.query(
    `SELECT COUNT(*) FILTER (WHERE j.status='pending')::int pend,
            COUNT(*) FILTER (WHERE j.status='running')::int run
     FROM mail_jobs j JOIN mailboxes m ON m.id=j.mailbox_id
     WHERE j.kind='harden' AND m.grp=$1 AND j.status IN ('pending','running')`,
    [GRP],
);
console.log(JSON.stringify({need: need.length, inserted: n, batch: bid, pend: j.pend, run: j.run}));
await pool.end();
