// @ts-nocheck
// 子进程：给单个账号发一次聊天(用 auth 文件的 sessionToken 注入登录态)。
// stdout @@EVENT@@ 回传结果。env: CHAT_AUTH_FILE, CHAT_MESSAGE, PROXY_URL
import {readFileSync} from "node:fs";
import {simulateChat} from "./simulate-chat.js";

const EVENT = "@@EVENT@@";
const emit = (o) => console.log(EVENT + JSON.stringify(o));

const CHAT_MESSAGES = [
    "hello, how are you?",
    "What can you help me with today?",
    "Give me a fun fact, please.",
    "Tell me a short joke.",
    "What's a good productivity tip?",
    "Recommend a book to read.",
    "Teach me a new English word.",
];

async function main() {
    const authFile = process.env.CHAT_AUTH_FILE || "";
    const proxy = process.env.PROXY_URL || "";
    const msg = process.env.CHAT_MESSAGE || CHAT_MESSAGES[Math.floor(Date.now() / 1000) % CHAT_MESSAGES.length];
    if (!authFile) { emit({type: "result", ok: false, error: "缺少 CHAT_AUTH_FILE"}); return; }

    let sessionToken = "";
    try {
        const d = JSON.parse(readFileSync(authFile, "utf8"));
        const s = (d && d.session) || {};
        sessionToken = s.sessionToken || "";
    } catch (e) {
        emit({type: "result", ok: false, error: "读 auth 文件失败: " + (e && e.message ? e.message : e)});
        return;
    }
    if (!sessionToken) {
        emit({type: "result", ok: false, error: "auth 文件无 sessionToken，无法注入登录态"});
        return;
    }
    try {
        emit({type: "progress", message: `发送: ${msg}`});
        const ok = await simulateChat({sessionToken}, msg, proxy, (m) => emit({type: "progress", message: m}));
        emit({type: "result", ok, message: msg});
    } catch (e) {
        emit({type: "result", ok: false, error: String(e && e.message ? e.message : e)});
    }
}
main();
