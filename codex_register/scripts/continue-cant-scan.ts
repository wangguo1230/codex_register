// 接到已打开的比特窗，接着点 Can't scan 并完成换 2FA。
//   npx tsx scripts/continue-cant-scan.ts danyangaming@gmail.com [bitId]
import pg from "pg";
import {chromium} from "playwright-core";
import * as db from "../server/db.ts";
import {listAutomationBitWindows, openBitWindow} from "../src/bitbrowser.ts";
import {change2faOnPage} from "../src/mail/google-manage.ts";

const email = process.argv[2] || "danyangaming@gmail.com";
const wantId = process.argv[3] || "";

const pool = new pg.Pool({connectionString: "postgresql://postgres:123456@192.168.1.126:5432/all_register"});
const {rows} = await pool.query(`SELECT * FROM mailboxes WHERE email=$1 AND deleted_at=0`, [email]);
const mb = rows[0];
if (!mb) {
    console.log("no account", email);
    process.exit(1);
}

const wins = await listAutomationBitWindows();
const hit = wins.find((w) => wantId && w.id === wantId)
    || wins.find((w) => /danyangam|show-2fa|probe-change/i.test(String(w.name || w.remark || "")))
    || wins.find((w) => w.status === 1);
if (!hit) {
    console.log("no open bit window", wins.map((w) => `${w.id} ${w.name} ${w.status}`));
    process.exit(1);
}
console.log("attach", hit.id, hit.name);

const {ws} = await openBitWindow(hit.id, {extractIp: false});
const browser = await chromium.connectOverCDP(ws);
const ctx = browser.contexts()[0] || await browser.newContext();
const page = ctx.pages()[0] || await ctx.newPage();
page.setDefaultTimeout(30000);
console.log("url", page.url());

const oldTotp = String(mb.totp_secret || "");
const changed = await change2faOnPage(page, {
    email: mb.email, password: mb.password, totpSecret: mb.totp_secret,
    recoveryEmail: mb.recovery_email || "",
    log: (m) => console.log(m),
    onPersist: async (patch) => {
        const secret = typeof patch === "string" ? patch : patch?.totpSecret;
        if (!secret) return;
        await db.setMailboxTotp(mb.id, secret);
        await db.refreshMailboxGoogleState(mb.id, {totp: "ok", totp_rotated: true}).catch(() => {});
        console.log(`[抽检] 新 TOTP 已验证并落库 旧=${oldTotp.slice(0, 8)} 新=${String(secret).slice(0, 8)}`);
    },
});
console.log("RESULT", changed);
console.log("窗口再留 60 秒");
await page.waitForTimeout(60000);
await pool.end();
process.exit(changed?.ok ? 0 : 1);
