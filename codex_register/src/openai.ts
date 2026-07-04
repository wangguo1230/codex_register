import {mkdir, writeFile} from "node:fs/promises";
import {createInterface} from "node:readline/promises";
import net from "node:net";
import {stdin as input, stdout as output} from "node:process";
import tls from "node:tls";
import {URLSearchParams} from "node:url";
import path from "node:path";
import {Agent, ProxyAgent, setGlobalDispatcher, type Dispatcher} from "undici";
import {SocksClient} from "socks";
import makeFetchCookie from "fetch-cookie";
import {CookieJar} from "tough-cookie";
import {appConfig} from "./config.js";
import {shouldAutoUploadAuthToCLIProxyAPI, uploadAuthFileToCLIProxyAPI} from "./cliproxyapi.js";
import {defaultDeviceProfile, type DeviceProfile, getDeviceClientHints} from "./device-profile.js";
import {
    AUTH_AUTHORIZE_CONTINUE_URL,
    AUTH_BASE_URL,
    AUTH_EMAIL_OTP_SEND_URL,
    AUTH_EMAIL_OTP_VALIDATE_URL,
    AUTH_OAUTH_TOKEN_URLS,
    AUTH_PASSWORD_VERIFY_URL,
    AUTH_REGISTER_URL,
    AUTH_WORKSPACE_SELECT_URL,
    CHATGPT_BASE_URL,
    DEFAULT_CLIENT_ID,
    DEFAULT_REDIRECT_URI,
    DEFAULT_USER_AGENT,
} from "./constants.js";
import {getEmailAddress, getEmailVerificationCode, getMailboxCredential, MAILBOX_CONFIG} from "./mailbox.js";
import {ensureNextAuthCsrf, buildAuthRecord} from "./email-reg/index.js";
import {fetchSentinelToken} from "./sentinel.js";
import { pkceCodeChallenge, randomUrlSafeString } from "./utils.js";
import {ISMSActivationBroker} from "./sms/activation-broker.js";

type FetchLike = typeof fetch;

const DEFAULT_INSECURE_TLS = true;
const FETCH_RETRY_COUNT = 3;
const FETCH_RETRY_DELAY_MS = 1500;

function resolveProxyUrl(): string {
    // 注册代理：worker 传 env PROXY_URL 优先，否则 config.defaultProxyUrl
    return process.env.PROXY_URL || appConfig.defaultProxyUrl;
}

function shouldAllowInsecureTLS(): boolean {
    return DEFAULT_INSECURE_TLS;
}

function createDispatcher(proxyUrl: string, allowInsecureTLS: boolean): Dispatcher {
    if (!proxyUrl) {
        return new Agent({
            connect: {
                rejectUnauthorized: !allowInsecureTLS,
            },
        });
    }

    const parsedProxyUrl = new URL(proxyUrl);
    if (parsedProxyUrl.protocol === "http:" || parsedProxyUrl.protocol === "https:") {
        return new ProxyAgent({
            uri: proxyUrl,
            requestTls: {
                rejectUnauthorized: !allowInsecureTLS,
            },
        });
    }

    if (isSocksProtocol(parsedProxyUrl.protocol)) {
        const connect = ((options, callback) => {
            void createSocksSocket(parsedProxyUrl, options as unknown as Record<string, unknown>, allowInsecureTLS)
                .then((socket) => callback(null, socket))
                .catch((error) => callback(error instanceof Error ? error : new Error(String(error)), null));
        }) as NonNullable<ConstructorParameters<typeof Agent>[0]>["connect"];

        return new Agent({
            connect,
        });
    }

    throw new Error(`不支持的代理协议: ${parsedProxyUrl.protocol}`);
}

function isSocksProtocol(protocol: string): boolean {
    return ["socks4:", "socks4a:", "socks5:", "socks5h:"].includes(protocol);
}

async function createSocksSocket(
    proxyUrl: URL,
    options: Record<string, unknown>,
    allowInsecureTLS: boolean,
): Promise<net.Socket> {
    const destinationHost = String(options.hostname ?? "");
    const rawPort = options.port;
    const destinationPort =
        rawPort === "" || rawPort == null
            ? (options.protocol === "https:" ? 443 : 80)
            : Number(rawPort);
    const proxyPort = Number(proxyUrl.port || (proxyUrl.protocol.startsWith("socks5") ? 1080 : 1080));
    const proxyType = proxyUrl.protocol.startsWith("socks4") ? 4 : 5;

    const connection = await SocksClient.createConnection({
        proxy: {
            host: proxyUrl.hostname,
            port: proxyPort,
            type: proxyType,
            userId: proxyUrl.username ? decodeURIComponent(proxyUrl.username) : undefined,
            password: proxyUrl.password ? decodeURIComponent(proxyUrl.password) : undefined,
        },
        command: "connect",
        destination: {
            host: destinationHost,
            port: destinationPort,
        },
    });

    const socket = connection.socket;
    if (options.protocol !== "https:") {
        return socket;
    }

    return await new Promise<net.Socket>((resolve, reject) => {
        const tlsSocket = tls.connect({
            socket,
            host: String(options.servername ?? destinationHost),
            servername: String(options.servername ?? destinationHost),
            rejectUnauthorized: !allowInsecureTLS,
        });
        tlsSocket.once("secureConnect", () => resolve(tlsSocket));
        tlsSocket.once("error", reject);
    });
}

interface ContinueResponse {
    continue_url: string;
    method?: string;
    page?: {
        type?: string;
        backstack_behavior?: string;
        payload?: {
            url?: string;
        };
    };
}

interface AuthSessionWorkspace {
    id: string;
    name?: string;
    kind?: string;
}

interface ClientAuthSessionPayload {
    workspaces?: AuthSessionWorkspace[];
}

interface OAuthTokenResponse {
    access_token: string;
    refresh_token?: string;
    id_token?: string;
    expires_in?: number;
    token_type?: string;
    scope?: string;
}

interface JwtPayload {
    email?: string;
    exp?: number;
    "https://api.openai.com/auth"?: {
        chatgpt_account_id?: string;
    };
}

export interface AuthLoginResult {
    callbackURL: string;
    code: string;
    state: string;
    authFile?: string;
}

interface ChatGPTAuthSession {
    accessToken?: string;
    access_token?: string;
    error?: string;
    // /api/auth/session 还会返回 user/account/expires/sessionToken/WARNING_BANNER 等，
    // 这里保留原始字段，整体落盘到 auth 文件的 session 字段。
    [key: string]: unknown;
}

export interface SavedAuthRecord {
    access_token: string;
    account_id: string;
    disabled: boolean;
    email: string;
    expired: string;
    id_token: string;
    last_refresh: string;
    refresh_token: string;
    type: "codex";
    websockets: false;
}

export interface OpenAIClientOptions {
    email?: string;
    password: string;
    userAgent?: string;
    deviceProfile?: DeviceProfile;
    manualMode?: boolean;
    signupScreenHint?: string;
    smsBroker?: ISMSActivationBroker;
    /**
     * 当 OAuth 登录流程要求 add-email（phone-only 账号 codex CLI OAuth）时，
     * 用这个 email 提交 add-email/send，并通过 fetchAddEmailOtp 接 OTP。
     */
    bindEmail?: string;
    fetchAddEmailOtp?: () => Promise<string>;
    /** 验证码单封模式：跳过主动 sendEmailOtp，只用创建账号时自动发的那封(默认 false=发两封更稳) */
    otpSingle?: boolean;
}

export class OpenAIClient {
    email: string;
    readonly password: string;
    readonly manualMode: boolean;
    readonly jar: CookieJar;
    readonly fetch: FetchLike;
    readonly userAgent: string;
    readonly deviceProfile: DeviceProfile;
    readonly clientHints: ReturnType<typeof getDeviceClientHints>;
    readonly signupScreenHint: string;
    state = "";
    codeVerifier = "";
    deviceID = "";
    // 最近一次成功的 OAuth token 兑换结果(codex CLI 风格,client_id=app_EMo...)
    // 跟 CPA(CLIProxyAPI) 入库的 auth.json 内容等价,可直接当 ChatGPT plan access_token 用
    lastSavedAuthRecord: SavedAuthRecord | null = null;
    // 最近一次 /api/auth/session 的完整原始响应（含 user/account/sessionToken 等）
    lastSession: ChatGPTAuthSession | null = null;
    readonly smsBroker?: ISMSActivationBroker;
    readonly bindEmail: string;
    readonly fetchAddEmailOtp?: () => Promise<string>;
    readonly otpSingle: boolean;

    constructor(options: OpenAIClientOptions) {
        this.smsBroker = options.smsBroker;
        this.bindEmail = options.bindEmail?.trim() ?? "";
        this.fetchAddEmailOtp = options.fetchAddEmailOtp;
        this.otpSingle = options.otpSingle ?? false;
        this.email = options.email?.trim() ?? "";
        this.password = options.password;
        this.deviceProfile = options.deviceProfile
            ? {
                ...options.deviceProfile,
                languages: [...options.deviceProfile.languages],
            }
            : {
                ...defaultDeviceProfile(),
                userAgent: options.userAgent?.trim() || DEFAULT_USER_AGENT,
            };
        this.userAgent = this.deviceProfile.userAgent;
        this.clientHints = getDeviceClientHints(this.deviceProfile);
        this.manualMode = options.manualMode ?? !this.email;
        this.signupScreenHint = options.signupScreenHint?.trim() || "login_or_signup";
        this.jar = new CookieJar();
        setGlobalDispatcher(createDispatcher(resolveProxyUrl(), shouldAllowInsecureTLS()));
        const cookieFetch = makeFetchCookie(fetch, this.jar) as FetchLike;
        this.fetch = ((input: Parameters<FetchLike>[0], init?: Parameters<FetchLike>[1]) =>
            this.fetchWithRetry(cookieFetch, input, init)) as FetchLike;
    }

    private logProgress(current: number | string, total: number, message: string): void {
        console.log(`[${current}/${total}] ${message}`);
    }

    /**
     * Codex CPA 登录：用 CPA 给的 authorize URL（PKCE/state 由 CPA 持有），
     * 走完所有用户交互（password / add-email / consent），最终拿到 localhost callback URL，
     * 但**不**交换 token —— 把 callback URL 交给 CPA 由 CPA 完成 token 交换并入库。
     *
     * 适用：phone-only 账号通过 codex CLI OAuth 登录的入库链路。
     *
     * @param authorizeUrl CPA 的 /v0/management/codex-auth-url 返回的 URL
     * @returns localhost:1455/auth/callback?... 完整 URL
     */
    async authLoginViaCpaAuthorizeURL(authorizeUrl: string): Promise<string> {
        const totalSteps = 6;
        this.logProgress(1, totalSteps, "打开 CPA 授权页");
        const oauthResp = await this.fetch(authorizeUrl, {
            redirect: "follow",
            headers: this.createBrowserHeaders({
                "accept-encoding": "gzip, deflate, br",
                "sec-fetch-dest": "document",
                "sec-fetch-mode": "navigate",
                "sec-fetch-site": "none",
            }),
        });
        if (!oauthResp.ok) {
            throw new Error(`CPA OauthUrl请求失败: ${oauthResp.status}`);
        }
        if (oauthResp.url.startsWith(DEFAULT_REDIRECT_URI)) {
            return oauthResp.url;
        }
        if (
            oauthResp.url !== `${AUTH_BASE_URL}/log-in` &&
            oauthResp.url !== `${AUTH_BASE_URL}/sign-in-with-chatgpt/codex/consent`
        ) {
            throw new Error(`CPA OauthUrl重定向到错误的URL: ${oauthResp.url}`);
        }

        this.deviceID = await this.readCookie("https://openai.com", "oai-did");
        if (!this.deviceID) {
            throw new Error("CPA OauthUrl未返回oai-did cookie");
        }

        if (oauthResp.url === `${AUTH_BASE_URL}/sign-in-with-chatgpt/codex/consent`) {
            this.logProgress(5, totalSteps, "选择工作区");
            const continueURL = await this.selectWorkspace(oauthResp.url);
            this.logProgress(6, totalSteps, "跟随回调到 localhost");
            return await this.followToLocalhostCallback(continueURL);
        }

        this.logProgress(2, totalSteps, "提交登录用户名");
        let continueURL = await this.authorizeContinue();
        if (continueURL === `${AUTH_BASE_URL}/log-in/password`) {
            this.logProgress(3, totalSteps, "提交登录密码");
            continueURL = await this.passwordVerify();
        }

        if (continueURL === `${AUTH_BASE_URL}/email-verification`) {
            this.logProgress(4, totalSteps, "提交邮箱验证码");
            continueURL = await this.emailOtpValidate();
        }

        if (continueURL === `${AUTH_BASE_URL}/add-phone`) {
            throw new Error("CPA 登录触发 add-phone 流程，当前不支持");
        }

        if (continueURL === `${AUTH_BASE_URL}/sign-in-with-chatgpt/codex/consent`) {
            this.logProgress(5, totalSteps, "选择工作区");
            continueURL = await this.selectWorkspace(continueURL);
        }

        if (continueURL === `${AUTH_BASE_URL}/add-email`) {
            if (!this.bindEmail) {
                throw new Error("OAuth 跳到 /add-email 但未提供 bindEmail");
            }
            this.logProgress("5-a", totalSteps, `提交绑定邮箱: ${this.bindEmail}`);
            continueURL = await this.sendAddEmail(this.bindEmail);
            if (continueURL === `${AUTH_BASE_URL}/email-verification`) {
                this.logProgress("5-b", totalSteps, "等待并提交邮箱 OTP");
                if (!this.fetchAddEmailOtp) {
                    throw new Error("/email-verification 但未配置 fetchAddEmailOtp");
                }
                const code = await this.fetchAddEmailOtp();
                if (!code) throw new Error("add-email OTP 未提供");
                continueURL = await this.emailOtpValidate(code);
            }
            if (continueURL === `${AUTH_BASE_URL}/sign-in-with-chatgpt/codex/consent`) {
                continueURL = await this.selectWorkspace(continueURL);
            }
        }

        this.logProgress(6, totalSteps, "跟随回调到 localhost");
        return await this.followToLocalhostCallback(continueURL);
    }

    /**
     * 从 continueURL（通常是 https://auth.openai.com/authorize/xxx 或类似）
     * 跟着重定向链直到 localhost:1455/auth/callback?code=...&state=...
     * 不抛 add-phone 异常（CPA 流程已在前面处理过）。
     */
    private async followToLocalhostCallback(startURL: string): Promise<string> {
        if (startURL.startsWith(DEFAULT_REDIRECT_URI)) {
            return startURL;
        }
        let currentURL = startURL;
        for (let hop = 0; hop < 10; hop++) {
            const response = await this.fetch(currentURL, {
                method: "GET",
                redirect: "manual",
                headers: {
                    accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
                    "user-agent": this.userAgent,
                    "accept-language": this.deviceProfile.acceptLanguage,
                },
            });
            const location = response.headers.get("location");
            if (location) {
                const nextURL = new URL(location, currentURL).toString();
                if (nextURL.startsWith(DEFAULT_REDIRECT_URI)) {
                    return nextURL;
                }
                currentURL = nextURL;
                continue;
            }
            if (response.url.startsWith(DEFAULT_REDIRECT_URI)) {
                return response.url;
            }
            throw new Error(`OAuth跳转未到达 localhost callback: status=${response.status} url=${response.url}`);
        }
        throw new Error(`OAuth跳转次数过多，最后停在: ${currentURL}`);
    }

    async authLoginHTTP(): Promise<AuthLoginResult> {
        const totalSteps = 6;
        this.logProgress(1, totalSteps, "打开登录授权页");
        const oauthUrl = this.prepareManualLogin();
        const oauthResp = await this.fetch(oauthUrl, {
            redirect: "follow",
            headers: this.createBrowserHeaders({
                "accept-encoding": "gzip, deflate, br",
                "sec-fetch-dest": "document",
                "sec-fetch-mode": "navigate",
                "sec-fetch-site": "none",
            }),
        });
        if (!oauthResp.ok) {
            throw new Error(`OauthUrl请求失败: ${oauthResp.status}`);
        }
        if (oauthResp.url.startsWith(DEFAULT_REDIRECT_URI)) {
            const result = this.extractAuthResult(oauthResp.url);
            const authRecord = await this.exchangeCodeForToken(result.code);
            const authPath = await this.saveAuthRecord(authRecord);
            result.authFile = authPath;
            return result;
        }
        if (
            oauthResp.url !== `${AUTH_BASE_URL}/log-in` &&
            oauthResp.url !== `${AUTH_BASE_URL}/sign-in-with-chatgpt/codex/consent`
        ) {
            throw new Error(`OauthUrl重定向到错误的URL: ${oauthResp.url}`);
        }

        this.deviceID = await this.readCookie("https://openai.com", "oai-did");
        if (!this.deviceID) {
            throw new Error("OauthUrl未返回oai-did cookie");
        }

        if (oauthResp.url === `${AUTH_BASE_URL}/sign-in-with-chatgpt/codex/consent`) {
            this.logProgress(5, totalSteps, "选择工作区");
            const continueURL = await this.selectWorkspace(oauthResp.url);
            this.logProgress(6, totalSteps, "交换授权并保存凭证");
            const result = await this.followOAuthRedirects(continueURL);
            const authRecord = await this.exchangeCodeForToken(result.code);
            const authPath = await this.saveAuthRecord(authRecord);
            result.authFile = authPath;
            return result;
        }

        this.logProgress(2, totalSteps, "提交登录邮箱");
        let continueURL = await this.authorizeContinue();
        if (continueURL === `${AUTH_BASE_URL}/log-in/password`) {
            this.logProgress(3, totalSteps, "提交登录密码");
            continueURL = await this.passwordVerify();
        }

        if (continueURL === `${AUTH_BASE_URL}/email-verification`) {
            this.logProgress(4, totalSteps, "提交邮箱验证码");
            continueURL = await this.emailOtpValidate();
        }

        if (continueURL === `${AUTH_BASE_URL}/add-phone`) {
            // 复用 resolveAddPhone:含 markAsUsed/markAsSucceed(把号回写为 used + bind_count/bind_emails/boundPhone)、
            // 提交前预检坏号、被拒换号、提交成功后不换号。之前内联版缺 markAsUsed → 拿到 rt 但号池不记绑定(本次修复)。
            this.logProgress('4-a', totalSteps, "进入短信验证(add-phone)");
            continueURL = await this.resolveAddPhone(continueURL);
        }

        if (continueURL === `${AUTH_BASE_URL}/sign-in-with-chatgpt/codex/consent`) {
            this.logProgress(5, totalSteps, "选择工作区");
            continueURL = await this.selectWorkspace(continueURL);
        }

        // phone-only 账号 codex OAuth 会要求绑定 email（add-email）
        if (continueURL === `${AUTH_BASE_URL}/add-email`) {
            if (!this.bindEmail) {
                throw new Error("OAuth 跳转到 /add-email 但没配置 bindEmail");
            }
            this.logProgress('5-a', totalSteps, `提交绑定邮箱: ${this.bindEmail}`);
            continueURL = await this.sendAddEmail(this.bindEmail);
            // 应该跳到 /email-verification
            if (continueURL === `${AUTH_BASE_URL}/email-verification`) {
                this.logProgress('5-b', totalSteps, "等待并提交邮箱 OTP");
                if (!this.fetchAddEmailOtp) {
                    throw new Error("/email-verification 但没配置 fetchAddEmailOtp");
                }
                const code = await this.fetchAddEmailOtp();
                if (!code) throw new Error("add-email OTP 未提供");
                continueURL = await this.emailOtpValidate(code);
            }
        }

        if (continueURL === `${AUTH_BASE_URL}/sign-in-with-chatgpt/codex/consent`) {
            this.logProgress(5, totalSteps, "选择工作区（add-email 后）");
            continueURL = await this.selectWorkspace(continueURL);
        }

        this.logProgress(6, totalSteps, "交换授权并保存凭证");
        const result = await this.followOAuthRedirects(continueURL);
        const authRecord = await this.exchangeCodeForToken(result.code);
        const authPath = await this.saveAuthRecord(authRecord);
        result.authFile = authPath;
        return result;
    }

    async authRegisterHTTP(): Promise<string> {
        const stepMessages = [
            "初始化注册会话",
            "生成注册邮箱",
            "打开注册页",
            "提交注册邮箱",
        ];
        let totalSteps = stepMessages.length;
        let step = 1;
        this.logProgress(step++, totalSteps, "初始化注册会话");
        await this.bootChatGPTSession();
        this.logProgress(step++, totalSteps, "生成注册邮箱");
        this.email = await this.generateRegisterEmail();
        console.log("registerEmail:", this.email);
        this.logProgress(step++, totalSteps, "打开注册页");
        await this.openSignupPage(this.email);

        this.logProgress(step++, totalSteps, "提交注册邮箱");
        let continueURL = await this.authorizeContinueForSignup();

        if (continueURL === `${AUTH_BASE_URL}/create-account/password`) {
            totalSteps += 1;
            this.logProgress(step++, totalSteps, "提交注册密码");
            continueURL = await this.registerPassword();
        }

        if (continueURL === AUTH_EMAIL_OTP_SEND_URL) {
            if (this.otpSingle) {
                // 单封模式：跳过主动二次发码，直接用创建账号时自动发的那封
                this.logProgress(step++, totalSteps, "单封模式：跳过二次发码");
                continueURL = `${AUTH_BASE_URL}/email-verification`;
            } else {
                totalSteps += 1;
                this.logProgress(step++, totalSteps, "发送邮箱验证码");
                continueURL = await this.sendEmailOtp();
            }
        }

        if (continueURL === `${AUTH_BASE_URL}/email-verification`) {
            totalSteps += 1;
            this.logProgress(step++, totalSteps, "提交邮箱验证码");
            continueURL = await this.emailOtpValidate();
        }

        // [按需] 邮箱验证后 OpenAI 若要求手机验证(add-phone)，用接码池过验证并自动换号；
        // 不要求手机的账号 continueURL 不会是 add-phone，此分支跳过，原注册流程零影响。
        if (continueURL === `${AUTH_BASE_URL}/add-phone`) {
            totalSteps += 1;
            this.logProgress(step++, totalSteps, "手机验证(接码池)");
            continueURL = await this.resolveAddPhone(continueURL);
        }

        if (continueURL === `${AUTH_BASE_URL}/about-you`) {
            totalSteps += 1;
            this.logProgress(step++, totalSteps, "填写基础资料");
            continueURL = await this.completeAboutYou();
        }

        if (continueURL.startsWith(`${CHATGPT_BASE_URL}/api/auth/callback/openai`)) {
            totalSteps += 1;
            this.logProgress(step++, totalSteps, "完成注册");
            await this.finishChatGPTRegistration(continueURL);
            console.log(`[注册成功] 邮箱：${this.email} 密码：${this.password}`);
        }

        return continueURL;
    }

    /**
     * 处理 add-phone(手机验证)：从注入的 smsBroker 取号 → 提交手机号(add-phone/send) → 收码 → phone-otp/validate。
     * 号码不可用(send 400)或收码失败都换号重试，最多 5 个号。仅在 continueURL===/add-phone 时被调用。
     */
    async resolveAddPhone(continueURL) {
        if (continueURL !== `${AUTH_BASE_URL}/add-phone`) return continueURL;
        if (!this.smsBroker) throw new Error("注册要求手机验证，但未启用接码池(smsBroker)");
        const MAX_PHONE_ATTEMPTS = 5;
        let lastErr;
        let phoneTry = 0;
        for (; phoneTry < MAX_PHONE_ATTEMPTS; phoneTry += 1) {
            const lease = await this.smsBroker.getActivation();
            const phoneNumber = `+${lease.phoneNumber}`;
            // ⓪ 提交前预检：号在接码平台未注册/无效 → 直接换号(此时【未提交 OpenAI、号未消耗】，不浪费)
            if (lease.precheck) {
                const pre = await lease.precheck();
                if (pre === "fatal") {
                    console.warn(`[add-phone] ${phoneNumber} 接码平台未注册/无效(提交前预检)，换号(号未消耗)`);
                    await this.smsBroker.markAsFailed(true); // 号在平台无效 → 标坏号换号
                    continue;
                }
            }
            // ① 提交手机号给 OpenAI。提交失败 = OpenAI 未接受此号(未发短信、未消耗接码) → 换号
            try {
                continueURL = await this.sendPhoneOtp(phoneNumber);
            } catch (e) {
                lastErr = e;
                const rejected = !!(e && e.phoneRejected);
                console.warn(`[add-phone] ${phoneNumber} 提交${rejected ? "被拒(号作废)" : "临时失败(号保留)"}: ${(e && e.message) || e}`);
                await this.smsBroker.markAsFailed(rejected); // true=标坏号；false=释放回池；两者都未消耗接码
                continue;
            }
            // ② 提交成功 = OpenAI 已发短信、【此号已消耗】→ 此刻才标记 used；专等此号收码，收码超时也【不换号】
            console.log(`[add-phone] ${phoneNumber} 提交成功，此号已消耗，标记 used，专等收码(不再换号)`);
            await this.smsBroker.markAsUsed?.();
            // 收码 + 验证：Invalid OTP(常因接码平台返回旧短信残留码)→排除旧码等【新】码重试；同号仍失败→跳出去换号
            let validated = false, lastCode = "";
            for (let vtry = 0; vtry < 3 && !validated; vtry += 1) {
                let code;
                try {
                    ({code} = await lease.waitForVerificationCode(vtry > 0 ? {excludeCode: lastCode} : {}));
                } catch (e) {
                    lastErr = e;
                    console.warn(`[add-phone] ${phoneNumber} 收码失败: ${(e && e.message) || e}`);
                    break; // 收不到码 → 跳出换号
                }
                lastCode = code;
                try {
                    continueURL = await this.validatePhone(code);
                    validated = true;
                } catch (e) {
                    lastErr = e;
                    const invalidOtp = /Invalid OTP|invalid_input|invalid.*(otp|code)/i.test((e && e.message) || "");
                    if (invalidOtp && vtry < 2) {
                        console.warn(`[add-phone] 验证码 ${code} 被 OpenAI 拒(疑旧短信残留)，等新码重试(${vtry + 1}/3)…`);
                        continue;
                    }
                    break; // 验证重试用尽/非 OTP 错 → 跳出换号
                }
            }
            if (validated) {
                await this.smsBroker.markAsSucceed?.();
                return continueURL;
            }
            // 此号验证失败(码错/收不到真码) → 标坏号 + 换池里下一个号【重新 add-phone】,利用剩余号(不是一次失败就放弃)
            console.warn(`[add-phone] ${phoneNumber} 验证失败，标坏号并换号重试(还剩 ${MAX_PHONE_ATTEMPTS - phoneTry - 1} 次)`);
            await this.smsBroker.markAsFailed?.(true);
            continue;
        }
        throw lastErr ?? new Error(`add-phone 提交手机号 ${MAX_PHONE_ATTEMPTS} 次均失败或无可用号`);
    }

    async authRegisterAndAuthorizeHTTP(): Promise<AuthLoginResult> {
        const stepMessages = [
            "打开直接注册授权页",
            "提交注册邮箱",
        ];
        let totalSteps = stepMessages.length;
        let step = 1;

        if (!this.email) {
            totalSteps += 1;
            this.logProgress(step++, totalSteps, "生成注册邮箱");
            this.email = await this.generateRegisterEmail();
            console.log("registerEmail:", this.email);
        }

        this.logProgress(step++, totalSteps, "打开直接注册授权页");
        await this.openDirectSignupAuthorizePage(this.email);

        this.logProgress(step++, totalSteps, "提交注册邮箱");
        let continueURL = await this.authorizeContinueForSignup(this.signupScreenHint);

        if (continueURL === `${AUTH_BASE_URL}/create-account/password`) {
            totalSteps += 1;
            this.logProgress(step++, totalSteps, "提交注册密码");
            continueURL = await this.registerPassword();
        }

        if (continueURL === AUTH_EMAIL_OTP_SEND_URL) {
            if (this.otpSingle) {
                // 单封模式：跳过主动二次发码，直接用创建账号时自动发的那封
                this.logProgress(step++, totalSteps, "单封模式：跳过二次发码");
                continueURL = `${AUTH_BASE_URL}/email-verification`;
            } else {
                totalSteps += 1;
                this.logProgress(step++, totalSteps, "发送邮箱验证码");
                continueURL = await this.sendEmailOtp();
            }
        }

        if (continueURL === `${AUTH_BASE_URL}/email-verification`) {
            totalSteps += 1;
            this.logProgress(step++, totalSteps, "提交邮箱验证码");
            continueURL = await this.emailOtpValidate();
        }

        if (continueURL === `${AUTH_BASE_URL}/add-phone`) {
            // 复用 resolveAddPhone(含 markAsUsed/markAsSucceed 回写号池:used + bind_count/bind_emails/boundPhone)。
            this.logProgress(step, totalSteps, "进入短信验证(add-phone)");
            continueURL = await this.resolveAddPhone(continueURL);
            step += 1;
            totalSteps += 4;
        }

        if (continueURL === `${AUTH_BASE_URL}/about-you`) {
            totalSteps += 1;
            this.logProgress(step++, totalSteps, "填写基础资料");
            continueURL = await this.completeAboutYou();
        }

        if (continueURL === `${AUTH_BASE_URL}/sign-in-with-chatgpt/codex/consent`) {
            totalSteps += 1;
            this.logProgress(step++, totalSteps, "选择工作区");
            continueURL = await this.selectWorkspace(continueURL);
        }

        totalSteps += 1;
        this.logProgress(step++, totalSteps, "交换授权并保存凭证");
        return await this.finalizeAuthorizationFromContinueURL(continueURL);
    }

    prepareManualLogin(prompt: "login" | "none" = "login"): string {
        this.state = randomUrlSafeString(24);
        this.codeVerifier = randomUrlSafeString(64);
        const query = new URLSearchParams({
            client_id: DEFAULT_CLIENT_ID,
            response_type: "code",
            redirect_uri: DEFAULT_REDIRECT_URI,
            scope: "openid email profile offline_access",
            state: this.state,
            code_challenge: pkceCodeChallenge(this.codeVerifier),
            code_challenge_method: "S256",
            prompt,
            id_token_add_organizations: "true",
            codex_cli_simplified_flow: "true",
        });
        return `${AUTH_BASE_URL}/oauth/authorize?${query.toString()}`;
    }

    /** [追加·不影响 authLoginHTTP] 复用当前登录态走 OAuth(带 login_hint 尝试跳过选账号页)拿 refresh_token。 */
    async authGetRefreshTokenViaSession(loginHintEmail: string): Promise<{refresh_token: string; authFile: string}> {
        this.state = randomUrlSafeString(24);
        this.codeVerifier = randomUrlSafeString(64);
        const query = new URLSearchParams({
            client_id: DEFAULT_CLIENT_ID,
            response_type: "code",
            redirect_uri: DEFAULT_REDIRECT_URI,
            scope: "openid email profile offline_access",
            state: this.state,
            code_challenge: pkceCodeChallenge(this.codeVerifier),
            code_challenge_method: "S256",
            prompt: "login",
            login_hint: loginHintEmail,
            id_token_add_organizations: "true",
            codex_cli_simplified_flow: "true",
        });
        const resp = await this.fetch(`${AUTH_BASE_URL}/oauth/authorize?${query.toString()}`, {
            redirect: "follow",
            headers: this.createBrowserHeaders({
                "sec-fetch-dest": "document", "sec-fetch-mode": "navigate", "sec-fetch-site": "none",
            }),
        });
        const result = resp.url.startsWith(DEFAULT_REDIRECT_URI)
            ? this.extractAuthResult(resp.url)
            : await this.followOAuthRedirects(resp.url);
        const authRecord = await this.exchangeCodeForToken(result.code);
        const authFile = await this.saveAuthRecord(authRecord);
        return {refresh_token: authRecord.refresh_token, authFile};
    }

    /**
     * ChatGPT.com (web) 的 phone-first 注册入口。
     * 用 chatgpt.com 的 client_id (app_X8zY6vW2pQ9tR3dE7nK1jL5gH)，
     * scope 包含 model.read/model.request 等 ChatGPT 网页所需 scope，
     * redirect 回到 chatgpt.com/api/auth/callback/openai。
     *
     * 该入口允许 username 是 +<phone>，触发 phone-first signup 流程。
     */
    prepareChatGPTWebAuthorizeURL(loginHintPhone: string): string {
        this.state = randomUrlSafeString(24);
        this.codeVerifier = randomUrlSafeString(64);
        const query = new URLSearchParams({
            client_id: "app_X8zY6vW2pQ9tR3dE7nK1jL5gH",
            scope: "openid email profile offline_access model.request model.read organization.read organization.write",
            response_type: "code",
            redirect_uri: "https://chatgpt.com/api/auth/callback/openai",
            audience: "https://api.openai.com/v1",
            device_id: this.deviceProfile?.id || randomUrlSafeString(36),
            prompt: "login",
            "ext-oai-did": this.deviceProfile?.id || randomUrlSafeString(36),
            screen_hint: "login_or_signup",
            login_hint: loginHintPhone,
            state: this.state,
        });
        return `${AUTH_BASE_URL}/api/accounts/authorize?${query.toString()}`;
    }

    async openChatGPTWebAuthorizePage(loginHintPhone: string): Promise<void> {
        const url = this.prepareChatGPTWebAuthorizeURL(loginHintPhone);
        const response = await this.fetch(url, {
            method: "GET",
            redirect: "follow",
            headers: this.createBrowserHeaders({
                "accept-encoding": "gzip, deflate, br",
                "sec-fetch-dest": "document",
                "sec-fetch-mode": "navigate",
                "sec-fetch-site": "cross-site",
                referer: "https://chatgpt.com/",
            }),
        });
        if (!response.ok) {
            throw new Error(`打开 ChatGPT 网页授权页失败: ${response.status}`);
        }
        // 调试 + 早期判定：OAI 把 session 推到哪个页面决定后续状态机。
        //   /create-account/password → 新号，正常走 register
        //   /log-in/password         → 该号已注册，走 register 必失败（invalid_auth_step）
        //   /log-in                  → 也是已注册路径
        const finalURL = String(response.url || "");
        console.log(`[phone-signup] authorize page resolved url: ${finalURL}`);
        if (finalURL.startsWith(`${AUTH_BASE_URL}/log-in`)) {
            // 用 PHONE_ALREADY_REGISTERED 这个稳定前缀，外层 retry 可以识别后跳过该号
            throw new Error(
                `PHONE_ALREADY_REGISTERED: 手机号 ${loginHintPhone} 已被 OpenAI 注册（authorize 跳到 ${finalURL}），换号`,
            );
        }
    }

    /**
     * Phone-first signup 的 phone OTP 发送：GET /api/accounts/phone-otp/send
     * 这条路径不带 phone_number body，号码已经在 authorize 阶段通过 login_hint 注册。
     * 实际发短信由 user/register 之后的 302 redirect 自动触发。
     */
    async sendPhoneOtpForSignup(): Promise<string> {
        const response = await this.fetch(`${AUTH_BASE_URL}/api/accounts/phone-otp/send`, {
            method: "GET",
            headers: this.createBrowserHeaders({
                accept: "application/json",
                referer: `${AUTH_BASE_URL}/create-account/password`,
                "sec-fetch-dest": "document",
                "sec-fetch-mode": "navigate",
                "sec-fetch-site": "same-origin",
            }),
        });
        if (!response.ok) {
            throw new Error(`PhoneSignupOtpSend请求失败: ${await this.formatErrorResponse(response)}`);
        }
        // 这是个 GET endpoint（302 -> /contact-verification），但是某些版本可能返回 JSON
        try {
            const payload = (await response.json()) as ContinueResponse;
            return payload.continue_url ?? "";
        } catch {
            return "";
        }
    }

    /**
     * Phone-first 注册一体化流程。
     * @param phoneNumber 完整手机号 (+57xxxxxxx)
     * @param fetchPhoneCode  () => Promise<string>  从外部接码平台取 OTP
     */
    async authPhoneSignupHTTP(
        phoneNumber: string,
        fetchPhoneCode: () => Promise<string>,
    ): Promise<{callbackURL: string}> {
        if (!phoneNumber.startsWith("+")) {
            throw new Error(`phoneNumber 必须包含国家码前缀，比如 +57xxx, got: ${phoneNumber}`);
        }
        // phone 当 email 用（auth 文件名等）
        if (!this.email) {
            this.email = phoneNumber;
        }

        const totalSteps = 5;

        // Step 1: 打开 chatgpt.com web authorize 页（带 login_hint=+phone）
        this.logProgress(1, totalSteps, `打开 ChatGPT 网页授权页 (phone=${phoneNumber})`);
        await this.openChatGPTWebAuthorizePage(phoneNumber);

        // Step 2: POST /api/accounts/user/register
        // 复用 registerPassword 但 username 是 phone（不是 email）
        this.logProgress(2, totalSteps, `提交手机号注册`);
        const sentinelToken1 = await this.fetchSentinelToken("username_password_create");
        const respReg = await this.postJSON(
            AUTH_REGISTER_URL,
            {password: this.password, username: phoneNumber},
            {
                referer: `${AUTH_BASE_URL}/create-account/password`,
                sentinelToken: sentinelToken1,
            },
        );
        if (!respReg.ok) {
            throw new Error(`PhoneSignupRegister请求失败: ${await this.formatErrorResponse(respReg)}`);
        }
        // 响应 continue_url 应该是 /api/accounts/phone-otp/send
        await respReg.json();

        // Step 3: GET /api/accounts/phone-otp/send 触发 SMS
        this.logProgress(3, totalSteps, `触发 phone OTP 发送`);
        await this.sendPhoneOtpForSignup();

        // Step 4: 等待外部 OTP 输入，POST /api/accounts/phone-otp/validate
        this.logProgress(4, totalSteps, `等待 phone OTP`);
        const code = await fetchPhoneCode();
        if (!code) {
            throw new Error("phone OTP 未提供");
        }
        this.logProgress(4, totalSteps, `验证 phone OTP code=${code}`);
        const respValidate = await this.postJSON(
            `${AUTH_BASE_URL}/api/accounts/phone-otp/validate`,
            {code},
            {referer: `${AUTH_BASE_URL}/contact-verification`},
        );
        if (!respValidate.ok) {
            throw new Error(`PhoneSignupValidate请求失败: ${await this.formatErrorResponse(respValidate)}`);
        }
        await respValidate.json();

        // Step 5: 完成 about-you (create_account)
        this.logProgress(5, totalSteps, `填写基础资料并完成注册`);
        const callbackURL = await this.completeAboutYou();

        return {callbackURL};
    }

    async authorizeContinue(): Promise<string> {
        const sentinelToken = await this.fetchSentinelToken("authorize_continue");
        // 自动检测 username kind：以 + 开头视为 phone_number
        const isPhone = this.email.startsWith("+");
        const usernameKind = isPhone ? "phone_number" : "email";
        const response = await this.fetch(AUTH_AUTHORIZE_CONTINUE_URL, {
            method: "POST",
            headers: {
                "content-type": "application/json",
                "openai-sentinel-token": sentinelToken,
                "user-agent": this.userAgent,
                "accept-language": this.deviceProfile.acceptLanguage,
                "sec-ch-ua": this.clientHints.secChUa,
                "sec-ch-ua-full-version-list": this.clientHints.secChUaFullVersionList,
                "sec-ch-ua-mobile": this.clientHints.secChUaMobile,
                "sec-ch-ua-platform": this.clientHints.secChUaPlatform,
                "sec-ch-ua-platform-version": this.clientHints.secChUaPlatformVersion,
                "sec-ch-viewport-width": this.clientHints.secChViewportWidth,
            },
            body: JSON.stringify({
                username: {
                    kind: usernameKind,
                    value: this.email,
                },
            }),
        });
        if (!response.ok) {
            throw new Error(
                `AuthorizeContinue请求失败: ${await this.formatErrorResponse(response)}`,
            );
        }
        const payload = (await response.json()) as ContinueResponse;
        return payload.continue_url;
    }

    async authorizeContinueForSignup(screenHint = "login_or_signup"): Promise<string> {
        const sentinelToken = await this.fetchSentinelToken("authorize_continue");
        const response = await this.postJSON(
            AUTH_AUTHORIZE_CONTINUE_URL,
            {
                username: {
                    kind: "email",
                    value: this.email,
                },
                screen_hint: screenHint,
            },
            {
                referer: `${AUTH_BASE_URL}/log-in-or-create-account?usernameKind=email`,
                sentinelToken,
            },
        );
        if (!response.ok) {
            throw new Error(
                `AuthorizeContinue注册请求失败: ${await this.formatErrorResponse(response)}`,
            );
        }
        const payload = (await response.json()) as ContinueResponse;
        return payload.continue_url;
    }

    async passwordVerify(): Promise<string> {
        const sentinelToken = await this.fetchSentinelToken("password_verify");
        const response = await this.postJSON(
            AUTH_PASSWORD_VERIFY_URL,
            {
                password: this.password,
            },
            {
                referer: `${AUTH_BASE_URL}/log-in/password`,
                sentinelToken,
            },
        );
        if (!response.ok) {
            throw new Error(
                `PasswordVerify请求失败: ${await this.formatErrorResponse(response)}`,
            );
        }
        const payload = (await response.json()) as ContinueResponse;
        return payload.continue_url;
    }

    async emailOtpValidate(externalCode?: string, excludeCode = "", depth = 0): Promise<string> {
        const code = externalCode || await this.resolveEmailOtpCode(excludeCode);
        const response = await this.fetch(AUTH_EMAIL_OTP_VALIDATE_URL, {
            method: "POST",
            headers: {
                accept: "application/json",
                "content-type": "application/json",
                origin: AUTH_BASE_URL,
                referer: `${AUTH_BASE_URL}/email-verification`,
                "user-agent": this.userAgent,
            },
            body: JSON.stringify({code}),
        });
        if (!response.ok) {
            const errText = await this.formatErrorResponse(response);
            // wrong_email_otp_code 常因邮箱有旧 OTP 残留(重复注册/刚发的新码还没到)→ 排除此码等新邮件重试
            if (!externalCode && depth < 2 && /wrong_email_otp_code|Wrong code/i.test(errText)) {
                console.warn(`[emailOtp] 验证码 ${code} 被拒(疑旧邮件残留)，排除它等新码重试(${depth + 1}/2)…`);
                return this.emailOtpValidate(undefined, code, depth + 1);
            }
            throw new Error(`EmailOtpValidate请求失败: ${errText}`);
        }
        const payload = (await response.json()) as ContinueResponse;
        return payload.continue_url;
    }

    async registerPassword(): Promise<string> {
        const sentinelToken = await this.fetchSentinelToken("username_password_create");
        const response = await this.postJSON(
            AUTH_REGISTER_URL,
            {
                password: this.password,
                username: this.email,
            },
            {
                referer: `${AUTH_BASE_URL}/create-account/password`,
                sentinelToken,
            },
        );
        if (!response.ok) {
            throw new Error(
                `RegisterPassword请求失败: ${await this.formatErrorResponse(response)}`,
            );
        }
        const payload = (await response.json()) as ContinueResponse;
        return payload.continue_url;
    }

    async sendEmailOtp(): Promise<string> {
        const response = await this.fetch(AUTH_EMAIL_OTP_SEND_URL, {
            method: "GET",
            headers: {
                accept: "application/json",
                referer: `${AUTH_BASE_URL}/create-account/password`,
                "user-agent": this.userAgent,
                "accept-language": this.deviceProfile.acceptLanguage,
                "sec-ch-ua": this.clientHints.secChUa,
                "sec-ch-ua-full-version-list": this.clientHints.secChUaFullVersionList,
                "sec-ch-ua-mobile": this.clientHints.secChUaMobile,
                "sec-ch-ua-platform": this.clientHints.secChUaPlatform,
                "sec-ch-ua-platform-version": this.clientHints.secChUaPlatformVersion,
                "sec-ch-viewport-width": this.clientHints.secChViewportWidth,
            },
        });
        if (!response.ok) {
            throw new Error(
                `EmailOtpSend请求失败: ${await this.formatErrorResponse(response)}`,
            );
        }
        const payload = (await response.json()) as ContinueResponse;
        return payload.continue_url;
    }

    async validatePhone(code: string) {
        const response = await this.postJSON(`${AUTH_BASE_URL}/api/accounts/phone-otp/validate`,
          { code: code },
          { referer: `${AUTH_BASE_URL}/phone-verification` },
        );
        if (!response.ok) {
            throw new Error(
              `PhoneOtpValidate请求失败: ${await this.formatErrorResponse(response)}`,
            );
        }
        const payload = (await response.json()) as ContinueResponse;
        return payload.continue_url;
    }

    async sendPhoneOtp(phoneNumber: string) {
        const response = await this.postJSON(
          `${AUTH_BASE_URL}/api/accounts/add-phone/send`,
          {
              phone_number: phoneNumber,
          },
          {
              referer: `${AUTH_BASE_URL}/add-phone`,
          },
        );
        if (!response.ok) {
            const err = new Error(
              `SendPhoneOtp请求失败(HTTP ${response.status}): ${await this.formatErrorResponse(response)}`,
            );
            // 4xx(非429)= OpenAI 明确拒号(已用过/黑名单/无效) → 该号作废换新号；
            // 429限流 / 5xx服务端错 = 临时问题，非号本身问题 → 号应保留可重用(省接码费)。
            err.phoneRejected = response.status >= 400 && response.status < 500 && response.status !== 429;
            throw err;
        }
        const payload = (await response.json()) as ContinueResponse;
        return payload.continue_url;
    }

    /**
     * Phone-only 账号补绑邮箱：POST /api/accounts/add-email/send
     * body: {"email": "xxx@outlook.com"}
     * 触发邮件 OTP 发送，响应 continue_url 跳到 /email-verification
     */
    async sendAddEmail(emailAddr: string): Promise<string> {
        const response = await this.postJSON(
            `${AUTH_BASE_URL}/api/accounts/add-email/send`,
            {email: emailAddr},
            {referer: `${AUTH_BASE_URL}/add-email`},
        );
        if (!response.ok) {
            throw new Error(
                `SendAddEmail请求失败: ${await this.formatErrorResponse(response)}`,
            );
        }
        const payload = (await response.json()) as ContinueResponse;
        return payload.continue_url;
    }

    async selectWorkspace(consentURL: string): Promise<string> {
        await this.fetch(consentURL, {
            method: "GET",
            headers: {
                accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
                referer: `${AUTH_BASE_URL}/email-verification`,
                "user-agent": this.userAgent,
                "accept-language": this.deviceProfile.acceptLanguage,
                "sec-ch-ua": this.clientHints.secChUa,
                "sec-ch-ua-full-version-list": this.clientHints.secChUaFullVersionList,
                "sec-ch-ua-mobile": this.clientHints.secChUaMobile,
                "sec-ch-ua-platform": this.clientHints.secChUaPlatform,
                "sec-ch-ua-platform-version": this.clientHints.secChUaPlatformVersion,
                "sec-ch-viewport-width": this.clientHints.secChViewportWidth,
            },
        });

        const workspaceID = await this.resolveWorkspaceID();
        const response = await this.fetch(AUTH_WORKSPACE_SELECT_URL, {
            method: "POST",
            headers: {
                accept: "application/json",
                "content-type": "application/json",
                origin: AUTH_BASE_URL,
                referer: consentURL,
                "user-agent": this.userAgent,
                "accept-language": this.deviceProfile.acceptLanguage,
                "sec-ch-ua": this.clientHints.secChUa,
                "sec-ch-ua-full-version-list": this.clientHints.secChUaFullVersionList,
                "sec-ch-ua-mobile": this.clientHints.secChUaMobile,
                "sec-ch-ua-platform": this.clientHints.secChUaPlatform,
                "sec-ch-ua-platform-version": this.clientHints.secChUaPlatformVersion,
                "sec-ch-viewport-width": this.clientHints.secChViewportWidth,
            },
            body: JSON.stringify({
                workspace_id: workspaceID,
            }),
        });
        if (!response.ok) {
            throw new Error(
                `WorkspaceSelect请求失败: ${await this.formatErrorResponse(response)}`,
            );
        }
        const payload = (await response.json()) as ContinueResponse;
        return payload.continue_url;
    }

    async followOAuthRedirects(startURL: string): Promise<AuthLoginResult> {
        let currentURL = startURL;
        for (let hop = 0; hop < 10; hop++) {
            const response = await this.fetch(currentURL, {
                method: "GET",
                redirect: "manual",
                headers: {
                    accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
                    "user-agent": this.userAgent,
                    "accept-language": this.deviceProfile.acceptLanguage,
                    "sec-ch-ua": this.clientHints.secChUa,
                    "sec-ch-ua-full-version-list": this.clientHints.secChUaFullVersionList,
                    "sec-ch-ua-mobile": this.clientHints.secChUaMobile,
                    "sec-ch-ua-platform": this.clientHints.secChUaPlatform,
                    "sec-ch-ua-platform-version": this.clientHints.secChUaPlatformVersion,
                    "sec-ch-viewport-width": this.clientHints.secChViewportWidth,
                },
            });

            const location = response.headers.get("location");
            if (location) {
                const nextURL = new URL(location, currentURL).toString();
                if (nextURL.startsWith(`${AUTH_BASE_URL}/add-phone`)) {
                    throw new Error("当前账号在登录后触发了 add-phone 绑手机流程，无法直接完成授权");
                }
                if (nextURL.startsWith(DEFAULT_REDIRECT_URI)) {
                    return this.extractAuthResult(nextURL);
                }
                currentURL = nextURL;
                continue;
            }

            if (response.url.startsWith(`${AUTH_BASE_URL}/add-phone`)) {
                throw new Error("当前账号在登录后触发了 add-phone 绑手机流程，无法直接完成授权");
            }

            if (response.url.startsWith(DEFAULT_REDIRECT_URI)) {
                return this.extractAuthResult(response.url);
            }

            throw new Error(
                `OAuth跳转未到达callback: status=${response.status} url=${response.url}`,
            );
        }

        throw new Error(`OAuth跳转次数过多，最后停在: ${currentURL}`);
    }

    private async finalizeAuthorizationFromContinueURL(startURL: string): Promise<AuthLoginResult> {
        if (startURL.startsWith(DEFAULT_REDIRECT_URI)) {
            const result = this.extractAuthResult(startURL);
            const authRecord = await this.exchangeCodeForToken(result.code);
            result.authFile = await this.saveAuthRecord(authRecord);
            return result;
        }

        const result = await this.followOAuthRedirects(startURL);
        const authRecord = await this.exchangeCodeForToken(result.code);
        result.authFile = await this.saveAuthRecord(authRecord);
        return result;
    }

    async fetchSentinelToken(
        flow:
            | "authorize_continue"
            | "password_verify"
            | "username_password_create"
            | "oauth_create_account",
    ): Promise<string> {
        return fetchSentinelToken({
            flow,
            deviceID: this.deviceID,
            fetch: this.fetch,
            reqEndpoint: "https://sentinel.openai.com/backend-api/sentinel/req",
            userAgent: this.userAgent,
            deviceProfile: this.deviceProfile,
        });
    }

    private async resolveEmailOtpCode(excludeCode = ""): Promise<string> {
        if (this.manualMode) {
            console.log(`manualEmailOtp: targetEmail=${this.email}`);
            return this.promptEmailOtp();
        }
        console.log(`autoEmailOtp: provider=${MAILBOX_CONFIG.provider} targetEmail=${this.email}`);
        return getEmailVerificationCode(this.email, excludeCode ? {excludeCode} : undefined);
    }

    private async generateRegisterEmail(): Promise<string> {
        if (this.email) {
            return this.email;
        }
        return getEmailAddress();
    }

    private async promptEmailOtp(): Promise<string> {
        const rl = createInterface({input, output});
        try {
            const code = (await rl.question("请输入邮箱验证码: ")).trim();
            if (!/^\d{6}$/.test(code)) {
                throw new Error(`邮箱验证码格式不正确: ${code}`);
            }
            return code;
        } finally {
            rl.close();
        }
    }

    private async completeAboutYou(): Promise<string> {
        const sentinelToken = await this.fetchSentinelToken("oauth_create_account");
        const profile = this.randomProfile();
        console.log("registerProfile:", JSON.stringify(profile));

        const response = await this.postJSON(
            `${AUTH_BASE_URL}/api/accounts/create_account`,
            profile,
            {
                referer: `${AUTH_BASE_URL}/about-you`,
                sentinelToken,
            },
        );
        if (!response.ok) {
            throw new Error(
                `CreateAccount请求失败: ${await this.formatErrorResponse(response)}`,
            );
        }
        const payload = (await response.json()) as ContinueResponse;
        return payload.page?.payload?.url ?? payload.continue_url;
    }

    private async finishChatGPTRegistration(callbackURL: string): Promise<void> {
        const response = await this.fetch(callbackURL, {
            method: "GET",
            redirect: "follow",
            headers: {
                accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
                referer: `${AUTH_BASE_URL}/about-you`,
                "user-agent": this.userAgent,
                "accept-language": this.deviceProfile.acceptLanguage,
                "sec-ch-ua": this.clientHints.secChUa,
                "sec-ch-ua-full-version-list": this.clientHints.secChUaFullVersionList,
                "sec-ch-ua-mobile": this.clientHints.secChUaMobile,
                "sec-ch-ua-platform": this.clientHints.secChUaPlatform,
                "sec-ch-ua-platform-version": this.clientHints.secChUaPlatformVersion,
                "sec-ch-viewport-width": this.clientHints.secChViewportWidth,
            },
        });
        if (!response.ok) {
            throw new Error(`完成 ChatGPT 注册回调失败: ${response.status}`);
        }
    }

    async getChatGPTAccessToken(): Promise<string> {
        const response = await this.fetch(`${CHATGPT_BASE_URL}/api/auth/session`, {
            method: "GET",
            headers: this.createBrowserHeaders({
                accept: "application/json",
                "sec-fetch-dest": "empty",
                "sec-fetch-mode": "cors",
                "sec-fetch-site": "same-origin",
                referer: `${CHATGPT_BASE_URL}/`,
            }),
        });
        if (!response.ok) {
            throw new Error(`获取 ChatGPT accessToken 失败: ${await this.formatErrorResponse(response)}`);
        }

        const payload = (await response.json()) as ChatGPTAuthSession;
        const accessToken = String(payload.accessToken ?? payload.access_token ?? "").trim();
        if (!accessToken) {
            throw new Error(`ChatGPT session 中缺少 accessToken: ${JSON.stringify(payload)}`);
        }
        this.lastSession = payload;
        return accessToken;
    }

    async saveChatGPTAccessToken(accessToken: string): Promise<string> {
        const atDir = path.resolve(process.cwd(), "auth", "at");
        await mkdir(atDir, {recursive: true});
        const fileName = this.buildAuthFileName(this.email);
        const filePath = path.join(atDir, fileName);
        // 接码凭据：注册邮箱常是别名，真正能接码的是底层账号那条 line。
        // 取不到则忽略（其他 provider 可能不支持）。
        let mailbox: Awaited<ReturnType<typeof getMailboxCredential>> = null;
        try {
            mailbox = await getMailboxCredential(this.email);
        } catch (err) {
            console.warn(`[警告] 取邮箱接码凭据失败: ${(err as Error).message}`);
        }
        // auth 记录构造（session 完整格式 + 接码凭据 + JWT 兜底）抽到 email-reg/auth-record。
        const record = buildAuthRecord({
            accessToken,
            email: this.email,
            session: this.lastSession,
            mailbox,
            cookie: await this.jar.getCookieString(CHATGPT_BASE_URL),
        });
        // 紧凑存储(不格式化)，session 原样保留
        await writeFile(filePath, `${JSON.stringify(record)}\n`, "utf8");
        return filePath;
    }

    private async exchangeCodeForToken(code: string): Promise<SavedAuthRecord> {
        let lastError = "";
        for (const tokenURL of AUTH_OAUTH_TOKEN_URLS) {
            const body = new URLSearchParams({
                grant_type: "authorization_code",
                client_id: DEFAULT_CLIENT_ID,
                code,
                redirect_uri: DEFAULT_REDIRECT_URI,
                code_verifier: this.codeVerifier,
            });
            const response = await this.fetch(tokenURL, {
                method: "POST",
                headers: this.createBrowserHeaders({
                    accept: "application/json",
                    "content-type": "application/x-www-form-urlencoded",
                    "sec-fetch-dest": "empty",
                    "sec-fetch-mode": "cors",
                    "sec-fetch-site": "same-site",
                }),
                body,
            });
            if (!response.ok) {
                lastError = `endpoint=${tokenURL} ${await this.formatErrorResponse(response)}`;
                continue;
            }

            const payload = (await response.json()) as OAuthTokenResponse;
            return this.normalizeAuthRecord(payload);
        }

        throw new Error(`Code换Token失败: ${lastError}`);
    }

    private async resolveWorkspaceID(): Promise<string> {
        const cookie = await this.readCookie(
            AUTH_BASE_URL,
            "oai-client-auth-session",
        );
        if (!cookie) {
            throw new Error("未找到 oai-client-auth-session cookie，无法提取 workspace");
        }

        const encodedPayload = cookie.split(".")[0];
        const payload = this.decodeSignedJson<ClientAuthSessionPayload>(encodedPayload);
        const workspaceID =
            payload.workspaces?.find((w) => w.kind === "personal")?.id
            ?? payload.workspaces?.[0]?.id;
        if (!workspaceID) {
            throw new Error(`当前会话未发现 workspace: ${JSON.stringify(payload)}`);
        }
        return workspaceID;
    }

    private decodeSignedJson<T>(encoded: string): T {
        const normalized = encoded.replace(/-/g, "+").replace(/_/g, "/");
        const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
        const json = Buffer.from(padded, "base64").toString("utf8");
        return JSON.parse(json) as T;
    }

    private normalizeAuthRecord(payload: OAuthTokenResponse): SavedAuthRecord {
        if (!payload.access_token) {
            throw new Error(`token响应缺少 access_token: ${JSON.stringify(payload)}`);
        }
        if (!payload.refresh_token) {
            throw new Error(`token响应缺少 refresh_token: ${JSON.stringify(payload)}`);
        }
        if (!payload.id_token) {
            throw new Error(`token响应缺少 id_token: ${JSON.stringify(payload)}`);
        }

        const accessClaims = this.decodeJwtPayload<JwtPayload>(payload.access_token);
        const idClaims = this.decodeJwtPayload<JwtPayload>(payload.id_token);
        const email = idClaims.email ?? accessClaims.email ?? this.email;
        const accountID =
            accessClaims["https://api.openai.com/auth"]?.chatgpt_account_id ??
            idClaims["https://api.openai.com/auth"]?.chatgpt_account_id ??
            "";
        const exp = accessClaims.exp;
        if (!accountID) {
            // 新注册的 phone-only 账号在 codex CLI OAuth client 下通常没有 chatgpt_account_id
            // (OpenAI 后端给新账号生成 ChatGPT subscription/account 关联是异步的)。
            // CPA(CLIProxyAPI) 也允许这个字段为空,保存 access_token 给后续 stripe checkout 用。
            // 不再抛错,只警告。
            console.warn(`token 暂无 chatgpt_account_id (新号常见,可继续):`, JSON.stringify(accessClaims).slice(0, 300));
        }
        if (!exp) {
            throw new Error(`access_token中缺少 exp: ${JSON.stringify(accessClaims)}`);
        }

        return {
            access_token: payload.access_token,
            account_id: accountID,
            disabled: false,
            email,
            expired: new Date(exp * 1000).toISOString(),
            id_token: payload.id_token,
            last_refresh: new Date().toISOString(),
            refresh_token: payload.refresh_token,
            type: "codex",
            websockets: false,
        };
    }

    private decodeJwtPayload<T>(token: string): T {
        const parts = token.split(".");
        if (parts.length < 2) {
            throw new Error(`JWT格式不正确: ${token.slice(0, 24)}...`);
        }
        return this.decodeSignedJson<T>(parts[1]);
    }

    private extractAuthResult(callbackURL: string): AuthLoginResult {
        const url = new URL(callbackURL);
        const code = url.searchParams.get("code") ?? "";
        const state = url.searchParams.get("state") ?? "";
        if (!code) {
            throw new Error(`callback 中缺少 code: ${callbackURL}`);
        }
        if (!state) {
            throw new Error(`callback 中缺少 state: ${callbackURL}`);
        }
        if (this.state && state !== this.state) {
            throw new Error(
                `callback state 不匹配: expected=${this.state} actual=${state}`,
            );
        }
        return {
            callbackURL,
            code,
            state,
        };
    }

    private async saveAuthRecord(record: SavedAuthRecord): Promise<string> {
        this.lastSavedAuthRecord = record;
        const authDir = path.resolve(process.cwd(), "auth");
        await mkdir(authDir, {recursive: true});
        const fileName = this.buildAuthFileName(record.email);
        const filePath = path.join(authDir, fileName);
        await writeFile(filePath, `${JSON.stringify(record, null, 2)}\n`, "utf8");

        if (shouldAutoUploadAuthToCLIProxyAPI()) {
            try {
                await uploadAuthFileToCLIProxyAPI(fileName, record);
                console.log(`cliproxyApiAuthUploaded: ${fileName}`);
            } catch (error) {
                console.warn(
                    `cliproxyApiAuthUploadFailed: ${fileName} error=${error instanceof Error ? error.message : String(error)}`,
                );
            }
        }

        return filePath;
    }

    private buildAuthFileName(email: string): string {
        const now = new Date();
        const date = [
            now.getFullYear(),
            `${now.getMonth() + 1}`.padStart(2, "0"),
            `${now.getDate()}`.padStart(2, "0"),
        ].join("-");
        const safeEmail = email.replace(/[<>:"/\\|?*\x00-\x1F]/g, "_");
        return `${date}-${safeEmail}.json`;
    }

    private randomProfile(): { name: string; birthdate: string } {
        const firstNames = [
            "Ethan",
            "Noah",
            "Liam",
            "Mason",
            "Lucas",
            "Logan",
            "Owen",
            "Ryan",
            "Leo",
            "Adam",
            "Ella",
            "Ava",
            "Mia",
            "Luna",
            "Chloe",
            "Grace",
            "Ruby",
            "Nora",
            "Ivy",
            "Sofia",
        ];
        const lastNames = [
            "Smith",
            "Brown",
            "Taylor",
            "Walker",
            "Wilson",
            "Clark",
            "Hall",
            "Young",
            "Allen",
            "King",
            "Scott",
            "Green",
            "Baker",
            "Adams",
            "Turner",
        ];
        const age = this.randomInt(25, 34);
        const today = new Date();
        const birthYear = today.getFullYear() - age;
        const birthMonth = this.randomInt(1, 12);
        const maxDay = new Date(birthYear, birthMonth, 0).getDate();
        const birthDay = this.randomInt(1, maxDay);

        return {
            name: `${this.pick(firstNames)} ${this.pick(lastNames)}`,
            birthdate: [
                birthYear,
                `${birthMonth}`.padStart(2, "0"),
                `${birthDay}`.padStart(2, "0"),
            ].join("-"),
        };
    }

    private pick<T>(items: T[]): T {
        return items[Math.floor(Math.random() * items.length)];
    }

    private randomInt(min: number, max: number): number {
        return Math.floor(Math.random() * (max - min + 1)) + min;
    }

    private async bootChatGPTSession(): Promise<void> {
        const response = await this.fetch(`${CHATGPT_BASE_URL}/`, {
            method: "GET",
            redirect: "follow",
            headers: this.createBrowserHeaders({
                "accept-encoding": "gzip, deflate, br",
                "sec-fetch-dest": "document",
                "sec-fetch-mode": "navigate",
                "sec-fetch-site": "none",
            }),
        });
        if (!response.ok) {
            throw new Error(`打开 chatgpt.com 失败: ${response.status}`);
        }

        this.deviceID =
            (await this.readCookie(CHATGPT_BASE_URL, "oai-did")) ||
            (await this.readCookie("https://openai.com", "oai-did"));
        if (!this.deviceID) {
            throw new Error("chatgpt.com 未返回 oai-did cookie");
        }

        // chatgpt.com 首页不再下发 NextAuth 的 __Host-next-auth.csrf-token，
        // 预取一次让 NextAuth set 这个 cookie（详见 email-reg/nextauth-csrf）。
        await ensureNextAuthCsrf(
            this.fetch,
            CHATGPT_BASE_URL,
            this.createBrowserHeaders({
                accept: "application/json",
                referer: `${CHATGPT_BASE_URL}/`,
                "sec-fetch-dest": "empty",
                "sec-fetch-mode": "cors",
                "sec-fetch-site": "same-origin",
            }),
        );
    }

    private async openSignupPage(email: string): Promise<void> {
        const csrfCookie = await this.readCookie(
            CHATGPT_BASE_URL,
            "__Host-next-auth.csrf-token",
        );
        const csrfToken = decodeURIComponent(csrfCookie).split("|")[0] ?? "";
        if (!csrfToken) {
            throw new Error("未找到 __Host-next-auth.csrf-token，无法打开注册页");
        }

        const query = new URLSearchParams({
            prompt: "login",
            "ext-oai-did": this.deviceID,
            auth_session_logging_id: globalThis.crypto.randomUUID(),
            "ext-passkey-client-capabilities": "0111",
            screen_hint: "login_or_signup",
            login_hint: email,
        });
        const body = new URLSearchParams({
            callbackUrl: `${CHATGPT_BASE_URL}/`,
            csrfToken,
            json: "true",
        });

        const response = await this.fetch(
            `${CHATGPT_BASE_URL}/api/auth/signin/openai?${query.toString()}`,
            {
                method: "POST",
                redirect: "follow",
                headers: this.createBrowserHeaders({
                    accept: "*/*",
                    "content-type": "application/x-www-form-urlencoded",
                    origin: CHATGPT_BASE_URL,
                    referer: `${CHATGPT_BASE_URL}/`,
                    "sec-fetch-dest": "empty",
                    "sec-fetch-mode": "cors",
                    "sec-fetch-site": "same-origin",
                }),
                body,
            },
        );
        if (!response.ok) {
            throw new Error(`打开注册页失败: ${response.status}`);
        }

        const payload = (await response.json()) as { url?: string };
        if (!payload.url) {
            throw new Error(`打开注册页缺少跳转URL: ${JSON.stringify(payload)}`);
        }

        const authorizeResp = await this.fetch(payload.url, {
            method: "GET",
            redirect: "follow",
            headers: this.createBrowserHeaders({
                "accept-encoding": "gzip, deflate, br",
                referer: `${CHATGPT_BASE_URL}/`,
                "sec-fetch-dest": "document",
                "sec-fetch-mode": "navigate",
                "sec-fetch-site": "same-site",
            }),
        });
        if (!authorizeResp.ok) {
            throw new Error(`打开 OpenAI authorize 页失败: ${authorizeResp.status}`);
        }
    }

    private async postJSON(
        url: string,
        payload: unknown,
        options: {
            referer: string;
            sentinelToken?: string;
        },
    ): Promise<Response> {
        const headers = this.createBrowserHeaders({
            accept: "application/json",
            "content-type": "application/json",
            origin: AUTH_BASE_URL,
            referer: options.referer,
            "sec-fetch-dest": "empty",
            "sec-fetch-mode": "cors",
            "sec-fetch-site": "same-origin",
        });
        if (options.sentinelToken) {
            headers.set("openai-sentinel-token", options.sentinelToken);
        }
        return this.fetch(url, {
            method: "POST",
            headers,
            body: JSON.stringify(payload),
        });
    }

    private async readCookie(url: string, key: string): Promise<string> {
        const cookies = await this.jar.getCookies(url);
        return cookies.find((cookie) => cookie.key === key)?.value ?? "";
    }

    private async openDirectSignupAuthorizePage(email: string): Promise<void> {
        const oauthUrl = this.prepareManualLogin();
        const authorizeUrl = new URL(oauthUrl);
        authorizeUrl.searchParams.set("screen_hint", this.signupScreenHint);
        authorizeUrl.searchParams.set("login_hint", email);

        const response = await this.fetch(authorizeUrl.toString(), {
            method: "GET",
            redirect: "follow",
            headers: this.createBrowserHeaders({
                "accept-encoding": "gzip, deflate, br",
                "sec-fetch-dest": "document",
                "sec-fetch-mode": "navigate",
                "sec-fetch-site": "none",
            }),
        });
        if (!response.ok) {
            throw new Error(`打开直接注册授权页失败: ${response.status}`);
        }

        this.deviceID = await this.readCookie("https://openai.com", "oai-did");
        if (!this.deviceID) {
            throw new Error("直接注册授权页未返回 oai-did cookie");
        }
    }

    private createBrowserHeaders(init: Record<string, string>): Headers {
        return new Headers({
            "user-agent": this.userAgent,
            "accept-language": this.deviceProfile.acceptLanguage,
            "sec-ch-ua": this.clientHints.secChUa,
            "sec-ch-ua-full-version-list": this.clientHints.secChUaFullVersionList,
            "sec-ch-ua-mobile": this.clientHints.secChUaMobile,
            "sec-ch-ua-platform": this.clientHints.secChUaPlatform,
            "sec-ch-ua-platform-version": this.clientHints.secChUaPlatformVersion,
            "sec-ch-viewport-width": this.clientHints.secChViewportWidth,
            ...init,
        });
    }

    private async formatErrorResponse(response: Response): Promise<string> {
        const body = await response.text();
        try {
            const payload = JSON.parse(body) as {
                error?: {
                    code?: string | null;
                    message?: string | null;
                    description?: string | null;
                };
                error_description?: string | null;
                detail?: string | null;
                message?: string | null;
            };
            const err = payload.error;
            const code = err?.code ?? null;
            // 把所有可能的 description 字段都提取出来，方便定位 next_step / 提示
            const descParts = [
                err?.message,
                err?.description,
                payload.error_description,
                payload.detail,
                payload.message,
            ].filter((v): v is string => typeof v === "string" && v.length > 0);
            const desc = descParts.length > 0 ? descParts.join(" | ") : "";
            if (code || desc) {
                // 完整 body 也保留（截断 600 字符），避免漏掉嵌套字段
                const trimmed = body.length > 600 ? body.slice(0, 600) + "...(truncated)" : body;
                return `${response.status} code=${code ?? "?"} desc=${desc || "?"} body=${trimmed}`;
            }
        } catch {
            // ignore parse error and fall back to raw body
        }
        return `${response.status} body=${body}`;
    }

    private async fetchWithRetry(
        baseFetch: FetchLike,
        input: Parameters<FetchLike>[0],
        init?: Parameters<FetchLike>[1],
    ): Promise<Response> {
        let lastError: unknown;
        for (let attempt = 1; attempt <= FETCH_RETRY_COUNT; attempt++) {
            try {
                return await baseFetch(input, init);
            } catch (error) {
                lastError = error;
                if (!isRetryableFetchError(error) || attempt >= FETCH_RETRY_COUNT) {
                    throw error;
                }
                console.log(
                    `[网络重试 ${attempt}/${FETCH_RETRY_COUNT}] ${this.describeRetryTarget(input)} ${this.describeRetryError(error)}`,
                );
                console.log(`[延迟] 网络重试等待 ${FETCH_RETRY_DELAY_MS * attempt}ms`);
                await sleep(FETCH_RETRY_DELAY_MS * attempt);
            }
        }
        throw lastError instanceof Error ? lastError : new Error(String(lastError));
    }

    private describeRetryTarget(input: Parameters<FetchLike>[0]): string {
        if (typeof input === "string") {
            return input;
        }
        if (input instanceof URL) {
            return input.toString();
        }
        if (typeof Request !== "undefined" && input instanceof Request) {
            return input.url;
        }
        return "unknown-url";
    }

    private describeRetryError(error: unknown): string {
        const cause = getErrorCause(error);
        if (!cause) {
            return error instanceof Error ? error.message : String(error);
        }
        const code = "code" in cause ? String((cause as { code?: unknown }).code ?? "") : "";
        return code ? `${cause.message} (${code})` : cause.message;
    }
}

function isRetryableFetchError(error: unknown): boolean {
    const message = collectErrorMessages(error).join(" ").toLowerCase();
    return [
        "econnreset",
        "etimedout",
        "socket hang up",
        "proxy connection timed out",
        "fetch failed",
        "eai_again",
        "ecannotassignrequestedaddress",
        "ehostunreach",
        "enetunreach",
    ].some((keyword) => message.includes(keyword));
}

function getErrorCause(error: unknown): Error | null {
    if (error instanceof Error && error.cause instanceof Error) {
        return error.cause;
    }
    return error instanceof Error ? error : null;
}

function collectErrorMessages(error: unknown): string[] {
    const messages: string[] = [];
    if (error instanceof Error) {
        messages.push(error.message);
        if (error.cause instanceof Error) {
            messages.push(error.cause.message);
            const code = "code" in error.cause ? String((error.cause as { code?: unknown }).code ?? "") : "";
            if (code) {
                messages.push(code);
            }
        }
        const code = "code" in error ? String((error as { code?: unknown }).code ?? "") : "";
        if (code) {
            messages.push(code);
        }
    } else if (error != null) {
        messages.push(String(error));
    }
    return messages;
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
