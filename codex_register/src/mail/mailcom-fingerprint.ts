// mail.com Playwright 指纹：一号一桌面画像，时区跟粘性出口走，去掉 webdriver。
import type {BrowserContext, Page} from "playwright-core";
import {
    generateDesktopDeviceProfile,
    getDeviceClientHints,
    isDeviceProfile,
    type DeviceProfile,
} from "../device-profile.js";
import {timezoneFromExitUrl} from "./proxy-chain.js";

const MAILCOM_LOCALE = {
    locale: "en-US",
    languages: ["en-US", "en"],
    acceptLanguage: "en-US,en;q=0.9",
};

export function ensureMailcomProfile(stored: any, exitUrl = ""): DeviceProfile {
    const base = isDeviceProfile(stored) ? {...stored, languages: [...(stored.languages || MAILCOM_LOCALE.languages)]} : generateDesktopDeviceProfile();
    const tz = timezoneFromExitUrl(exitUrl) || base.timezoneId || "America/New_York";
    return {
        ...base,
        family: "desktop",
        isMobile: false,
        hasTouch: false,
        timezoneId: tz,
        locale: MAILCOM_LOCALE.locale,
        languages: [...MAILCOM_LOCALE.languages],
        acceptLanguage: MAILCOM_LOCALE.acceptLanguage,
    };
}

export function playwrightContextOptions(profile: DeviceProfile) {
    const hints = getDeviceClientHints(profile);
    return {
        viewport: {width: profile.viewportWidth, height: profile.viewportHeight},
        screen: {width: profile.screenWidth, height: profile.screenHeight},
        deviceScaleFactor: profile.deviceScaleFactor,
        locale: profile.locale,
        timezoneId: profile.timezoneId,
        userAgent: profile.userAgent,
        isMobile: false,
        hasTouch: false,
        colorScheme: "light" as const,
        extraHTTPHeaders: {
            "accept-language": profile.acceptLanguage,
            "sec-ch-ua": hints.secChUa,
            "sec-ch-ua-mobile": hints.secChUaMobile,
            "sec-ch-ua-platform": hints.secChUaPlatform,
        },
    };
}

export async function applyMailcomFingerprint(context: BrowserContext, page: Page, profile: DeviceProfile) {
    await context.addInitScript((p: DeviceProfile) => {
        const hide = (obj: object, key: string, value: unknown) => {
            try { Object.defineProperty(obj, key, {get: () => value, configurable: true}); } catch { /* */ }
        };
        hide(Navigator.prototype, "webdriver", undefined);
        hide(navigator, "webdriver", undefined);
        hide(navigator, "language", p.languages[0] || "en-US");
        hide(navigator, "languages", p.languages || ["en-US", "en"]);
        hide(navigator, "platform", p.platform || "Win32");
        hide(navigator, "hardwareConcurrency", p.hardwareConcurrency || 8);
        hide(navigator, "deviceMemory", p.deviceMemory || 8);
        hide(navigator, "maxTouchPoints", 0);
        hide(navigator, "vendor", p.vendor || "Google Inc.");
        const chromeObj = (window as any).chrome || {};
        chromeObj.runtime = chromeObj.runtime || {};
        (window as any).chrome = chromeObj;
        if (!navigator.plugins || navigator.plugins.length === 0) {
            hide(navigator, "plugins", [{name: "PDF Viewer"}, {name: "Chrome PDF Viewer"}, {name: "Chromium PDF Viewer"}] as any);
        }
    }, profile).catch(() => {});

    try {
        const cdp = await context.newCDPSession(page);
        const hints = getDeviceClientHints(profile);
        const major = (profile.userAgent.match(/(?:Chrome|Edg)\/(\d+)/) || [])[1] || "151";
        const full = (profile.userAgent.match(/(?:Chrome|Edg)\/([\d.]+)/) || [])[1] || `${major}.0.0.0`;
        const brands = hints.secChUa.split(", ").map((part) => {
            const m = part.match(/"([^"]+)";v="([^"]+)"/);
            return m ? {brand: m[1], version: m[2]} : {brand: "Chromium", version: major};
        });
        await cdp.send("Emulation.setTimezoneOverride", {timezoneId: profile.timezoneId}).catch(() => {});
        await cdp.send("Emulation.setLocaleOverride", {locale: profile.locale}).catch(() => {});
        await cdp.send("Network.setUserAgentOverride", {
            userAgent: profile.userAgent,
            acceptLanguage: profile.acceptLanguage,
            platform: profile.platform || "Win32",
            userAgentMetadata: {
                brands,
                fullVersionList: brands.map((b) => ({brand: b.brand, version: b.brand.includes("Not") ? "24.0.0.0" : full})),
                platform: "Windows",
                platformVersion: "15.0.0",
                architecture: "x86",
                model: "",
                mobile: false,
                bitness: "64",
                wow64: false,
            },
        } as any).catch(() => {});
    } catch { /* 无 CDP 也不挡登录 */ }
}
