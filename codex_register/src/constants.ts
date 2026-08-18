export {DEFAULT_USER_AGENT} from "./device-profile.js";

export const AUTH_BASE_URL = "https://auth.openai.com";

export const AUTH_AUTHORIZE_CONTINUE_URL =
  "https://auth.openai.com/api/accounts/authorize/continue";

export const AUTH_PASSWORD_VERIFY_URL =
  "https://auth.openai.com/api/accounts/password/verify";

export const AUTH_MFA_VALIDATE_URLS = [
  "https://auth.openai.com/api/accounts/mfa/validate",
  "https://auth.openai.com/api/accounts/totp/validate",
  "https://auth.openai.com/api/accounts/mfa/verify",
] as const;

export const AUTH_EMAIL_OTP_VALIDATE_URL =
  "https://auth.openai.com/api/accounts/email-otp/validate";

export const AUTH_WORKSPACE_SELECT_URL =
  "https://auth.openai.com/api/accounts/workspace/select";

export const AUTH_REGISTER_URL =
  "https://auth.openai.com/api/accounts/user/register";

export const AUTH_EMAIL_OTP_SEND_URL =
  "https://auth.openai.com/api/accounts/email-otp/send";

/** 官网密码页点「发送邮箱验证码」：空 POST，referer=/log-in/password。默认应先 password/verify。 */
export const AUTH_PASSWORDLESS_SEND_OTP_URL =
  "https://auth.openai.com/api/accounts/passwordless/send-otp";

/** chatgpt.com 前端 oai-client-version，换绑请求与官网 HAR 对齐。 */
export const CHATGPT_OAI_CLIENT_VERSION =
  "prod-b8908cce992f0074c4dfd3a0d84d89b93a82e83a";

export const AUTH_OAUTH_TOKEN_URLS = [
  "https://auth.openai.com/api/oauth/oauth2/token",
  "https://auth.openai.com/oauth/token",
] as const;

export const DEFAULT_REDIRECT_URI = "http://localhost:1455/auth/callback";

export const DEFAULT_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";

export const CHATGPT_BASE_URL = "https://chatgpt.com";
