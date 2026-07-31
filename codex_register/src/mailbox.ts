import {appConfig, type MailProviderName} from "./config.js";
import {create2925Provider} from "./mail/2925.js";
import {createCloudflareProvider} from "./mail/cloudflare.js";
import {createGmailProvider} from "./mail/gmail.js";
import {createGPTMailProvider} from "./mail/gptmail.js";
import {createHotmailProvider} from "./mail/hotmail.js";
import {createIcloudProvider} from "./mail/icloud.js";
import {createMailcomProvider} from "./mail/mailcom.js";
import {createProxiedMailProvider} from "./mail/proxiedmail.js";

// MailboxCredential 类型已抽到 email-reg 模块，这里 re-export 保持对外引用不变。
export type {MailboxCredential} from "./email-reg/mailbox-credential.js";
import type {MailboxCredential} from "./email-reg/mailbox-credential.js";

export interface EmailCodeProvider {
  getEmailAddress(): Promise<string>;
  getEmailVerificationCode(email: string, options?: {minTimestampMs?: number; excludeCode?: string}): Promise<string>;
  getMailboxCredential?(email: string): Promise<MailboxCredential>;
}

export const MAILBOX_CONFIG: {
  provider: MailProviderName;
} = {
  provider: appConfig.provider,
};

function createProvider(): EmailCodeProvider {
  switch (MAILBOX_CONFIG.provider) {
    case "proxiedmail":
      return createProxiedMailProvider();
    case "gmail":
      return createGmailProvider();
    case "gptmail":
      return createGPTMailProvider();
    case "hotmail":
      return createHotmailProvider();
    case "mailcom":
      return createMailcomProvider();
    case "2925":
      return create2925Provider();
    case "cloudflare":
      return createCloudflareProvider();
    case "icloud":
      return createIcloudProvider();
    default:
      throw new Error(`不支持的邮箱 provider: ${MAILBOX_CONFIG.provider}`);
  }
}

const provider = createProvider();

export async function getEmailAddress(): Promise<string> {
  return provider.getEmailAddress();
}

export async function getEmailVerificationCode(email: string, options?: {minTimestampMs?: number; excludeCode?: string}): Promise<string> {
  return provider.getEmailVerificationCode(email, options);
}

export async function getMailboxCredential(email: string): Promise<MailboxCredential | null> {
  if (typeof provider.getMailboxCredential === "function") {
    return provider.getMailboxCredential(email);
  }
  return null;
}
