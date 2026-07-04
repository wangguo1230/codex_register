// @ts-nocheck
// 注册引擎(架构 v2:业务差异收敛点)
//   把"某业务域如何注册一个邮箱"封装为可插拔单元。引擎负责两类业务知识:
//     1) buildSpawn      —— 选哪个 worker 脚本 + 传什么环境变量(如何"跑")
//     2) onResult/onAbnormalExit —— 如何"解释"worker 产出(成功/失败→写库/标记状态)
//   调度器(scheduler)只负责通用的进程生命周期/并发/事件循环,不内嵌任何业务的注册知识,
//   故对 GPT / Claude 完全对称:换域=换引擎,job runner 一行不改。
//   - GptRegisterEngine:已实现(http/browser/bit 三种 worker + 结果解释 + 注册后改密)。
//   - ClaudeRegisterEngine:占位,待 Claude 注册机制确定(见 ARCHITECTURE-v2 §8 D1)。
import * as db from "../db.js";
import {changeMailcomPassword} from "./mailbox-service.js";
import {randomPassword} from "../../src/utils.js";

/**
 * @typedef {Object} SpawnSpec
 * @property {string} script  worker 脚本路径(相对 CODEX_ROOT)
 * @property {Record<string,string>} env  该 worker 需要的环境变量(不含 process.env,由调度器合并)
 */
/**
 * @typedef {Object} JobRunner  调度器(scheduler)对引擎暴露的通用能力,引擎只依赖这些通用点。
 * @property {(id:number,line:string)=>void} log         写日志(落库 + SSE)
 * @property {(event:string,data:any)=>void} emit        广播事件(status/stats/sms/...)
 * @property {boolean} rtEnabled                          运行配置:注册后是否取 rt
 * @property {boolean} autoChangePasswd                   运行配置:注册后是否自动改邮箱密码
 */

/** GPT 注册引擎:GPT 域的"如何注册 + 如何解释结果"全部知识收敛于此。 */
export const GptRegisterEngine = {
    domain: "gpt",

    /**
     * 构建 worker 启动描述(如何"跑"一个注册)。
     * @param {{email:string,password:string}} acc 待注册账号(邮箱+密码)
     * @param {JobRunner} cfg 运行配置(scheduler 实例:regEngine/otpSingle/... 等开关与代理)
     * @param {string} tmpFile worker 读取账密的临时文件(MAILCOM_TOKENS_FILE),由调度器创建/清理
     * @returns {SpawnSpec}
     */
    buildSpawn(acc, cfg, tmpFile) {
        const script = cfg.regEngine === "browser" ? "src/worker-register-browser.ts" : "src/worker-register.ts";
        const env = {
            REG_EMAIL: acc.email,
            REG_PASSWORD: acc.password,
            MAILCOM_TOKENS_FILE: tmpFile,
            MAILCOM_HEADLESS: "1",
            REG_OTP_SINGLE: cfg.otpSingle ? "1" : "0",
            REG_SIMULATE_CHAT: cfg.simulateChat ? "1" : "0",
            REG_TRY_RT: cfg.rtEnabled ? "1" : "0",
            // 拿 rt 走 codex OAuth 强制 add-phone，必须有接码池 → rt 开启时强制启用 SMS
            REG_SMS: (cfg.smsEnabled || cfg.rtEnabled) ? "1" : "0",
            SMS_LINK_TEMPLATE: cfg.smsLinkTemplate || "",
            SMS_MAX_BIND: String(cfg.smsMaxBind ?? 0), // 每号绑定上限，broker 复用号时用
            REG_DB_PATH: db.dbPath, // worker 直连同一 SQLite 管理接码池
            PROXY_URL: cfg.regProxy || "",
            MAILCOM_PROXY: cfg.mailProxy || "",
            BITBROWSER: cfg.bitBrowser ? "1" : "", // 比特浏览器:每号独立指纹窗口(仅浏览器引擎有效)
        };
        return {script, env};
    },

    /**
     * 解释一次 worker 的 result 事件(如何"读懂"注册产出)。GPT 域业务规则收敛于此。
     * @param {JobRunner} runner 调度器实例(通用能力 + 运行配置)
     * @param {number} id 账号 id
     * @param {object} ev result 事件(status/token/authFile/plan/rtFile/phone/card/chatOk/error)
     */
    onResult(runner, id, ev) {
        if (ev.status === "success") {
            db.markSuccess(id, {token: ev.token, authFile: ev.authFile, plan: ev.plan});
            if (ev.rtFile) db.setAccountRtFile(id, ev.rtFile); // 回写含 rt 的 codex auth 文件路径
            if (ev.phone) db.setAccountPhone(id, ev.phone);    // 回写绑定的接码手机号
            if (ev.card) db.setAccountCard(id, ev.card);       // 回写绑定的卡密(导出用)
            // 注册完成即按产出直接标记状态(网页 token 刚生成必有效;rt/养号按实际结果)，无需手动点"测"
            db.setTestStatus(id, "at", ev.token ? "✅有效" : "无at");
            if (ev.rtFile) db.setTestStatus(id, "rt", "✅有效");
            else if (runner.rtEnabled) db.setTestStatus(id, "rt", "❌注册未取到");
            if (ev.chatOk === true) db.setTestStatus(id, "chat", "✅回复成功");
            else if (ev.chatOk === false) db.setTestStatus(id, "chat", "❌未回复");
            runner.emit("sms", {stats: db.smsStats()}); // 接码池状态变化 → 前端刷新
            runner.log(id, `✅ 注册成功 plan=${ev.plan || "?"}`);
            if (runner.autoChangePasswd) this.autoChangePasswd(runner, id); // 异步改 mail 密码,不阻塞调度
        } else {
            db.markFailed(id, ev.error);
            runner.log(id, `❌ 失败: ${ev.error}`);
        }
        runner.emit("status", {id, status: ev.status, ...db.getAccount(id)});
        runner.emit("stats", db.stats());
    },

    /** worker 没发 result 事件就退出 = 异常,判失败。 */
    onAbnormalExit(runner, id, code) {
        db.markFailed(id, `worker 异常退出 code=${code}`);
        runner.log(id, `❌ worker 异常退出 code=${code}`);
        runner.emit("status", {id, status: "failed", ...db.getAccount(id)});
    },

    /** 注册成功后自动改 mail.com 密码为随机20位并同步库(异步,失败仅记日志不影响注册结果)。 */
    async autoChangePasswd(runner, id) {
        const acc = db.getAccount(id);
        if (!acc) return;
        const np = randomPassword(20);
        runner.log(id, `[改密] 注册后自动改密,新密码=${np}`); // 记明文:即使判失败也能用它登录挽救
        try {
            const r = await changeMailcomPassword(acc.email, acc.password, np, (m) => runner.log(id, `[改密] ${m}`));
            if (r?.ok) {
                db.updatePassword(id, np);
                db.setPwStatus(id, `✅已改${r.verified ? "(验证)" : "?未验证"}`);
                runner.log(id, `[改密] 成功,已同步库内密码`);
                runner.emit("status", {id, status: acc.status, ...db.getAccount(id)});
            } else {
                db.setPwStatus(id, `❌试过 ${np}·${String(r?.detail || "失败").slice(0, 30)}`); // 存明文新密码,失败可能实为成功→可用它登录挽救
                runner.log(id, `[改密] 失败(新密码 ${np} 已记录,可手动验证): ${r?.detail || "未见成功确认"}`);
                runner.emit("status", {id, status: acc.status, ...db.getAccount(id)});
            }
        } catch (e) {
            db.setPwStatus(id, `❌试过 ${np}·${String(e?.message || e).slice(0, 30)}`);
            runner.log(id, `[改密] 异常(新密码 ${np} 已记录): ${e?.message || e}`);
        }
    },
};

/**
 * Claude 注册引擎:占位。Claude/Anthropic 账号注册机制(邮箱注册?手机验证?产出何种凭证)未定,不能投机实现。
 * 接口与 GptRegisterEngine 对称(buildSpawn/onResult/onAbnormalExit),机制确定后填实即可接入同一 job runner。
 */
export const ClaudeRegisterEngine = {
    domain: "claude",
    buildSpawn() {
        throw new Error("Claude 注册引擎待实现:需先确定 Claude 注册机制(见 docs/ARCHITECTURE-v2.md §8 D1)");
    },
    onResult() {
        throw new Error("Claude 注册引擎待实现:onResult 需按 Claude 凭证模型定稿(见 docs/ARCHITECTURE-v2.md §8 D1)");
    },
    onAbnormalExit(runner, id, code) {
        // 通用兜底:异常退出判失败(不依赖 Claude 业务字段)
        runner.log(id, `❌ Claude worker 异常退出 code=${code}`);
    },
};

/** 按业务域选引擎(编排层唯一入口)。 */
export function resolveEngine(domain) {
    if (domain === "claude") return ClaudeRegisterEngine;
    return GptRegisterEngine;
}
