// 直接整备「批量解绑」那 3 个 Gmail，写回库。
import pg from "pg";
import {readFileSync} from "node:fs";
import {runGoogleHardenWithBit} from "../src/mail/google-secure.ts";
import {deriveGoogleState} from "../src/mail/google-state.ts";


const DATABASE_URL = process.env.DATABASE_URL || "postgresql://postgres:123456@192.168.1.126:5432/all_register";
const EMAILS = process.argv.slice(2).map((s) => s.trim().toLowerCase()).filter((s) => s.includes("@"));
if (!EMAILS.length) {
    console.error("usage: tsx scripts/harden-three.ts email...");
    process.exit(1);
}

function stamp() {
    const d = new Date();
    const p = (n) => String(n).padStart(2, "0");
    return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function loadPoolLines() {
    try {
        const s = JSON.parse(readFileSync(new URL("../data/settings.json", import.meta.url), "utf8"));
        return Array.isArray(s.mailProxyPool) ? s.mailProxyPool.filter(Boolean) : [];
    } catch { return []; }
}

const pool = new pg.Pool({connectionString: DATABASE_URL});

async function persist(mb, r) {
    const now = Date.now();
    if (r.passwordChanged && r.password) {
        await pool.query(
            `UPDATE mailboxes
             SET password_prev=CASE WHEN password<>$1 AND COALESCE(password,'')<>'' THEN password ELSE password_prev END,
                 password=$1, pw_status=$2
             WHERE id=$3`,
            [r.password, r.ok ? `✅整备 ${stamp()}` : `⚠整备部分 ${stamp()}`, mb.id],
        );
    } else {
        await pool.query(`UPDATE mailboxes SET pw_status=$1 WHERE id=$2`, [r.ok ? `✅整备 ${stamp()}` : `⚠整备部分 ${stamp()}`, mb.id]);
    }
    if (r.totpChanged && r.totpSecret) {
        await pool.query(
            `UPDATE mailboxes SET
                totp_secret_orig=CASE WHEN COALESCE(totp_secret_orig,'')<>'' THEN totp_secret_orig WHEN COALESCE(totp_secret,'')<>'' AND totp_secret IS DISTINCT FROM $1 THEN totp_secret ELSE totp_secret_orig END,
                totp_secret=$1
             WHERE id=$2 AND (
               COALESCE(totp_secret,'')='' OR totp_secret=$1 OR totp_secret=$3
               OR COALESCE(google_state->>'totp_rotated','') <> 'true'
             )`,
            [r.totpSecret, mb.id, mb.totp_secret || ""],
        );
    }
    if (r.imapPassword) await pool.query(`UPDATE mailboxes SET imap_password=$1 WHERE id=$2`, [r.imapPassword, mb.id]);
    if (r.recoveryCleared) await pool.query(`UPDATE mailboxes SET recovery_email='' WHERE id=$1`, [mb.id]);
    const {rows: [fresh]} = await pool.query(`SELECT * FROM mailboxes WHERE id=$1`, [mb.id]);
    const state = deriveGoogleState(fresh, {
        login: r.ok || r.password || r.totpSecret ? "ok" : (r.error ? "fail" : undefined),
        password: r.password ? "ok" : undefined,
        totp: r.totpSecret ? "ok" : undefined,
        recovery: r.recoveryCleared ? "ok" : undefined,
        phone: r.phoneCleared ? "ok" : undefined,
        imap: r.imapPassword ? "ok" : undefined,
        last_error: (r.errors || [r.error]).filter(Boolean).join("; ").slice(0, 160),
    });
    await pool.query(
        `UPDATE mailboxes SET google_state=$1::jsonb, google_stage=$2 WHERE id=$3`,
        [JSON.stringify(state), state.stage, mb.id],
    );
    await pool.query(
        `INSERT INTO mailbox_logs(mailbox_id,ts,line) VALUES($1,$2,$3)`,
        [mb.id, now, `[整备] 脚本 ${r.ok ? "完成" : "部分失败"} ${(r.errors || [r.error]).filter(Boolean).join("; ")}`.slice(0, 220)],
    );
}

const proxies = loadPoolLines();
console.log(`代理池 ${proxies.length} 条，串行整备 ${EMAILS.length} 个`);

for (let i = 0; i < EMAILS.length; i++) {
    const email = EMAILS[i];
    const {rows: [mb]} = await pool.query(
        `SELECT * FROM mailboxes WHERE email=$1 AND deleted_at=0`,
        [email],
    );
    if (!mb) {
        console.log(`SKIP 库中无 ${email}`);
        continue;
    }
    const proxyUrl = proxies[i % Math.max(proxies.length, 1)] || "";
    console.log(`\n======== ${i + 1}/${EMAILS.length} ${email} ========`);
    const r = await runGoogleHardenWithBit({
        email: mb.email,
        password: mb.password,
        totpSecret: mb.totp_secret,
        totp_secret: mb.totp_secret,
        recoveryEmail: mb.recovery_email,
        recovery_email: mb.recovery_email,
    }, {
        proxyUrl,
        log: (m) => console.log(`[${email.split("@")[0]}] ${m}`),
    }).catch((e) => ({ok: false, error: String(e?.message || e), errors: [String(e?.message || e)]}));
    await persist(mb, r);
    console.log(`RESULT ${email}`, {
        ok: !!r.ok,
        missing: r.missing || [],
        totp: !!r.totpSecret,
        pw: !!r.password,
        imap: !!r.imapPassword,
        rec: !!r.recoveryCleared,
        err: (r.errors || [r.error]).filter(Boolean).join("; ").slice(0, 180),
    });
}

await pool.end();
console.log("\nDONE");
