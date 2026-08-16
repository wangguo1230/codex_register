import pg from "pg";
import {classifyHardenIssue, formatHardenListReason, deriveGoogleState} from "../src/mail/google-state.ts";

const pool = new pg.Pool({connectionString: "postgresql://postgres:123456@192.168.1.126:5432/all_register"});
const {rows} = await pool.query(`SELECT * FROM mailboxes WHERE deleted_at=0 AND provider='google'`);
let n = 0;
for (const mb of rows) {
    const st = mb.google_state && typeof mb.google_state === "object" ? mb.google_state : {};
    const nextErr = formatHardenListReason(mb) || classifyHardenIssue(st.last_error || "");
    if (!nextErr || nextErr === st.last_error) continue;
    const next = deriveGoogleState(mb, {last_error: nextErr});
    await pool.query(`UPDATE mailboxes SET google_state=$1::jsonb, google_stage=$2 WHERE id=$3`, [next, next.stage, mb.id]);
    n += 1;
}
console.log("rewrote", n);
await pool.end();
