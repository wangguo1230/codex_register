import {readFileSync, existsSync} from "node:fs";
import pg from "pg";

const email = (process.argv[2] || "").toLowerCase();
const authFile = process.argv[3] || "";
const gptPassword = process.argv[4] || "";
const totpSecret = process.argv[5] || "";
if (!email || !authFile) process.exit(1);
if (!existsSync(authFile)) throw new Error("auth file missing");
const rec = JSON.parse(readFileSync(authFile, "utf8"));
const token = rec?.session?.accessToken || rec?.accessToken || "";
const plan = rec?.session?.account?.planType || "free";
const now = Date.now();
const batch = process.env.GPT_BATCH || "gmail-test-5";
const pool = new pg.Pool({connectionString: process.env.DATABASE_URL || "postgresql://postgres:123456@192.168.1.126:5432/all_register"});
const {rows: [mb]} = await pool.query("SELECT id FROM mailboxes WHERE email=$1 AND deleted_at=0", [email]);
if (!mb) throw new Error("mailbox missing");
await pool.query("UPDATE mailboxes SET usage='gpt' WHERE id=$1", [mb.id]);
await pool.query(
    `UPDATE mailboxes SET
        google_state = COALESCE(google_state,'{}'::jsonb) || jsonb_build_object('gpt','ok','login','ok','stage','gpt_ok','updated_at',$2::bigint),
        google_stage='gpt_ok'
     WHERE id=$1 AND provider='google'`,
    [mb.id, now],
);
const {rows: [exist]} = await pool.query("SELECT id FROM gpt_accounts WHERE mailbox_id=$1", [mb.id]);
if (exist) {
    await pool.query(
        `UPDATE gpt_accounts SET status='success', token=$1, auth_file=$2, plan=$3, gpt_password=$4,
         totp_secret=$5, mfa_status=$6, finished_at=$7, error='', auth_data=$8, batch=$9, engine='browser'
         WHERE id=$10`,
        [token, authFile, plan, gptPassword, totpSecret, totpSecret ? "✅已绑" : "", now, rec, batch, exist.id],
    );
    console.log("updated", exist.id);
} else {
    const {rows: [ins]} = await pool.query(
        `INSERT INTO gpt_accounts(mailbox_id,status,token,auth_file,plan,gpt_password,totp_secret,mfa_status,finished_at,created_at,batch,engine,auth_data,error)
         VALUES($1,'success',$2,$3,$4,$5,$6,$7,$8,$8,$9,'browser',$10,'') RETURNING id`,
        [mb.id, token, authFile, plan, gptPassword, totpSecret, totpSecret ? "✅已绑" : "", now, batch, rec],
    );
    console.log("inserted", ins.id);
}
await pool.end();
