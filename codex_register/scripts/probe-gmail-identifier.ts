import pg from "pg";
import {readFileSync, mkdirSync} from "node:fs";
import path from "node:path";
import {withGoogleBitSession} from "../src/mail/google-secure.ts";

const DATABASE_URL = process.env.DATABASE_URL || "postgresql://postgres:123456@192.168.1.126:5432/all_register";
const pool = new pg.Pool({connectionString: DATABASE_URL});
const {rows: [mb]} = await pool.query(
    `SELECT * FROM mailboxes WHERE email=$1`,
    ["buenosmaruchi2@gmail.com"],
);
await pool.end();
const settings = JSON.parse(readFileSync(new URL("../data/settings.json", import.meta.url), "utf8"));
const proxyUrl = (settings.mailProxyPool || [])[3] || (settings.mailProxyPool || [])[0] || "";
const dir = path.resolve(process.cwd(), "captures", "screenshots");
mkdirSync(dir, {recursive: true});

await withGoogleBitSession({proxyUrl, name: "probe-id", remark: "probe-identifier", log: console.log}, async (page) => {
    page.setDefaultTimeout(20000);
    await page.goto("https://accounts.google.com/ServiceLogin?hl=en&continue=https://myaccount.google.com/security?hl=en", {
        waitUntil: "domcontentloaded", timeout: 40000,
    }).catch((e) => console.log("GOTO", e.message));
    await page.waitForTimeout(4000);
    console.log("URL0", page.url());
    console.log("FRAMES", page.frames().map((f) => f.url()).slice(0, 8));
    const dump = await page.evaluate(() => {
        const inputs = [...document.querySelectorAll("input")].slice(0, 12).map((el) => ({
            name: el.name, type: el.type, id: el.id, vis: !!(el.offsetWidth && el.offsetHeight),
            val: String(el.value || "").slice(0, 30),
        }));
        const btns = [...document.querySelectorAll("button, [role=button], #identifierNext")].slice(0, 15).map((el) => {
            const r = el.getBoundingClientRect();
            return {
                tag: el.tagName, id: el.id, text: (el.innerText || "").replace(/\s+/g, " ").trim().slice(0, 30),
                dis: !!(el as HTMLButtonElement).disabled, aria: el.getAttribute("aria-disabled"),
                w: Math.round(r.width), h: Math.round(r.height),
            };
        });
        return {title: document.title, inputs, btns, body: (document.body.innerText || "").replace(/\s+/g, " ").slice(0, 200)};
    });
    console.log("DUMP", JSON.stringify(dump, null, 2));
    const email = page.locator('input[name="identifier"], #identifierId').first();
    console.log("EMAIL_VIS", await email.isVisible().catch(() => false));
    if (await email.isVisible().catch(() => false)) {
        await email.click();
        await email.fill("");
        await email.pressSequentially(mb.email, {delay: 40});
        await page.waitForTimeout(800);
        console.log("EMAIL_VAL", await email.inputValue());
        await page.screenshot({path: path.join(dir, "probe_id_filled.png")});
        await email.press("Enter");
        await page.waitForTimeout(3000);
        console.log("AFTER_ENTER", page.url());
        await page.screenshot({path: path.join(dir, "probe_id_enter.png")});
        if (/identifier/i.test(page.url())) {
            const next = page.locator("#identifierNext button, #identifierNext, button:has-text('Next')").first();
            console.log("NEXT_VIS", await next.isVisible().catch(() => false), "CNT", await page.locator("button:has-text('Next')").count());
            await next.click({timeout: 4000}).catch((e) => console.log("CLICK_ERR", e.message.slice(0, 160)));
            await page.waitForTimeout(4000);
            console.log("AFTER_CLICK", page.url());
            await page.screenshot({path: path.join(dir, "probe_id_click.png")});
        }
    }
});
console.log("PROBE_DONE");
