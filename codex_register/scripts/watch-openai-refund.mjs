#!/usr/bin/env node
/**
 * 轮询 facudjirkian90@gmail.com 收件箱，看 OpenAI 退款相关回信。
 * 状态写到 data/refund-watch-facud.json；SUCCESS/DENIED 会 stdout 醒目一行。
 */
import { ImapFlow } from "imapflow";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const STATE = path.join(ROOT, "data", "refund-watch-facud.json");
const EMAIL = "facudjirkian90@gmail.com";

function bj(ts) {
  if (!ts) return "";
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
    hour12: false,
  }).format(new Date(ts)).replace(",", "");
}

function sourceText(raw) {
  let s = Buffer.isBuffer(raw) ? raw.toString("utf8") : String(raw || "");
  const idx = s.search(/\r?\n\r?\n/);
  if (idx >= 0) s = s.slice(idx + 1);
  return s
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/=\r?\n/g, "")
    .replace(/=([0-9A-F]{2})/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/\s+/g, " ")
    .trim();
}

function classify(from, subject, body) {
  const blob = `${from}\n${subject}\n${body}`;
  if (!/openai|chatgpt|stripe|support@openai|billing/i.test(blob) && !/refund|subscription/i.test(blob)) {
    return null;
  }
  if (/refund (has been |was )?(processed|issued|completed|successful)|we('ve| have) refunded|credited (back )?to your|your refund of|refund of \$/i.test(blob)) {
    return "SUCCESS";
  }
  if (/unable to process this refund|cannot refund|not eligible|denied|no refund|not been made/i.test(blob)) {
    return "CHANNEL_REFUSED"; // 邮件渠道拒处理，不等于财务一定不退
  }
  if (/received your (request|email)|looking into|will review|case number|ticket|within \d+/i.test(blob)) {
    return "PENDING_ACK";
  }
  if (/login code|temporary|multi-factor|sign-in/i.test(subject)) return "LOGIN_OR_SECURITY";
  if (/support@openai/i.test(from)) return "SUPPORT_REPLY";
  return "OTHER";
}

async function loadCred() {
  const url = process.env.DATABASE_URL || "postgresql://postgres:123456@192.168.1.126:5432/all_register";
  const pool = new pg.Pool({ connectionString: url });
  try {
    const { rows } = await pool.query(
      `SELECT email, imap_password FROM mailboxes WHERE lower(email)=lower($1)`,
      [EMAIL],
    );
    if (!rows[0]?.imap_password) throw new Error("no imap password");
    return { user: rows[0].email, pass: String(rows[0].imap_password).replace(/\s+/g, "") };
  } finally {
    await pool.end();
  }
}

async function main() {
  const prev = existsSync(STATE) ? JSON.parse(readFileSync(STATE, "utf8")) : {};
  const prevUids = new Set((prev.hits || []).map((h) => h.uid));
  const { user, pass } = await loadCred();
  const client = new ImapFlow({
    host: "imap.gmail.com", port: 993, secure: true,
    auth: { user, pass }, logger: false, emitLogs: false,
    connectionTimeout: 20000,
  });
  client.on("error", () => {});
  await client.connect();
  const lock = await client.getMailboxLock("INBOX");
  const hits = [];
  try {
    const status = await client.status("INBOX", { messages: true });
    const total = status.messages || 0;
    const from = Math.max(1, total - 59);
    for await (const msg of client.fetch(`${from}:*`, { envelope: true, source: true, uid: true })) {
      const env = msg.envelope || {};
      const fromAddr = (env.from || []).map((a) => `${a.name || ""} <${a.address || ""}>`).join(", ");
      const subject = String(env.subject || "");
      const ts = env.date ? new Date(env.date).getTime() : 0;
      const body = sourceText(msg.source).slice(0, 900);
      const statusGuess = classify(fromAddr, subject, body);
      if (!statusGuess) continue;
      const caseM = body.match(/Case Number:\s*(\d+)/i);
      hits.push({
        uid: msg.uid,
        dateBj: bj(ts),
        from: fromAddr.slice(0, 100),
        subject: subject.slice(0, 140),
        statusGuess,
        caseNumber: caseM?.[1] || "",
        body: body.slice(0, 400),
        isNew: !prevUids.has(msg.uid),
      });
    }
  } finally {
    lock.release();
    await client.logout().catch(() => {});
  }
  hits.sort((a, b) => String(b.dateBj).localeCompare(String(a.dateBj)));
  const success = hits.filter((h) => h.statusGuess === "SUCCESS");
  const refused = hits.filter((h) => h.statusGuess === "CHANNEL_REFUSED");
  const support = hits.filter((h) => /SUPPORT|PENDING|SUCCESS|CHANNEL/i.test(h.statusGuess));
  const state = {
    email: EMAIL,
    checkedAt: Date.now(),
    checkedAtBj: bj(Date.now()),
    success: success.length > 0,
    channelRefused: refused.length > 0,
    caseNumbers: [...new Set(hits.map((h) => h.caseNumber).filter(Boolean))],
    hits,
  };
  mkdirSync(path.dirname(STATE), { recursive: true });
  writeFileSync(STATE, JSON.stringify(state, null, 2));

  console.log(`[refund-watch] ${state.checkedAtBj} hits=${hits.length} new=${hits.filter((h) => h.isNew).length}`);
  for (const h of support.slice(0, 5)) {
    console.log(`  ${h.dateBj} [${h.statusGuess}] ${h.subject}${h.caseNumber ? " case=" + h.caseNumber : ""}`);
    if (h.isNew) console.log(`    NEW: ${h.body.slice(0, 220)}`);
  }
  if (success.length) {
    console.log("REFUND_SUCCESS");
    for (const h of success) console.log(h.dateBj, h.subject, h.body.slice(0, 200));
  } else if (refused.length && !prev.channelRefused) {
    console.log("REFUND_CHANNEL_REFUSED");
    console.log(refused[0].body.slice(0, 300));
  } else {
    console.log("REFUND_PENDING_NO_SUCCESS_YET");
  }
}

main().catch((e) => {
  console.error("[refund-watch] FAIL", e.message || e);
  process.exit(1);
});
