// @ts-nocheck
// 调度代理服务：代理池配置、跳板租约入口和 Xray fleet 编排。
import {
    expandProxyImport,
    gptJumpPool,
    gptProxyPool,
    jumpPool,
    mailJumpPool,
    mailProxyPool,
    maskProxyUrl,
    normalizeProxyUrl,
    proxyPool,
    configureProxyPoolBackend,
    setJumpPoolScopeEnabled,
    setMailProxyJump as setActiveMailProxyJump,
    setProxyPoolScopeEnabled,
    toProxyImportLine,
} from "../../src/mail/proxy-pool.js";
import {
    isMainHttpServer,
    isVlessUrl,
    localPortListening,
    startJumpFleet,
    stopJumpFleet,
} from "../xray-proxy.js";

export function createSchedulerProxyService({settings} = {}) {
    let distributedBackend = null;

    function configureDistributedBackend(backend) {
        distributedBackend = backend || null;
        configureProxyPoolBackend(distributedBackend);
    }

    async function saveSharedConfiguration() {
        if (!distributedBackend?.saveConfiguration) return null;
        return distributedBackend.saveConfiguration({
            exitUrls: settings.proxyPool || [],
            jumpUrls: settings.proxyJumpPool || [],
            exitMailEnabled: settings.proxyPoolMailEnabled !== false,
            exitGptEnabled: settings.proxyPoolGptEnabled !== false,
            jumpMailEnabled: settings.proxyJumpMailEnabled !== false,
            jumpGptEnabled: settings.proxyJumpGptEnabled !== false,
        });
    }

    async function initializeSharedConfiguration() {
        if (!distributedBackend?.loadConfiguration) {
            syncProxyPoolsFromSettings();
            syncJumpPoolsFromSettings();
            return;
        }
        const saved = await distributedBackend.loadConfiguration();
        if (!saved.initialized) {
            await saveSharedConfiguration();
        } else {
            settings.proxyPool = uniqueStrings(saved.exitUrls || []);
            settings.proxyJumpPool = uniqueStrings(saved.jumpUrls || []);
            settings.proxyPoolMailEnabled = saved.exitMailEnabled !== false;
            settings.proxyPoolGptEnabled = saved.exitGptEnabled !== false;
            settings.proxyJumpMailEnabled = saved.jumpMailEnabled !== false;
            settings.proxyJumpGptEnabled = saved.jumpGptEnabled !== false;
            settings.mailProxyPool = settings.proxyPool.slice();
            settings.gptProxyPool = settings.proxyPool.slice();
            settings.mailJumpPool = settings.proxyJumpPool.slice();
            settings.gptJumpPool = settings.proxyJumpPool.slice();
            settings.saveSettings();
        }
        syncProxyPoolsFromSettings();
        syncJumpPoolsFromSettings();
    }
    async function releaseOwnProxyLeases() {
        return Number(await distributedBackend?.releaseByInstance?.() || 0);
    }
    function hasGptJumpConfig() {
        if (settings.proxyJumpGptEnabled === false) return false;
        if (Array.isArray(settings.proxyJumpPool) && settings.proxyJumpPool.some((x) => String(x || "").trim())) return true;
        if (String(settings.gptProxyJump || "").trim()) return true;
        return (settings.gptJumpPool || []).some((x) => String(x || "").trim());
    }

    function uniqueStrings(values) {
        return [...new Set((values || []).map((value) => String(value || "").trim()).filter(Boolean))];
    }

    function syncProxyPoolsFromSettings() {
        const urls = uniqueStrings(settings.proxyPool || settings.mailProxyPool || settings.gptProxyPool || []);
        proxyPool.setUrls(urls);
        settings.proxyPool = proxyPool.urls.slice();
        settings.mailProxyPool = settings.proxyPool.slice();
        settings.gptProxyPool = settings.proxyPool.slice();
        setProxyPoolScopeEnabled("mail", settings.proxyPoolMailEnabled !== false);
        setProxyPoolScopeEnabled("gpt", settings.proxyPoolGptEnabled !== false);
        return proxyPool.snapshot();
    }
    
    function collectJumpLines() {
        const out = [];
        const seen = new Set();
        const push = (raw) => {
            const s = String(raw || "").trim();
            if (!s || seen.has(s)) return;
            seen.add(s);
            out.push(s);
        };
        for (const x of (settings.proxyJumpPool || [])) push(x);
        if (!out.length) for (const x of (settings.mailJumpPool || [])) push(x);
        if (!out.length) for (const x of (settings.gptJumpPool || [])) push(x);
        push(settings.jumpXrayVless);
        if (!out.length) {
            push(settings.mailProxyJump);
            push(settings.gptProxyJump);
        }
        return out;
    }
    
    function resolveJumpLine(raw, fleet = settings.jumpFleet || []) {
        const s = String(raw || "").trim();
        if (!s) return "";
        if (isVlessUrl(s)) {
            let key = s;
            try {
                const u = new URL(s);
                key = `${decodeURIComponent(u.username || "")}@${u.hostname}:${u.port}`;
            } catch { /* */ }
            const hit = (fleet || []).find((f) => {
                if (f.vless === s) return true;
                try {
                    const u = new URL(f.vless);
                    return `${decodeURIComponent(u.username || "")}@${u.hostname}:${u.port}` === key;
                } catch { return false; }
            });
            return hit?.socks || "";
        }
        return normalizeProxyUrl(s) || s;
    }
    
    function jumpPoolSnapshot() {
        const snap = jumpPool.snapshot();
        const fleet = settings.jumpFleet || [];
        const bySocks = new Map(fleet.map((f) => [f.socks, f]));
        return {
            ...snap,
            lines: settings.collectJumpLines(),
            xrays: fleet,
            items: (snap.items || []).map((it) => {
                const f = bySocks.get(it.url);
                return {
                    ...it,
                    node: f?.node || "",
                    port: f?.port || 0,
                    xray: f ? !!f.running : null,
                    xrayError: f?.error || "",
                    source: f ? maskProxyUrl(f.vless) : it.masked,
                };
            }),
        };
    }
    
    let jumpFleetPromise = null;

    async function ensureJumpFleetNow() {
        if (!isMainHttpServer()) {
            const {liveJumpSocks} = await import("../xray-proxy.js");
            const live = await liveJumpSocks();
            if (live) {
                jumpPool.setUrls([live]);
                settings.proxyJumpPool = [live];
                settings.mailJumpPool = [live];
                settings.gptJumpPool = [live];
                settings.mailProxyJump = live;
                settings.gptProxyJump = live;
                setActiveMailProxyJump(live);
            }
            return [];
        }
        const lines = settings.collectJumpLines();
        const vless = lines.filter((x) => isVlessUrl(x));
        if (!vless.length) {
            if ((settings.jumpFleet || []).length) stopJumpFleet();
            settings.jumpFleet = [];
            settings.jumpXrayVless = "";
            const socks = [];
            const keys = new Map();
            const seen = new Set();
            for (const raw of lines) {
                const url = settings.resolveJumpLine(raw, []);
                if (!url || seen.has(url)) continue;
                seen.add(url);
                socks.push(url);
                keys.set(url, raw);
            }
            jumpPool.setUrls(socks, {keys});
            settings.proxyJumpPool = lines.slice();
            settings.mailProxyJump = socks[0] || "";
            settings.gptProxyJump = socks[0] || "";
            if (settings.mailProxyJump) setActiveMailProxyJump(settings.mailProxyJump);
            try { settings.saveSettings(); } catch { /* */ }
            return [];
        }
        settings.jumpFleet = await startJumpFleet(vless, {
            binPath: settings.xrayBinPath || undefined,
            basePort: Number(settings.jumpProxyPort) || 10811,
            reservedPorts: [Number(settings.regProxyPort), Number(settings.claudeProxyPort)],
        });
        if (settings.jumpFleet[0]) {
            settings.jumpXrayVless = settings.jumpFleet[0].vless;
            settings.jumpProxyPort = settings.jumpFleet[0].port || settings.jumpProxyPort;
        }
        const socks = [];
        const keys = new Map();
        const seen = new Set();
        for (const raw of lines) {
            const url = settings.resolveJumpLine(raw, settings.jumpFleet);
            if (!url || seen.has(url)) continue;
            if (isVlessUrl(raw)) {
                const hit = (settings.jumpFleet || []).find((f) => f.socks === url || f.vless === raw);
                if (!hit?.running) continue;
            }
            seen.add(url);
            socks.push(url);
            keys.set(url, raw);
        }
        jumpPool.setUrls(socks, {keys});
        settings.proxyJumpPool = lines.slice();
        settings.mailProxyJump = socks[0] || "";
        settings.gptProxyJump = socks[0] || "";
        if (settings.mailProxyJump) setActiveMailProxyJump(settings.mailProxyJump);
        try { settings.saveSettings(); } catch { /* 跳板端口必须写回，避免子进程还读 10812 死口 */ }
        const dead = settings.jumpFleet.filter((f) => !f.running);
        if (dead.length) {
            console.warn(`[jump] ${dead.length} 条 vless xray 没起来: ${dead.map((f) => f.error || f.node).join(" ; ")}`);
        }
        return settings.jumpFleet;
    }

    // 设置接口和启动流程可能同时触发 fleet 编排，合并为一个 in-flight 操作，避免重复拉起 Xray。
    function ensureJumpFleet() {
        if (jumpFleetPromise) return jumpFleetPromise;
        const current = ensureJumpFleetNow();
        jumpFleetPromise = current;
        current.finally(() => {
            if (jumpFleetPromise === current) jumpFleetPromise = null;
        }).catch(() => {});
        return current;
    }
    
    function syncJumpPoolsFromSettings() {
        const legacyMail = Array.isArray(settings.mailJumpPool) ? settings.mailJumpPool : (settings.mailProxyJump ? [settings.mailProxyJump] : []);
        const legacyGpt = Array.isArray(settings.gptJumpPool) ? settings.gptJumpPool : (settings.gptProxyJump ? [settings.gptProxyJump] : legacyMail);
        if (!Array.isArray(settings.proxyJumpPool)) settings.proxyJumpPool = uniqueStrings([...legacyMail, ...legacyGpt]);
        settings.proxyJumpPool = uniqueStrings(settings.proxyJumpPool);
        const socks = [];
        const keys = new Map();
        for (const raw of settings.proxyJumpPool) {
            const url = settings.resolveJumpLine(raw, settings.jumpFleet || []);
            if (!url || isVlessUrl(url) || socks.includes(url)) continue;
            socks.push(url);
            keys.set(url, raw);
        }
        jumpPool.setUrls(socks, {keys});
        settings.mailJumpPool = settings.proxyJumpPool.slice();
        settings.gptJumpPool = settings.proxyJumpPool.slice();
        setJumpPoolScopeEnabled("mail", settings.proxyJumpMailEnabled !== false);
        setJumpPoolScopeEnabled("gpt", settings.proxyJumpGptEnabled !== false);
        const first = settings.proxyJumpPool.find((value) => !isVlessUrl(value));
        if (first) setActiveMailProxyJump(settings.resolveJumpLine(first, []) || "");
    }

    async function setProxyPool(textOrList, {append = false, copies = 1} = {}) {
        const incoming = Array.isArray(textOrList)
            ? expandProxyImport(textOrList.join("\n"), copies)
            : expandProxyImport(String(textOrList || ""), copies);
        const prev = uniqueStrings(settings.proxyPool || []);
        const prevSet = new Set(prev);
        const inserted = incoming.filter((url) => !prevSet.has(url));
        const urls = append ? [...prev, ...inserted] : incoming;
        settings.proxyPool = urls;
        syncProxyPoolsFromSettings();
        settings.saveSettings();
        await saveSharedConfiguration();
        return {
            ...proxyPool.snapshot(),
            inserted: append ? inserted.length : incoming.length,
            skipped: append ? incoming.length - inserted.length : 0,
            lines: urls.map(toProxyImportLine),
        };
    }

    async function setProxyPoolScopes({mail, gpt} = {}) {
        if (typeof mail === "boolean") settings.proxyPoolMailEnabled = mail;
        if (typeof gpt === "boolean") settings.proxyPoolGptEnabled = gpt;
        syncProxyPoolsFromSettings();
        settings.saveSettings();
        await saveSharedConfiguration();
        return proxyPool.snapshot();
    }

    function proxyPoolEnabled(scope = "gpt") {
        return scope === "mail" ? settings.proxyPoolMailEnabled !== false : settings.proxyPoolGptEnabled !== false;
    }
    
    async function setMailProxyPool(textOrList, {append = false, copies = 1} = {}) {
        return setProxyPool(textOrList, {append, copies});
    }
    
    function mailProxyFallback() {
        if (settings.mailProxyEnabled !== false && settings.mailProxy) return settings.mailProxy;
        return settings.regProxy || "";
    }
    
    function mailProxyPoolSnap() {
        return mailProxyPool.snapshot(settings.mailProxyFallback());
    }

    function proxyPoolSnap() {
        return proxyPool.snapshot();
    }
    
    function detectMailProxyJump() {
        if (settings.portListening(10808)) return "socks5://127.0.0.1:10808";
        return settings.regProxy || "";
    }
    
    /**
     * 端口在不在听。复用 xray-proxy 的带缓存实现，别再自己 execSync 一份——
     * lsof 一次 0.4s，execSync 会把事件循环整个冻住，:3100 期间不响应任何请求。
     */
    function portListening(port) {
        return localPortListening(port);
    }
    
    async function setMailProxyJump(url) {
        settings.mailProxyJump = String(url || "").trim();
        settings.proxyJumpPool = settings.mailProxyJump ? [settings.mailProxyJump] : [];
        settings.mailJumpPool = settings.proxyJumpPool.slice();
        settings.gptJumpPool = settings.proxyJumpPool.slice();
        settings.gptProxyJump = settings.mailProxyJump;
        jumpPool.setUrls([]);
        if (isMainHttpServer()) {
            const pending = settings.ensureJumpFleet();
            if (pending && typeof pending.then === "function") await pending.catch((e) => console.warn("[jump] 起 xray 失败", e?.message || e));
            settings.saveSettings();
        }
        await saveSharedConfiguration();
        return settings.mailProxyJump;
    }
    
    async function setMailJumpPool(list) {
        return setProxyJumpPool(list);
    }
    
    async function setGptJumpPool(list) {
        return setProxyJumpPool(list);
    }

    async function setProxyJumpPool(list) {
        const urls = Array.isArray(list)
            ? uniqueStrings(list)
            : uniqueStrings(String(list || "").split(/[\r\n]+/));
        settings.proxyJumpPool = urls;
        settings.mailJumpPool = urls.slice();
        settings.gptJumpPool = urls.slice();
        settings.mailProxyJump = urls.find((value) => !isVlessUrl(value)) ? settings.resolveJumpLine(urls.find((value) => !isVlessUrl(value)), []) : "";
        settings.gptProxyJump = settings.mailProxyJump;
        if (!urls.length) settings.jumpXrayVless = "";
        await settings.ensureJumpFleet();
        settings.saveSettings();
        await saveSharedConfiguration();
        return settings.jumpPoolSnapshot();
    }

    async function setProxyJumpScopes({mail, gpt} = {}) {
        if (typeof mail === "boolean") settings.proxyJumpMailEnabled = mail;
        if (typeof gpt === "boolean") settings.proxyJumpGptEnabled = gpt;
        syncJumpPoolsFromSettings();
        settings.saveSettings();
        await saveSharedConfiguration();
        return settings.jumpPoolSnapshot();
    }
    
    function applyJumpSocks(port) {
        const jump = `socks5://127.0.0.1:${Number(port) || settings.jumpProxyPort || 10811}`;
        settings.mailProxyJump = jump;
        settings.gptProxyJump = jump;
        jumpPool.addUrl(jump);
        settings.proxyJumpPool = uniqueStrings([...(settings.proxyJumpPool || []), jump]);
        settings.mailJumpPool = settings.proxyJumpPool.slice();
        settings.gptJumpPool = settings.proxyJumpPool.slice();
        settings.saveSettings();
        return jump;
    }
    
    async function setGptProxyPool(textOrList, {append = false, copies = 1} = {}) {
        return setProxyPool(textOrList, {append, copies});
    }
    
    function gptProxyPoolSnap() {
        return gptProxyPool.snapshot("");
    }
    
    async function setGptProxyJump(url) {
        settings.gptProxyJump = String(url || "").trim();
        if (settings.gptProxyJump) {
            settings.proxyJumpPool = uniqueStrings([...(settings.proxyJumpPool || []), settings.gptProxyJump]);
            settings.mailJumpPool = settings.proxyJumpPool.slice();
            settings.gptJumpPool = settings.proxyJumpPool.slice();
            syncJumpPoolsFromSettings();
        }
        settings.saveSettings();
        await saveSharedConfiguration();
        return settings.gptProxyJump;
    }

    async function publicProxyPoolSnap(scope) {
        if (!distributedBackend?.snapshot) {
            return scope === "mail" ? mailProxyPool.snapshot(settings.mailProxyFallback())
                : scope === "gpt" ? gptProxyPool.snapshot("")
                    : proxyPool.snapshot();
        }
        const remote = await distributedBackend.snapshot({kind: "exit", scope});
        const items = remote.items.map((item) => ({
            url: item.url,
            masked: maskProxyUrl(item.url),
            leased: item.leased > 0,
            leaseCount: item.leased,
            owner: item.owners?.[0] || "",
            owners: item.owners || [],
        }));
        return {
            total: remote.total,
            slots: remote.total,
            leased: remote.leased,
            free: items.filter((item) => !item.leased).length,
            items,
        };
    }

    async function publicJumpPoolSnapshot() {
        if (!distributedBackend?.snapshot) return jumpPoolSnapshot();
        const remote = await distributedBackend.snapshot({kind: "jump"});
        const local = jumpPool.snapshot();
        const localByKey = new Map(local.items.map((item) => [jumpPool.resourceKeys.get(item.url) || item.url, item]));
        const items = remote.items.map((item) => {
            const actual = settings.resolveJumpLine(item.resourceKey, settings.jumpFleet || []) || item.url;
            const localItem = localByKey.get(item.resourceKey);
            return {
                ...(localItem || {
                    url: actual,
                    masked: maskProxyUrl(actual),
                    cap: jumpPool.maxPerJump,
                    ok: null,
                    ip: "",
                    google: 0,
                    ms: 0,
                    reason: "",
                    checkedAt: 0,
                }),
                url: actual,
                masked: maskProxyUrl(actual),
                leased: item.leased,
                owners: item.owners || [],
            };
        });
        return {...local, total: remote.total, leased: remote.leased, items};
    }

    return {configureDistributedBackend, initializeSharedConfiguration, releaseOwnProxyLeases, publicProxyPoolSnap, publicJumpPoolSnapshot, hasGptJumpConfig, collectJumpLines, resolveJumpLine, jumpPoolSnapshot, ensureJumpFleet, syncProxyPoolsFromSettings, syncJumpPoolsFromSettings, setProxyPool, setProxyPoolScopes, proxyPoolSnap, proxyPoolEnabled, setMailProxyPool, mailProxyFallback, mailProxyPoolSnap, detectMailProxyJump, portListening, setMailProxyJump, setMailJumpPool, setGptJumpPool, setProxyJumpPool, setProxyJumpScopes, applyJumpSocks, setGptProxyPool, gptProxyPoolSnap, setGptProxyJump};
}
