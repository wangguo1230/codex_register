// @ts-nocheck
// 注册引擎(架构 v2:业务差异收敛点)
//   把"某业务域如何注册一个邮箱"封装为可插拔单元。引擎负责两类业务知识:
//     1) buildSpawn      —— 选哪个 worker 脚本 + 传什么环境变量(如何"跑")
//     2) onResult/onAbnormalExit —— 如何"解释"worker 产出(成功/失败→写库/标记状态)
//   调度器(scheduler)只负责通用的进程生命周期/并发/事件循环,不内嵌任何业务的注册知识,
//   故对 GPT / Claude 完全对称:换域=换引擎,job runner 一行不改。
//   - GptRegisterEngine:已实现(http/browser/bit 三种 worker + 结果解释)。
//   - ClaudeRegisterEngine:占位,待 Claude 注册机制确定(见 ARCHITECTURE-v2 §8 D1)。
// 注:邮箱改密是邮箱管理域职责(导入后自动改密/手动/批量),注册流程不越界改邮箱密码(职责归一化)。
import * as db from "../db.js";

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
            MAIL_PROVIDER: acc.provider || "mailcom",
            MAILCOM_TOKENS_FILE: tmpFile,
            ICLOUD_TOKENS_FILE: tmpFile,
            MAILCOM_HEADLESS: "1",
            REG_OTP_SINGLE: cfg.otpSingle ? "1" : "0",
            REG_SIMULATE_CHAT: cfg.simulateChat ? "1" : "0",
            REG_TRY_RT: cfg.rtEnabled ? "1" : "0",
            // 拿 rt 走 codex OAuth 强制 add-phone，必须有接码池 → rt 开启时强制启用 SMS
            REG_SMS: (cfg.smsEnabled || cfg.rtEnabled) ? "1" : "0",
            SMS_LINK_TEMPLATE: cfg.smsLinkTemplate || "",
            SMS_MAX_BIND: String(cfg.smsMaxBind ?? 0), // 每号绑定上限，broker 复用号时用
            // PG 迁移后 worker 通过 process.env.DATABASE_URL 继承连接(无需 REG_DB_PATH)
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
    async onResult(runner, id, ev) {
        if (ev.status === "success") {
            await db.markSuccess(id, {token: ev.token, authFile: ev.authFile, plan: ev.plan});
            if (ev.rtFile) await db.setAccountRtFile(id, ev.rtFile); // 回写含 rt 的 codex auth 文件路径
            if (ev.phone) await db.setAccountPhone(id, ev.phone);    // 回写绑定的接码手机号
            if (ev.card) await db.setAccountCard(id, ev.card);       // 回写绑定的卡密(导出用)
            // 注册完成即按产出直接标记状态(网页 token 刚生成必有效;rt/养号按实际结果)，无需手动点"测"
            await db.setTestStatus(id, "at", ev.token ? "✅有效" : "无at");
            if (ev.rtFile) await db.setTestStatus(id, "rt", "✅有效");
            else if (runner.rtEnabled) await db.setTestStatus(id, "rt", "❌注册未取到");
            if (ev.chatOk === true) await db.setTestStatus(id, "chat", "✅回复成功");
            else if (ev.chatOk === false) await db.setTestStatus(id, "chat", "❌未回复");
            runner.emit("sms", {stats: await db.smsStats()}); // 接码池状态变化 → 前端刷新
            runner.log(id, `✅ 注册成功 plan=${ev.plan || "?"}`);
        } else {
            await db.markFailed(id, ev.error);
            runner.log(id, `❌ 失败: ${ev.error}`);
        }
        runner.emit("status", {id, status: ev.status, ...(await db.getAccount(id))});
        runner.emit("stats", await db.stats());
    },

    /** worker 没发 result 事件就退出 = 异常,判失败。 */
    async onAbnormalExit(runner, id, code) {
        await db.markFailed(id, `worker 异常退出 code=${code}`);
        runner.log(id, `❌ worker 异常退出 code=${code}`);
        runner.emit("status", {id, status: "failed", ...(await db.getAccount(id))});
    },
};

/**
 * Claude 注册引擎(probe 验证机制后填实):magic-link 注册,比特浏览器 + 代理过 CF。
 * 流程 worker 化在 src/worker-register-claude.ts;产出 sessionKey/org_id/auth 文件写 claude_accounts。
 * 接口与 GptRegisterEngine 对称,接同一 job runner。
 */
export const ClaudeRegisterEngine = {
    domain: "claude",
    buildSpawn(acc, cfg, tmpFile) {
        return {
            script: "src/worker-register-claude.ts",
            env: {
                REG_EMAIL: acc.email,
                REG_PASSWORD: acc.password,        // 邮箱密码(收 magic link 用)
                MAILCOM_TOKENS_FILE: tmpFile,
                MAILCOM_HEADLESS: "1",             // 收信无头
                PROXY_URL: cfg.claudeProxy || cfg.regProxy || "", // Claude 独立代理(过 claude.ai CF),空则回退 regProxy
                BITBROWSER: "1",                   // Claude 固定用比特浏览器(独立指纹过 CF)
                // 不再固定姓名:worker 内每号随机生成(打散批量同名特征)。如需固定可在此设 CLAUDE_NAME。
            },
        };
    },
    // 注:详细过程日志由 job runner 按域落 mailbox_logs(见 scheduler.logJob),此处不再 runner.log(避免 claude/gpt id 在 logs 表碰撞)。
    async onResult(runner, id, ev) {
        if (ev.status === "success") await db.markClaudeSuccess(id, {sessionKey: ev.sessionKey, orgId: ev.orgId, authFile: ev.authFile, plan: ev.plan});
        else await db.markClaudeFailed(id, ev.error);
        runner.emit("claude", {stats: await db.claudeStats()}); // ClaudePanel 刷新
    },
    async onAbnormalExit(runner, id, code) {
        await db.markClaudeFailed(id, `worker 异常退出 code=${code}`);
        runner.emit("claude", {stats: await db.claudeStats()});
    },
};

/** 按业务域选引擎(编排层唯一入口)。 */
export function resolveEngine(domain) {
    if (domain === "claude") return ClaudeRegisterEngine;
    return GptRegisterEngine;
}
