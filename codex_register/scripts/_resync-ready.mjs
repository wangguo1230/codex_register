import pg from "pg";
import {deriveGoogleState, planHardenSkip} from "../src/mail/google-state.ts";

const pool = new pg.Pool({connectionString: "postgresql://postgres:123456@192.168.1.126:5432/all_register"});
const {rows} = await pool.query(
    `SELECT * FROM mailboxes WHERE deleted_at=0 AND provider='google'`,
);
let n = 0;
const samples = [];
for (const mb of rows) {
    const next = deriveGoogleState(mb, {});
    if (next.stage === mb.google_stage) continue;
    if (planHardenSkip(mb).usable && next.stage === "ready") next.last_error = "";
    await pool.query(`UPDATE mailboxes SET google_state=$1::jsonb, google_stage=$2 WHERE id=$3`, [next, next.stage, mb.id]);
    n += 1;
    if (samples.length < 15) samples.push(`${mb.email} ${mb.google_stage}→${next.stage}`);
}
console.log(JSON.stringify({fixed: n, samples}, null, 2));
await pool.end();
