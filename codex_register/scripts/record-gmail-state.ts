// 把现有 Gmail 老号的管理阶段写进 mailboxes.google_state / google_stage，并记一条操作日志。
import pg from "pg";
import {deriveGoogleState, googleStateSummary} from "../src/mail/google-state.ts";

const pool = new pg.Pool({connectionString: process.env.DATABASE_URL || "postgresql://postgres:123456@192.168.1.126:5432/all_register"});

const OVERLAYS = {
    "cuentabpit@gmail.com": {
        login: "fail",
        login_error: "wrong_password",
        last_error: "卖家密码 Wrong password，登不进 Google",
        password: "fail",
        gpt: "none",
        stage: "blocked",
    },
    "abdulhadiangra123@gmail.com": {
        login: "fail",
        login_error: "interstitial_doritos",
        last_error: "密码和 TOTP 能过，卡在登录后插页 doritos",
        password: "ok",
        totp: "ok",
        gpt: "fail",
        stage: "blocked",
    },
    "fareedmalik75051@gmail.com": {
        login: "ok",
        imap: "ok",
        recovery: "ok",
        gpt: "none",
    },
};

await pool.query(`ALTER TABLE mailboxes ADD COLUMN IF NOT EXISTS google_state JSONB DEFAULT '{}'::jsonb`);
await pool.query(`ALTER TABLE mailboxes ADD COLUMN IF NOT EXISTS google_stage TEXT DEFAULT ''`);

const {rows} = await pool.query(`
    SELECT m.*, g.status AS gpt_status, g.error AS gpt_error
    FROM mailboxes m
    LEFT JOIN gpt_accounts g ON g.mailbox_id=m.id AND g.deleted_at=0
    WHERE m.provider='google' AND m.deleted_at=0
    ORDER BY m.email
`);

let n = 0;
for (const mb of rows) {
    const overlay = OVERLAYS[mb.email] || {};
    const state = deriveGoogleState(mb, overlay);
    await pool.query(
        `UPDATE mailboxes SET google_state=$1::jsonb, google_stage=$2 WHERE id=$3`,
        [JSON.stringify(state), state.stage, mb.id],
    );
    const line = `[状态] ${googleStateSummary(state)}`;
    await pool.query(`INSERT INTO mailbox_logs(mailbox_id,ts,line) VALUES($1,$2,$3)`, [mb.id, Date.now(), line]);
    console.log(String(mb.email).padEnd(36), state.stage.padEnd(12), googleStateSummary(state));
    n += 1;
}
console.log("RECORDED", n);
await pool.end();
