// @ts-nocheck
import {refreshRt, buildProxyDispatcher} from "../src/token-check.js";
import {appConfig} from "../src/config.js";

const rt = process.argv[2];
if (!rt) { console.error("用法: tsx scripts/get-session.ts <refresh_token>"); process.exit(1); }

const dispatcher = buildProxyDispatcher(appConfig.defaultProxyUrl);
const r = await refreshRt(rt, dispatcher);
if (r.ok) {
    console.log(JSON.stringify({
        accessToken: r.tokens.access_token,
        refresh_token: r.tokens.refresh_token,
        id_token: r.tokens.id_token,
        account_id: r.tokens.account_id,
    }, null, 2));
} else {
    console.error("刷新失败:", r.reason);
    process.exit(1);
}
