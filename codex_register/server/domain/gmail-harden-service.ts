// @ts-nocheck
// 单邮箱 Gmail 整备用例：执行缺口计划、Worker、检查点和异常补偿，不负责队列认领。
import {
    classifyHardenIssue,
    classifyHardenLoginError,
    hardenAlreadyProven,
    HARDEN_ATTEMPT_MAX,
    HARDEN_PROXY_ROTATE_MAX,
    isCredentialDead,
    isHardenIpError,
    isHardenLoginDead,
    planHardenSkip,
} from "../../src/mail/google-state.js";

function formatStamp(timestamp) {
    const date = new Date(timestamp);
    const pad = (value) => String(value).padStart(2, "0");
    return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function createGmailHardenService({
    store,
    withProxy,
    runWorker,
    applyResult,
    runtime,
    effects,
    maskProxy,
    sessionOf,
    instanceId,
    now = () => Date.now(),
} = {}) {
    return async function runOneGoogleHarden(id, options = {}) {
        const mailbox = await store.getMailbox(id);
        if (!mailbox) return {ok: false, error: "邮箱不存在"};
        if (mailbox.provider !== "google") return {ok: false, error: "仅 Gmail 老号可整备"};
        if (runtime.isStopped()) return {ok: false, error: "已停止"};

        const skip = planHardenSkip(mailbox);
        const initialState = mailbox.google_state && typeof mailbox.google_state === "object" ? mailbox.google_state : {};
        if (Number(initialState.harden_attempts || 0) >= HARDEN_ATTEMPT_MAX) {
            effects.log(id, `[整备] 已试满 ${HARDEN_ATTEMPT_MAX} 次，不再登录`);
            return {ok: false, error: `已试满${HARDEN_ATTEMPT_MAX}次，不再登录`};
        }
        if (skip.all || skip.usable) {
            effects.log(id, skip.all ? "[整备] 缺口已齐，不再开窗" : "[整备] 2FA+IMAP 已齐，不再开窗补加分项");
            await store.refreshGoogleState(id, {login: "ok", last_error: "", imap: "ok", totp_rotated: true}).catch(() => {});
            return {
                ok: true,
                skipped: true,
                password: mailbox.password,
                totpRotated: true,
                totpChanged: false,
                imapPassword: mailbox.imap_password,
                recoveryCleared: true,
                passwordChanged: true,
                devicesDone: true,
            };
        }

        const attemptNo = Number(initialState.harden_attempts || 0) + 1;
        await store.refreshGoogleState(id, {harden_attempts: attemptNo}).catch(() => {});
        effects.log(id, `[整备] 第 ${attemptNo}/${HARDEN_ATTEMPT_MAX} 次 · 续跑 ${skip.left.join("/")}${skip.usable ? "（底线已齐，补加分项）" : ""}`);
        const abortController = new AbortController();
        runtime.abortControllers.set(id, abortController);
        runtime.current.set(id, {id, email: mailbox.email, lastLine: "开始整备"});
        let lastPersistedLineAt = 0;
        const logStep = (message) => {
            effects.log(id, message);
            const current = runtime.current.get(id);
            if (current) current.lastLine = String(message || "").slice(0, 180);
            effects.scheduleBroadcast();
            const timestamp = now();
            if (options.jobId && timestamp - lastPersistedLineAt > 800) {
                lastPersistedLineAt = timestamp;
                store.setJobLine(options.jobId, `${mailbox.email}: ${String(message || "").slice(0, 140)}`).catch(() => {});
            }
        };
        logStep(`[整备] 续跑 ${skip.left.join(" → ")}`);

        try {
            const result = await withProxy(mailbox.email, (proxyUrl, jumpUrl, remember) => {
                if (runtime.isStopped() || abortController.signal.aborted) throw new Error("已停止");
                const session = sessionOf(proxyUrl);
                logStep(`[整备] 代理 ${maskProxy(proxyUrl)}${session ? " session=" + session : ""}（一号一代理 · ${mailbox.proxy_url ? "复用出口" : "新出口"}${jumpUrl ? " · 跳板 " + jumpUrl : ""}）`);
                return runWorker({
                    kind: "harden",
                    proxyUrl,
                    jumpUrl,
                    mailbox: {
                        email: mailbox.email,
                        password: mailbox.password,
                        totpSecret: mailbox.totp_secret || "",
                        recoveryEmail: mailbox.recovery_email || "",
                        imap_password: mailbox.imap_password || "",
                        pw_status: mailbox.pw_status || "",
                        google_state: mailbox.google_state || {},
                    },
                }, {
                    signal: abortController.signal,
                    log: logStep,
                    onProxy: remember,
                    onCheckpoint: async (patch = {}) => {
                        if (patch.password) {
                            if (patch.verified === false) {
                                logStep(`[留痕] 改密未验证，不覆盖库内密码 候选=${patch.password}`);
                            } else {
                                await store.setPassword(id, patch.password, `✅改密(已验证) ${formatStamp(now())}`);
                                logStep("[落库] 新密码已写入（已验证）");
                            }
                        }
                        if (patch.totpSecret) {
                            const committed = await store.commitTotp(
                                id,
                                patch.totpSecret,
                                patch.totpPrevious || mailbox.totp_secret,
                            );
                            if (committed.ok) {
                                if (committed.totp) mailbox.totp_secret = committed.totp;
                                logStep(committed.unchanged ? "[落库] TOTP 已是这把，未覆盖" : "[落库] 新 TOTP 已写入（已验证）");
                            } else if (committed.reason === "stale") {
                                logStep("[落库] 本轮 TOTP 未覆盖：库里已是其他实例验证过的密钥");
                            } else {
                                logStep(`[落库] TOTP 未写入(${committed.reason || "失败"})`);
                            }
                        }
                        if (patch.imapPassword) await store.applyUpdate(mailbox.email, {imap_password: patch.imapPassword});
                        if (patch.recoveryCleared) await store.applyUpdate(mailbox.email, {recovery_email: ""});
                    },
                });
            }, mailbox);

            await applyResult(id, mailbox, result);
            const missing = (result.missing || []).join("/") || (result.ok ? "" : "部分步骤失败");
            const errorBrief = (result.errors || [])
                .map((error) => String(error).split("\n")[0])
                .join("；")
                .slice(0, 200);
            logStep(`[整备] ${result.ok ? "完成" : "部分失败"} 机=${instanceId} 缺=${missing || "无"} ${errorBrief}`.slice(0, 240));
            await effects.syncMailboxes();
            return {
                ok: !!result.ok,
                password: result.password,
                totpSecret: result.totpSecret,
                totpRotated: !!result.totpRotated,
                passwordChanged: !!result.passwordChanged,
                imapPassword: result.imapPassword || "",
                imap: !!result.imapPassword,
                recoveryCleared: !!result.recoveryCleared,
                phoneCleared: !!result.phoneCleared,
                devicesDone: !!result.devicesDone,
                missing: result.missing || [],
                errors: result.errors || [],
                skipped: !!result.skipped,
            };
        } catch (error) {
            const message = String(error?.message ?? error);
            const browserClosed = /has been closed|Target closed|browser has been closed/i.test(message);
            const stopped = runtime.isStopped()
                || abortController.signal.aborted
                || (/已停止/.test(message) && !browserClosed);
            const reason = stopped
                ? "已停止"
                : browserClosed ? "比特窗口被关掉（未登录或被限频踢下线）" : message;
            logStep(`[整备] ${stopped ? "已停止" : "异常"}: ${reason}`);
            const state = mailbox.google_state && typeof mailbox.google_state === "object" ? mailbox.google_state : {};
            const shortError = classifyHardenIssue(reason) || reason.slice(0, 160);
            const proven = hardenAlreadyProven(mailbox, state);
            const credentialDead = isCredentialDead(reason) || /账号已停用/.test(reason);
            if (!stopped && isHardenIpError(reason)) {
                await store.setProxy(id, "", "");
                mailbox.proxy_url = "";
                mailbox.proxy_ip = "";
                const rotations = Number(state.proxy_rotates || 0) + 1;
                const overlay = {proxy_rotates: rotations, last_error: shortError};
                if (rotations >= HARDEN_PROXY_ROTATE_MAX && !proven) {
                    overlay.login = "fail";
                    overlay.login_error = "rejected";
                    logStep(`[整备] 出口已换 ${rotations} 次仍过不去，判失败`);
                } else {
                    logStep(`[整备] 出口不行，丢掉粘性 IP，再换 ${HARDEN_PROXY_ROTATE_MAX - rotations} 次`);
                }
                await store.refreshGoogleState(id, overlay).catch(() => {});
            } else if (!stopped && (credentialDead || (!proven && isHardenLoginDead(reason)))) {
                await store.refreshGoogleState(id, {
                    login: "fail",
                    login_error: classifyHardenLoginError(reason),
                    last_error: shortError,
                }).catch(() => {});
            } else if (!stopped) {
                await store.refreshGoogleState(id, {last_error: shortError}).catch(() => {});
            }
            return {ok: false, error: reason};
        } finally {
            runtime.abortControllers.delete(id);
            runtime.current.delete(id);
            effects.scheduleBroadcast();
        }
    };
}
