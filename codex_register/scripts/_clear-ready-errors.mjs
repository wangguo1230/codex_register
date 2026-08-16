import pg from "pg";
import {deriveGoogleState, planHardenSkip} from "../src/mail/google-state.ts";

const pool = new pg.Pool({connectionString: "postgresql://postgres:123456@192.168.1.126:5432/all_register"});
const {rows} = await pool.query(`SELECT * FROM mailboxes WHERE deleted_at=0 AND provider='google'`);
let n = 0;
for (const mb of rows) {
    if (!planHardenSkip(mb).usable) continue;
    const st = mb.google_state && typeof mb.google_state === "object" ? mb.google_state : {};
    const dirtyErr = String(st.last_error || "");
    const dirtyPw = /^⚠/.test(String(mb.pw_status || ""));
    if (!dirtyErr && !dirtyPw && mb.google_stage === "ready") continue;
    const next = deriveGoogleState(mb, {last_error: "", login: "ok"});
    next.last_error = "";
    next.stage = "ready";
    if (dirtyPw) {
        await pool.query(
            `UPDATE mailboxes SET google_state=$1::jsonb, google_stage='ready', pw_status=$2 WHERE id=$3`,
            [next, `✅整备`, mb.id],
        );
    } else {
        await pool.query(
            `UPDATE mailboxes SET google_state=$1::jsonb, google_stage='ready' WHERE id=$2`,
            [next, mb.id],
        );
    }
    n += 1;
}
console.log("cleared", n);
await pool.end();
