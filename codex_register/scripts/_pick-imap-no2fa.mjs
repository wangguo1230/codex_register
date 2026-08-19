import pg from "pg";
import {planHardenSkip, needsHardenRetry} from "../src/mail/google-state.ts";
const emails = [
    "yosoymongoloho@gmail.com",
    "robkim502021@gmail.com",
    "rollzsteam@gmail.com",
    "jackybrucedecker@gmail.com",
    "getyouthemoon2013@gmail.com",
    "sz3funci0munci0@gmail.com",
    "oknumbro007@gmail.com",
    "aenratih@gmail.com",
    "d3jvoss96@gmail.com",
    "doradira221@gmail.com",
    "cuentaescolar1w@gmail.com",
    "rofiqulgasi2020@gmail.com",
    "bihackroi3@gmail.com",
];
const c = new pg.Client({connectionString: "postgresql://postgres:123456@192.168.1.126:5432/all_register"});
await c.connect();
const {rows} = await c.query(`SELECT * FROM mailboxes WHERE email = ANY($1)`, [emails]);
const pick = [];
for (const mb of rows) {
    const skip = planHardenSkip(mb);
    const st = mb.google_state || {};
    pick.push({
        id: mb.id,
        email: mb.email,
        usable: skip.usable,
        totp: skip.totp,
        imap: skip.imap,
        attempts: Number(st.harden_attempts || 0),
        retry: needsHardenRetry(mb),
        stage: mb.google_stage,
        login: st.login,
    });
}
console.log(JSON.stringify(pick, null, 2));
const live = await c.query(`SELECT status, count(*)::int n FROM mail_jobs WHERE status IN ('pending','running') GROUP BY 1`);
console.log("LIVE", live.rows);
await c.end();
