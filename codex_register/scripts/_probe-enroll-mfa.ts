// 一次性探测：对近期 2FA 失败号重试 enrollTotp（含 pwd_auth 过期重登）
import pg from "pg";
import {readFileSync, existsSync} from "node:fs";
import {enrollTotp, needsMfaEnrollReauth} from "../src/mfa.js";
import {decodeJwt, probeAt, buildProxyDispatcher} from "../src/token-check.js";
import {OpenAIClient} from "../src/openai.js";
import {generateRandomDeviceProfile} from "../src/device-profile.js";
import {appConfig} from "../src/config.js";

async function main() {
    const c = new pg.Client({connectionString: process.env.DATABASE_URL || "postgresql://postgres:123456@192.168.1.126:5432/all_register"});
    await c.connect();
    const r = await c.query(`
SELECT g.id, m.email, m.password AS mail_password, g.gpt_password, g.auth_data, g.auth_file, g.mfa_status, g.totp_secret, g.token
FROM gpt_accounts g JOIN mailboxes m ON m.id=g.mailbox_id
WHERE (g.mfa_status LIKE '%fetch failed%' OR g.mfa_status LIKE '%AT 失效%' OR g.mfa_status LIKE '%密码%'
   OR (g.status='success' AND coalesce(g.totp_secret,'')='' AND g.mfa_status NOT LIKE '%✅%'))
  AND (g.auth_data is not null OR g.auth_file is not null)
ORDER BY g.id DESC LIMIT 5`);
    console.log("candidates", r.rows.map((x) => ({id: x.id, email: x.email, mfa: x.mfa_status})));

    let proxy = process.env.PROXY_URL || process.env.ALL_PROXY || process.env.all_proxy || "";
    try {
        const cfg = JSON.parse(readFileSync("config.json", "utf8"));
        proxy = proxy || cfg.defaultProxyUrl || cfg.proxy || cfg.regProxy || cfg.PROXY_URL || "";
    } catch { /* */ }
    try {
        const s = JSON.parse(readFileSync("data/settings.json", "utf8"));
        proxy = proxy || s.regProxy || s.rtProxy || s.proxy || "";
    } catch { /* */ }
    if (!proxy) proxy = "socks5://127.0.0.1:10808";
    console.log("proxy set?", !!proxy, proxy ? String(proxy).slice(0, 60) + "…" : "");

    for (const row of r.rows) {
        let auth = row.auth_data;
        if (typeof auth === "string") {
            try { auth = JSON.parse(auth); } catch { auth = null; }
        }
        if (!auth && row.auth_file && existsSync(row.auth_file)) {
            try { auth = JSON.parse(readFileSync(row.auth_file, "utf8")); } catch { /* */ }
        }
        if (!auth) { console.log(row.id, "no auth"); continue; }
        let at = auth.session?.accessToken || auth.access_token || row.token || "";
        if (!at) { console.log(row.id, "no at"); continue; }
        let accountId = auth.account_id
            || decodeJwt(at)?.["https://api.openai.com/auth"]?.chatgpt_account_id
            || auth.session?.account?.id || "";
        let cookie = String(auth.cookie || "");
        const gptPw = String(row.gpt_password || appConfig.defaultPassword || "").trim();
        console.log("\n=== try", row.id, row.email, "cookieLen", cookie.length, "needReauth", needsMfaEnrollReauth(at), "hasGptPw", !!gptPw);
        const probe = await probeAt(at, accountId, buildProxyDispatcher(proxy.replace(/^socks5:/, "http:")));
        console.log("probeAt", probe);
        if (!probe.ok && probe.status !== 401) { console.log("skip bad at"); continue; }

        const res = await enrollTotp(at, {
            accountId,
            proxyUrl: proxy,
            cookie,
            retryAltProxy: true,
            browserFallback: true,
            headless: true,
            log: (m) => console.log("  ", m),
            reauth: gptPw ? async () => {
                console.log("  reauth via authLoginChatGPTHTTP…");
                process.env.PROXY_URL = proxy;
                const client = new OpenAIClient({
                    email: row.email,
                    password: gptPw,
                    deviceProfile: generateRandomDeviceProfile(),
                    manualMode: false,
                });
                const login = await client.authLoginChatGPTHTTP();
                const rec = JSON.parse(readFileSync(login.authFile, "utf8"));
                await c.query(
                    `UPDATE gpt_accounts SET auth_data=$1, token=$2, at_status=$3 WHERE id=$4`,
                    [JSON.stringify(rec), login.token, "✅有效", row.id],
                );
                return {
                    accessToken: login.token,
                    accountId: decodeJwt(login.token)?.["https://api.openai.com/auth"]?.chatgpt_account_id || "",
                    cookie: String(rec.cookie || ""),
                };
            } : undefined,
        });
        console.log("RESULT", res);
        if (res.ok && res.secret) {
            await c.query(`UPDATE gpt_accounts SET totp_secret=$1, mfa_status=$2 WHERE id=$3`, [res.secret, "✅已绑", row.id]);
            console.log("DB updated", row.id);
            break;
        }
        if (res.ok && res.already) {
            await c.query(`UPDATE gpt_accounts SET mfa_status=$1 WHERE id=$2`, ["⚠已有2FA缺密钥", row.id]);
            console.log("already enabled", row.id);
            break;
        }
    }
    await c.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
