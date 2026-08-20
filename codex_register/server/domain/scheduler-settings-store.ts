// @ts-nocheck
import {existsSync, readFileSync, writeFileSync} from "node:fs";

export const SCHEDULER_SETTINGS_KEYS = ["concurrency", "otpSingle", "simulateChat", "regProxy", "mailProxy", "mailProxyEnabled", "smsEnabled", "smsLinkTemplate", "rtEnabled", "smsMaxBind", "xrayVless", "regEngine", "bitBrowser", "claudeProxy", "claudeXrayVless", "regProxyPort", "claudeProxyPort", "jumpProxyPort", "jumpXrayVless", "mailSeparator", "rechargeBaseUrl", "rechargeAppId", "rechargeApiKey", "rechargeForwardIp", "rechargeConcurrency", "rebindConcurrency", "rechargeInterval", "xrayBinPath", "pwConcurrency", "rtProxy", "rtConcurrency", "mfaEnabled", "rebindGmailAfterPaid", "rebindAfterPaid", "rebindGmailProbeLogin", "proxyPool", "proxyPoolMailEnabled", "proxyPoolGptEnabled", "proxyJumpPool", "proxyJumpMailEnabled", "proxyJumpGptEnabled", "mailProxyPool", "mailProxyJump", "mailJumpPool", "gptProxyPool", "gptProxyJump", "gptJumpPool"];

export const DAILY_DEFAULT = {
    enabled: false,
    hour: 4,
    items: {chat: true, rt: true, at: true},
    lastRunAt: 0,
    runCount: 0,
    chatTotal: 0,
    rtTotal: 0,
    atTotal: 0,
    lastResult: "",
    running: false,
};

export function createSchedulerSettingsStore({settingsFile, dailyFile, files = {existsSync, readFileSync, writeFileSync}} = {}) {
    function readJson(file) {
        try {
            if (!files.existsSync(file)) return null;
            return JSON.parse(files.readFileSync(file, "utf8"));
        } catch {
            return null;
        }
    }

    function readSettings() {
        return readJson(settingsFile);
    }

    function writeSettings(source) {
        try {
            const out = {};
            for (const key of SCHEDULER_SETTINGS_KEYS) out[key] = source[key];
            files.writeFileSync(settingsFile, JSON.stringify(out, null, 2) + "\n", "utf8");
            return true;
        } catch {
            return false;
        }
    }

    function readDaily() {
        const daily = {...DAILY_DEFAULT, items: {...DAILY_DEFAULT.items}};
        const saved = readJson(dailyFile);
        if (saved) Object.assign(daily, saved, {items: {...daily.items, ...(saved.items || {})}, running: false});
        return daily;
    }

    function writeDaily(daily) {
        try {
            const {running: _runtimeOnly, ...persisted} = daily;
            files.writeFileSync(dailyFile, JSON.stringify(persisted, null, 2) + "\n", "utf8");
            return true;
        } catch {
            return false;
        }
    }

    return {readSettings, writeSettings, readDaily, writeDaily};
}
