// 已整备的 Gmail 老号批量注册 GPT（不重做整备）
import {writeFileSync} from "node:fs";
import {spawn} from "node:child_process";
import path from "node:path";
import {fileURLToPath} from "node:url";
import pg from "pg";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const emails = process.argv.slice(2);
if (!emails.length) process.exit(1);
const pool = new pg.Pool({connectionString: process.env.DATABASE_URL || "postgresql://postgres:123456@192.168.1.126:5432/all_register"});

function runWorker(env): Promise<{code: number; result: any}> {
    return new Promise((resolve) => {
        const child = spawn("npx", ["tsx", "src/worker-register-browser.ts"], {
            cwd: ROOT, env: {...process.env, ...env}, shell: false,
        });
        let result = null;
        let buf = "";
        const on = (chunk) => {
            buf += chunk.toString();
            let i;
            while ((i = buf.indexOf("\n")) >= 0) {
                const line = buf.slice(0, i);
                buf = buf.slice(i + 1);
                console.log(line);
                if (line.startsWith("@@EVENT@@")) {
                    try {
                        const ev = JSON.parse(line.slice(9));
                        if (ev.type === "result") result = ev;
                        if (ev.type === "mailbox_update" && ev.email) {
                            const sets = [];
                            const vals = [];
                            if (ev.password) { sets.push(`password=$${sets.length + 1}`); vals.push(ev.password); }
                            if (ev.totp_secret) { sets.push(`totp_secret=$${sets.length + 1}`); vals.push(ev.totp_secret); }
                            if (ev.imap_password) { sets.push(`imap_password=$${sets.length + 1}`); vals.push(ev.imap_password); }
                            if (ev.recovery_email != null) { sets.push(`recovery_email=$${sets.length + 1}`); vals.push(ev.recovery_email); }
                            if (ev.manage_ok) {
                                sets.push(`google_stage=$${sets.length + 1}`);
                                vals.push("ready");
                            }
                            if (sets.length) {
                                vals.push(ev.email);
                                pool.query(`UPDATE mailboxes SET ${sets.join(", ")} WHERE email=$${vals.length}`, vals)
                                    .then(() => console.log("MAILBOX_UPDATED", ev.email))
                                    .catch((e) => console.log("MAILBOX_UPDATE_FAIL", e?.message || e));
                            }
                        }
                    } catch { /* */ }
                }
            }
        };
        child.stdout.on("data", on);
        child.stderr.on("data", (c) => process.stderr.write(c));
        child.on("close", (code) => resolve({code: code ?? 1, result}));
    });
}

for (const raw of emails) {
    const email = raw.trim().toLowerCase();
    console.log("\n========== REG", email, "==========");
    const {rows: [mb]} = await pool.query(
        "SELECT email,password,totp_secret,recovery_email,imap_password FROM mailboxes WHERE email=$1 AND deleted_at=0",
        [email],
    );
    if (!mb) { console.log("SKIP no mailbox"); continue; }
    const tok = `/tmp/gmail-reg-${email.replace(/[^a-z0-9]/g, "_")}.txt`;
    writeFileSync(tok, [mb.email, mb.password, mb.totp_secret || "", mb.recovery_email || "", mb.imap_password || ""].join("----") + "\n");
    const gptPassword = `Gpt@${email.split("@")[0].slice(0, 8)}${Math.floor(100 + Math.random() * 900)}`;
    const {result} = await runWorker({
        MAIL_PROVIDER: "google",
        MAILCOM_TOKENS_FILE: tok,
        BITBROWSER: "1",
        REG_GOOGLE_PREP: "1",
        REG_GOOGLE_HARDEN: process.env.REG_GOOGLE_HARDEN === "0" ? "0" : "1",
        REG_SKIP_DEVICES: process.env.REG_SKIP_DEVICES === "1" ? "1" : "0",
        REG_EMAIL: email,
        GPT_PASSWORD: gptPassword,
        PROXY_URL: process.env.PROXY_URL || "socks5://127.0.0.1:10809",
        REG_OTP_SINGLE: "1",
        REG_SIMULATE_CHAT: "0",
        REG_TRY_RT: "0",
        REG_TRY_MFA: "1",
        REG_SMS: "0",
        REG_GOOGLE_SSO: process.env.REG_GOOGLE_SSO || "0",
    });
    if (result?.status === "success" && result.authFile) {
        const {spawnSync} = await import("node:child_process");
        spawnSync("npx", ["tsx", "scripts/persist-gpt.ts", email, result.authFile, result.gptPassword || gptPassword, result.totpSecret || ""], {
            cwd: ROOT, stdio: "inherit", env: {...process.env, GPT_BATCH: process.env.GPT_BATCH || "gmail-test-15"},
        });
        console.log("PERSISTED", email);
        await pool.query(
            `UPDATE mailboxes SET
                google_state = COALESCE(google_state,'{}'::jsonb) || jsonb_build_object('gpt','ok','login','ok','stage','gpt_ok','updated_at',$2::bigint),
                google_stage='gpt_ok'
             WHERE email=$1 AND provider='google'`,
            [email, Date.now()],
        ).catch(() => {});
        await pool.query(
            `INSERT INTO mailbox_logs(mailbox_id,ts,line)
             SELECT id,$2,$3 FROM mailboxes WHERE email=$1 AND deleted_at=0`,
            [email, Date.now(), `[GPT] 注册成功`],
        ).catch(() => {});
    } else {
        console.log("FAILED", email, result?.error || "no result");
        const err = String(result?.error || "no result");
        let overlay = {gpt: "fail", last_error: err.slice(0, 160), updated_at: Date.now(), stage: "partial"};
        if (/Wrong password|密码错误/i.test(err)) overlay = {...overlay, login: "fail", login_error: "wrong_password", stage: "blocked"};
        else if (/doritos|插页/i.test(err)) overlay = {...overlay, login: "fail", login_error: "interstitial_doritos", stage: "blocked"};
        else if (/reCAPTCHA|图片验证|人机/i.test(err)) overlay = {...overlay, login: "fail", login_error: "captcha", stage: "blocked"};
        else if (/邮箱管理/i.test(err)) overlay = {...overlay, login: /登录失败/.test(err) ? "fail" : "ok", stage: "partial", last_error: err.slice(0, 160)};
        else if (/Gmail 登录失败/i.test(err)) overlay = {...overlay, login: "fail", stage: "blocked"};
        else if (/security verification|not a bot|Cloudflare|Ray ID/i.test(err)) overlay = {...overlay, login_error: "cf", last_error: "Cloudflare 拦截", stage: "blocked"};
        await pool.query(
            `UPDATE mailboxes SET google_state = COALESCE(google_state,'{}'::jsonb) || $2::jsonb, google_stage=$3
             WHERE email=$1 AND provider='google'`,
            [email, JSON.stringify(overlay), overlay.stage],
        ).catch(() => {});
        await pool.query(
            `INSERT INTO mailbox_logs(mailbox_id,ts,line)
             SELECT id,$2,$3 FROM mailboxes WHERE email=$1 AND deleted_at=0`,
            [email, Date.now(), `[GPT] 失败 ${err.slice(0, 160)}`],
        ).catch(() => {});
    }
}
await pool.end();
