// @ts-nocheck
// Gmail 整备结果落库与状态推导，不负责浏览器执行和任务调度。
import {
    classifyHardenIssue,
    classifyHardenLoginError,
    hardenAlreadyProven,
    isCredentialDead,
    isHardenLoginDead,
    planHardenSkip,
} from "../../src/mail/google-state.js";

function formatStamp(timestamp) {
    const date = new Date(timestamp);
    const pad = (value) => String(value).padStart(2, "0");
    return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function createGmailHardenResultApplier({store, now = () => Date.now()} = {}) {
    return async function applyGoogleHardenResult(id, mailbox, result) {
        const alreadyUsable = planHardenSkip(mailbox).usable;
        const stamp = formatStamp(now());
        if (result.passwordChanged && result.password) {
            await store.setPassword(id, result.password, result.ok ? `✅整备 ${stamp}` : `✅改密 ${stamp}`);
        } else if (result.ok) {
            await store.setPasswordStatus(id, `✅整备 ${stamp}`);
        } else if (!result.skipped && !alreadyUsable && !/^✅改密/.test(String(mailbox.pw_status || ""))) {
            await store.setPasswordStatus(id, `⚠整备部分 ${stamp}`);
        }

        if (result.totpChanged && result.totpSecret) {
            await store.commitTotp(id, result.totpSecret, mailbox.totp_secret);
        }
        await store.applyUpdate(mailbox.email, {
            imap_password: result.imapPassword || undefined,
            recovery_email: result.recoveryCleared ? "" : undefined,
        });

        const brief = (result.errors || [result.error])
            .filter(Boolean)
            .map((error) => String(error).split("\n")[0])
            .join("; ")
            .slice(0, 160);
        const state = mailbox.google_state && typeof mailbox.google_state === "object" ? mailbox.google_state : {};
        const proven = alreadyUsable || hardenAlreadyProven(mailbox, state);
        const credentialDead = isCredentialDead(brief) || isCredentialDead(result.error || "");
        const loginDead = credentialDead
            || (!proven && (result.login === false || isHardenLoginDead(brief) || isHardenLoginDead(result.error || "")));
        const imapRefused = /拒绝生成应用密码|error generating your app password/i.test(brief);
        const imapFailures = imapRefused ? Number(state.imap_gen_fail || 0) + 1 : state.imap_gen_fail;
        const loginOk = !!(result.ok || result.password || result.totpSecret || result.imapPassword);
        const stateNow = now();
        await store.refreshGoogleState(id, {
            login: loginOk ? "ok" : (loginDead ? "fail" : undefined),
            login_at: loginOk ? stateNow : undefined,
            login_error: loginDead ? classifyHardenLoginError(brief || result.error || "登录失败") : undefined,
            password: result.passwordChanged ? "ok" : undefined,
            totp: result.totpChanged && result.totpSecret ? "ok" : undefined,
            totp_rotated: result.totpChanged || result.totpRotated ? true : undefined,
            recovery: result.recoveryCleared ? "ok" : undefined,
            phone: result.phoneCleared ? "ok" : undefined,
            devices: result.devicesDone ? "ok" : undefined,
            imap: result.imapPassword
                ? "ok"
                : (result.errors || []).some((error) => /IMAP|应用密码/i.test(String(error))) ? "fail" : undefined,
            last_error: (result.ok || (result.imapPassword && (result.totpRotated || alreadyUsable)))
                ? ""
                : (classifyHardenIssue(brief) || brief),
            imap_gen_fail: imapRefused ? imapFailures : undefined,
            imap_next_try: imapRefused ? stateNow + 45 * 60 * 1000 * Number(imapFailures || 1) : undefined,
        }).catch(() => {});
    };
}
