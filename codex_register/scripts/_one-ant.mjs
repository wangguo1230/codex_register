import pg from "pg";
const c = new pg.Client({connectionString: "postgresql://postgres:123456@192.168.1.126:5432/all_register"});
await c.connect();
const {rows} = await c.query(
    `SELECT email, recovery_email, length(coalesce(totp_secret,'')) totp, google_stage, google_state->>'last_error' err
     FROM mailboxes WHERE email=$1`,
    ["antonio274000@gmail.com"],
);
console.log(rows);
await c.end();
