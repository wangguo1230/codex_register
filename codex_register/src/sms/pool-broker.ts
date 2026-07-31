// @ts-nocheck
// 离线号码池的 SMS broker：实现 ISMSActivationBroker。
// 号从本地接码池(pool-db)借出，收码链接用【模板 + 手机号】拼(eccaptcha 的 key/project 通用)。
//
// 计费安全(接码收费，绝不浪费)：
//   - getActivation 只是【借出】(claimed)，不算消耗；
//   - 只有提交手机号给 OpenAI 成功(sendPhoneOtp OK)后才 markAsUsed(claimed → used)；
//   - 提交被拒(4xx) → markAsFailed(true) 标坏号换号；提交临时失败(429/5xx/网络) → markAsFailed(false) 释放回池；
//   - 一旦提交成功(号已消耗)，收码超时也【不换号】(由 openai.ts resolveAddPhone 控制)。
import {fetchSmsCode, buildSmsLink, peekSms, classifySms} from "../sms-broker.js";
import {claimSms, claimSmsByPhone, markSmsUsed, markSmsBad, releaseSms, restoreSms} from "./pool-db.js";

// preferPhone: 优先复用的已绑定接码号(rt 过期重取时传入)。仅首次取号尝试复用，失败后回落到号池。
// maxBind: 每个号最多绑定几个账号(0=不限，直到被拒)。号池取号时允许复用未达上限的 used 号。
export function createPoolBroker({email, linkTemplate = "", attempts = 24, intervalMs = 5000, preferPhone = "", maxBind = 0, log = () => {}}) {
    let current = null;   // 当前借出的号 {id, phone, link, card}
    let boundPhone = "";  // 最终真正消耗并验证通过的号(回写账号)
    let boundCard = "";   // 对应的卡密(新格式，导出用)
    let preferTried = false; // preferPhone 只在首次取号尝试一次

    return {
        get boundPhone() { return boundPhone; },
        get boundCard() { return boundCard; },
        async getActivation() {
            let s = null;
            // rt 过期重取：首次优先复用账号已绑定的号(该号 OpenAI 侧已验证，同号再收一次码即可)
            if (preferPhone && !preferTried) {
                preferTried = true;
                s = await claimSmsByPhone(preferPhone, email);
                if (s) log(`♻️ 复用已绑定接码号 +${s.phone}(rt 重取)`);
                else log(`⚠️ 绑定号 +${preferPhone} 不在接码池，回落到可用号池`);
            }
            if (!s) s = await claimSms(email, maxBind);
            if (!s) throw new Error("接码池已空，无可用号码(请导入接码，或已全部成坏号/达绑定上限)");
            // 收码链接：优先用号自带的 link(老格式)，否则用模板+手机号拼(eccaptcha 通用 key)
            const link = s.link || buildSmsLink(linkTemplate, s.phone);
            if (!link) throw new Error(`接码号 ${s.phone} 无收码链接：请在接码设置里配置链接模板`);
            current = {...s, link};
            log(`📱 借出接码号 +${s.phone}(使用中，尚未消耗)`);
            return {
                phoneNumber: s.phone, // 不带 +，openai.ts 内部拼 `+${phoneNumber}`
                // 提交前预检：peek 一次判断号在接码平台是否有效('fatal'=未注册/无效 → 上层换号，避免白提交)
                precheck: async () => {
                    try { return classifySms(await peekSms(link)).kind; } catch { return "waiting"; }
                },
                waitForVerificationCode: async (opts = {}) => {
                    const code = await fetchSmsCode(link, {attempts, intervalMs, log, excludeCode: opts.excludeCode || ""});
                    return {code};
                },
            };
        },
        // 提交手机号成功 = 号真正消耗：claimed → used(此后即使收码超时也不释放、不换号)
        async markAsUsed() {
            if (current) {
                try { await markSmsUsed(current.id, email); } catch (_) { /* ignore */ }
                boundPhone = current.phone;
                boundCard = current.card || "";
                log(`📌 +${current.phone}${current.card ? ` 卡密${current.card}` : ""} 提交成功，标记已消耗(used)`);
            }
        },
        // 收码+校验成功：号已是 used，仅确认绑定
        async markAsSucceed() {
            if (current) { boundPhone = current.phone; boundCard = current.card || ""; log(`✅ +${current.phone} 手机验证通过`); current = null; }
        },
        // 提交/验证失败：rotate=false→恢复原状态(临时失败,号未消耗)；rotate=true→标坏号换号。
        // ★ 【复用的 used 号】(之前已成功绑过账号,是好号)即使要求换号也【不标坏】——这次失败多为 OpenAI 对新账号的风控/旧码残留,不是号坏,标坏会浪费好号。
        // ★★ 例外:opts.exhausted(phone_max_usage_exceeded,号在 OpenAI 侧绑定已达上限)= 该号对任何新账号都永久失效,
        //     必须无条件标坏剔除,不受"复用好号不标坏"豁免——否则恢复回 used 又被优先复用,同一坏号死循环空转。
        async markAsFailed(rotate, opts = {}) {
            if (current) {
                const exhausted = !!opts.exhausted;
                const wasReused = current.status === "used"; // claim 时已是 used = 复用的在用好号
                if (!exhausted && (rotate === false || wasReused)) {
                    const orig = current.status && current.status !== "claimed" ? current.status : "free";
                    try { await restoreSms(current.id, orig); } catch (_) { /* ignore */ }
                    log(`↩️ +${current.phone} 失败，恢复为 ${orig}${wasReused && rotate !== false ? "(复用好号，不标坏)" : "(未消耗)"}`);
                } else {
                    try { await markSmsBad(current.id, email); } catch (_) { /* ignore */ }
                    log(`⚠️ +${current.phone} 号作废，标坏号并换号${exhausted ? "(已达绑定上限，永久剔除)" : ""}`);
                }
                if (boundPhone === current.phone) { boundPhone = ""; boundCard = ""; }
                current = null;
            }
        },
    };
}
