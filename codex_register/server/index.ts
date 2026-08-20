// @ts-nocheck
// 后端服务：REST(导入/控制/下载) + SSE(实时日志/状态/统计) + 静态托管前端
import "./strip-env-proxy.js";
import express from "express";
import cors from "cors";
import {existsSync} from "node:fs";
import path from "node:path";
import {fileURLToPath} from "node:url";
import * as db from "./db.js";
import { initDb } from "./pg.js";
import { ensureSchema } from "./pg-schema.js";
import {scheduler} from "./scheduler.js";
import {proxyPoolRepository} from "./repositories/proxy-pool-repository.js";
import {appConfig} from "../src/config.js";
import {setMailProxy} from "./domain/mailbox-service.js";
import {closeTrackedBitWindows} from "../src/bitbrowser.js";
import {runBoundedPool as runPool} from "./domain/async-pool.js";
import {installProcessErrorHandlers} from "./process-error-handlers.js";
import {createProcessInstanceGuard} from "./process-instance-guard.js";
import {initializeApplicationInfrastructure} from "./application-infrastructure.js";
import {createApplicationBootstrap} from "./application-bootstrap.js";
import {createApplicationLifecycle} from "./application-lifecycle.js";
import {createSseHub} from "./sse-hub.js";
import {createCredentialFileStore} from "./credential-file-store.js";
import {createOperationLogService} from "./operation-log-service.js";
import {createRechargeServiceBridge} from "./domain/recharge-service-bridge.js";
import {createTokenModule} from "./modules/token-module.js";
import {createRechargeModule} from "./modules/recharge-module.js";
import {createMailboxModule} from "./modules/mailbox-module.js";
import {registerClaudeModule} from "./modules/claude-module.js";
import {registerAccountModule} from "./modules/account-module.js";
import {registerWorkTaskRoutes} from "./routes/work-task-routes.js";
import {startXray, stopXray} from "./xray-proxy.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
installProcessErrorHandlers();

const credentialFiles = createCredentialFileStore({
    rtDir: path.resolve(__dirname, "..", "data", "tokens", "rt"),
});
const getAuthData = credentialFiles.readAuth;
// 子进程/worker 靠这个判断：禁止在 HTTP 主进程起本机 socks 转发环。
process.env.CODEX_HTTP = "1";
// HTTP 主进程使用 PostgreSQL 公共代理池；worker 和单测不经过这里，仍可使用内存池。
scheduler.configureProxyPoolBackend(proxyPoolRepository);
const PORT = Number(process.env.PORT || 3100);
const WEB_DIST = path.resolve(__dirname, "..", "web", "dist");
const applicationState = {
    httpReady: false,
    infrastructureReady: false,
    shuttingDown: false,
    startupPhase: "loading",
    startupError: "",
    startupAttempt: 0,
    startedAt: Date.now(),
};
const processGuard = createProcessInstanceGuard({
    port: PORT,
    dataDir: path.resolve(__dirname, "..", "data"),
});
const app = express();
app.use(cors());
app.use(express.json({limit: "10mb"}));
app.get("/api/health", async (_req, res) => {
    const ready = applicationState.httpReady
        && applicationState.infrastructureReady
        && !applicationState.shuttingDown;
    try {
        const {rssMb, isBrowserWorkBlocked} = await import("./rss-guard.js");
        res.json({
            ok: true,
            ready,
            phase: applicationState.startupPhase,
            startupError: applicationState.startupError,
            startupAttempt: applicationState.startupAttempt,
            uptimeMs: Date.now() - applicationState.startedAt,
            rssMb: rssMb(),
            browserBlocked: isBrowserWorkBlocked(),
            instance: db.instanceId,
        });
    } catch {
        res.json({ok: true, ready, phase: applicationState.startupPhase, instance: db.instanceId});
    }
});
app.get("/api/ready", (_req, res) => {
    const ready = applicationState.httpReady
        && applicationState.infrastructureReady
        && !applicationState.shuttingDown;
    res.status(ready ? 200 : 503).json({
        ok: ready,
        ready,
        phase: applicationState.startupPhase,
        error: applicationState.startupError,
        attempt: applicationState.startupAttempt,
    });
});
app.use("/api", (_req, res, next) => {
    if (applicationState.infrastructureReady && !applicationState.shuttingDown) return next();
    return res.status(503).json({
        ok: false,
        ready: false,
        error: "服务基础设施尚未就绪",
        phase: applicationState.startupPhase,
        detail: applicationState.startupError,
    });
});

// ---------- API 命名对称(架构 v2):/api/gpt/* = GPT 域规范命名空间 ----------
// 历史路由用具体名(/api/accounts、/api/control、/api/sms、/api/export...)。此中间件把 /api/gpt/<x>
// 透明重写到 /api/<x>,让 GPT 域获得与 /api/claude/*、/api/mailboxes/* 对称的命名空间:前端可渐进
// 迁移到 /api/gpt/*,旧路径继续可用(零移动、零风险)。跨域资源(mailboxes/claude 各有命名空间)排除,避免误 alias。
app.use((req, res, next) => {
    if (req.url.startsWith("/api/gpt/")) {
        const rest = req.url.slice("/api/gpt/".length);
        if (!rest.startsWith("mailboxes") && !rest.startsWith("claude") && !rest.startsWith("proxy-") && !rest.startsWith("jump-")) req.url = "/api/" + rest;
    }
    next();
});

const sseHub = createSseHub({
    scheduler,
    getInitialState: () => ({...scheduler.state(), ...mailboxStateExtras()}),
    getStats: () => db.stats(),
});
const broadcast = sseHub.broadcast;
sseHub.bindScheduler();
sseHub.registerRoute(app);
const operationLogs = createOperationLogService({
    store: {
        appendAccount: (id, line) => db.appendLog(id, line),
        appendMailbox: (id, line) => db.appendMailboxLog(id, line),
    },
    publish: broadcast,
});
const logAcct = operationLogs.account;
const logMailbox = operationLogs.mailbox;

const rechargeBridge = createRechargeServiceBridge();
const mailboxModule = createMailboxModule({
    app,
    db,
    scheduler,
    applicationState,
    broadcast,
    logMailbox,
    rechargeBridge,
    runPool,
});
const mailJobs = mailboxModule.mailJobs;
const mailboxStateExtras = mailboxModule.stateExtras;
const refreshMailboxJobWindows = mailboxModule.refreshWindows;
const parseAccounts = mailboxModule.parseAccounts;
const extractEmailsFromText = mailboxModule.extractEmails;

registerClaudeModule({app, db, scheduler, broadcast, runPool, readAuth: getAuthData});
registerAccountModule({app, db, scheduler, parseAccounts, readAuth: getAuthData, logAccount: logAcct, broadcast});
registerWorkTaskRoutes(app, {
    store: {
        stats: (kind) => db.workTaskStats(kind),
        recover: (options) => db.recoverStaleWorkTasks(options),
    },
});
const tokenModule = createTokenModule({
    app,
    db,
    scheduler,
    config: appConfig,
    rootDir: path.resolve(__dirname, ".."),
    broadcast,
    logAccount: logAcct,
    credentialFiles,
    mailJobs,
    rechargeBridge,
    runPool,
});
const dailyMaintenance = tokenModule.dailyMaintenance;

const rechargeModule = createRechargeModule({
    app,
    db,
    scheduler,
    rootDir: path.resolve(__dirname, ".."),
    broadcast,
    credentialFiles,
    token: tokenModule,
    rechargeBridge,
    runPool,
    extractEmails: extractEmailsFromText,
});
const rechargeLifecycle = rechargeModule.lifecycle;
const rechargeLog = rechargeModule.log;
const broadcastRechargeJobs = rechargeModule.broadcastJobs;

// ---------- 静态前端(生产) ----------
if (existsSync(WEB_DIST)) {
    app.use(express.static(WEB_DIST, {setHeaders: (res, p) => { if (p.endsWith(".html")) res.setHeader("Cache-Control", "no-cache"); }}));
    app.get(/^(?!\/api).*/, (req, res) => { res.set("Cache-Control", "no-cache"); res.sendFile(path.join(WEB_DIST, "index.html")); });
}

app.use((err: any, _req: any, res: any, next: any) => {
    console.error("[http]", err?.stack || err);
    if (res.headersSent) return next(err);
    res.status(400).json({ok: false, error: String(err?.message || err).slice(0, 240)});
});

const applicationLifecycle = createApplicationLifecycle({
    port: PORT,
    webBuilt: existsSync(WEB_DIST),
    state: applicationState,
    processGuard,
    store: {
        instanceId: db.instanceId,
        setMailClaimPaused: (paused) => db.setMailClaimPaused(paused),
        releaseInstanceWork: (instanceId) => db.releaseInstanceWork(instanceId),
        parkRebindWork: (instanceId, reason) => db.parkRebindWorkByInstance(instanceId, reason),
    },
    scheduler,
    mailJobs,
    mailWorkers: {stopAll: mailboxModule.stopBrowserWorkers},
    recharge: {
        lifecycle: rechargeLifecycle,
    },
    token: {
        workers: [tokenModule.rtWorker],
    },
    daily: dailyMaintenance,
    browser: {
        refreshWindows: refreshMailboxJobWindows,
        closeTrackedWindows: closeTrackedBitWindows,
    },
    rss: {
        start: async (options) => {
            const {startRssGuard} = await import("./rss-guard.js");
            return startRssGuard(options);
        },
    },
    effects: {
        log: (...args) => console.log(...args),
        warn: (...args) => console.warn(...args),
        error: (...args) => console.error(...args),
        rechargeLog,
        broadcastRechargeJobs,
    },
});
applicationLifecycle.startHttp(app);

const applicationBootstrap = createApplicationBootstrap({
    state: applicationState,
    lifecycle: applicationLifecycle,
    initialize: ({reportPhase}) => initializeApplicationInfrastructure({
        scheduler,
        mailbox: {setProxy: setMailProxy},
        xray: {start: startXray, stop: stopXray},
        database: {ensureSchema, initConnection: initDb},
        reportPhase,
    }),
});
process.once("exit", () => applicationBootstrap.stop());
void applicationBootstrap.start();
