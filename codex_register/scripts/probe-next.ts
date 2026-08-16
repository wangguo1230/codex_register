import {readFileSync} from "node:fs";
import {createBitWindow, openBitWindow, closeBitWindow, deleteBitWindow, bitHealth} from "../src/bitbrowser.ts";
import {chromium} from "playwright-core";
import {rotateKookeeySession} from "../src/mail/proxy-pool.ts";

const settings = JSON.parse(readFileSync(new URL("../data/settings.json", import.meta.url), "utf8"));
const proxy = rotateKookeeySession((settings.mailProxyPool || [])[0] || "");
if (!await bitHealth()) throw new Error("比特未启动");
const bitId = await createBitWindow({proxy, name: "probe-next", remark: "probe-next"});
try {
    const {ws} = await openBitWindow(bitId);
    const browser = await chromium.connectOverCDP(ws);
    const page = (browser.contexts()[0] || await browser.newContext()).pages()[0]
        || await (browser.contexts()[0] || await browser.newContext()).newPage();
    page.setDefaultTimeout(20000);
    const url = "https://accounts.google.com/ServiceLogin?hl=en&continue=https://myaccount.google.com/security?hl=en";
    try {
        await page.goto(url, {waitUntil: "domcontentloaded", timeout: 30000});
    } catch (e) {
        console.log("GOTO_ERR", String(e?.message || e).slice(0, 200));
    }
    await page.waitForTimeout(3000);
    console.log("URL", page.url());
    const email = page.locator('input[name="identifier"], #identifierId').first();
    console.log("EMAIL_VISIBLE", await email.isVisible().catch(() => false));
    if (await email.isVisible().catch(() => false)) {
        await email.fill("paulynlfernandez11@gmail.com");
        await page.waitForTimeout(500);
    }
    const dump = await page.evaluate(() => {
        const nodes = [...document.querySelectorAll("button, [role=button], #identifierNext, #passwordNext, #totpNext, div, span")];
        return nodes
            .filter((el) => {
                const t = (el.innerText || el.textContent || "").replace(/\s+/g, " ").trim();
                const id = el.id || "";
                return /next|identifierNext|passwordNext/i.test(t + " " + id) && t.length < 40;
            })
            .slice(0, 20)
            .map((el) => {
                const r = el.getBoundingClientRect();
                const st = getComputedStyle(el);
                return {
                    tag: el.tagName,
                    id: el.id,
                    role: el.getAttribute("role"),
                    jsname: el.getAttribute("jsname"),
                    text: (el.innerText || "").replace(/\s+/g, " ").trim().slice(0, 40),
                    vis: st.visibility,
                    display: st.display,
                    w: Math.round(r.width),
                    h: Math.round(r.height),
                };
            });
    });
    console.log("CANDIDATES", JSON.stringify(dump, null, 2));
    const tries = [
        "#identifierNext",
        "#identifierNext button",
        'button:has-text("Next")',
        '[role=button]:has-text("Next")',
    ];
    for (const sel of tries) {
        const loc = page.locator(sel).first();
        const vis = await loc.isVisible().catch(() => false);
        const cnt = await page.locator(sel).count().catch(() => 0);
        let err = "";
        if (vis) {
            try { await loc.click({timeout: 4000}); err = "ok"; }
            catch (e) { err = String(e?.message || e).slice(0, 180); }
        }
        console.log("CLICK", sel, {vis, cnt, err});
        await page.waitForTimeout(800);
        console.log(" AFTER", page.url().slice(0, 100));
    }
    await email.press("Enter").catch((e) => console.log("ENTER_ERR", String(e.message || e).slice(0, 120)));
    await page.waitForTimeout(2000);
    console.log("AFTER_ENTER", page.url());
    console.log("BODY", String(await page.innerText("body").catch(() => "")).replace(/\s+/g, " ").slice(0, 300));
} finally {
    await closeBitWindow(bitId);
    await deleteBitWindow(bitId);
}
