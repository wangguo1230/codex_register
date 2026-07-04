// @ts-nocheck
/**
 * mail.com 改密 单号调试入口(headed 便于看页面调选择器)。
 * 用法: [MAILCOM_PROXY=..] [MAILCOM_HEADLESS=1] npx tsx src/probe-change-passwd.ts <email> <当前密码> [新密码]
 *   不给新密码则随机生成 20 位大小写+数字。
 */
import {changeMailcomPassword, setMailProxy} from "./mail/mailcom.js";
import {randomPassword} from "./utils.js";

const [email, oldPwd, newPwdArg] = process.argv.slice(2);
if (!email || !oldPwd) {
    console.error("用法: npx tsx src/probe-change-passwd.ts <email> <当前密码> [新密码]");
    process.exit(1);
}
if (process.env.MAILCOM_PROXY) setMailProxy(process.env.MAILCOM_PROXY);
const newPwd = newPwdArg || randomPassword(20);
console.log(`[probe] 改密 ${email}  新密码=${newPwd}`);

changeMailcomPassword(email, oldPwd, newPwd).then((r) => {
    console.log("=== 结果 ===");
    console.log(JSON.stringify(r, null, 2));
    process.exit(r.ok ? 0 : 1);
}).catch((e) => {
    console.error("改密异常:", e?.message ?? e);
    process.exit(1);
});
