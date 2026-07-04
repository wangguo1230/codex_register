# Codex 登录拿 refresh_token(rt) 完整流程分析

> 来源:`chromewebdata.har`(2026-07-01,teresa 账号手动走了一次完整 codex 登录含接码)
> 目的:搞清楚拿可续期 `refresh_token` 到底需要什么

## 一、核心结论(先看这里)

**拿 rt(codex CLI 的 client `app_EMoamEEZ73f0CkXaXp7hrann`)必须"双重验证":邮箱 OTP + 手机 OTP(接码)。纯邮箱拿不到 rt。**

- 之前控制台产出的网页 token(`app_X8zY6vW2...`)无 rt、约 10 天过期,是因为走 `/api/auth/session`,**没走 codex OAuth**。
- codex OAuth(拿 rt)在 `authorize/continue → email-otp → **add-phone + phone-otp** → consent → workspace/select` 这条链上,**中间强制手机验证**。
- 所以 README 说的"要 rt 得走 `--phone` 链路"在当前政策下**成立**——必须配 SMS 接码平台。

## 二、完整流程(时序)

```
codex CLI 本地(localhost:1455)发起 OAuth
  client_id=app_EMoamEEZ73f0CkXaXp7hrann, scope=...offline_access, PKCE(S256)
  → 浏览器打开 auth.openai.com/oauth/authorize
       │
       ▼
① POST auth.openai.com/api/accounts/authorize/continue      提交邮箱
     header: openai-sentinel-token: {"p":"gAAAAAB..."}      ← sentinel(和注册同套)
     body:   {"username":{"value":"<email>","kind":"email"},"screen_hint":"login_or_signup"}
       │
       ▼
② POST auth.openai.com/api/accounts/email-otp/validate      邮箱验证码(mail.com 接码)
     body:   {"code":"905753"}
       │
       ▼
③ POST auth.openai.com/api/accounts/add-phone/send          ★ 发手机验证码(强制!)
     body:   {"phone_number":"+1XXXXXXXXXX","channel":"sms"}
     注:第一个号可能 400(被拒/已用),换号重试直到 200 —— HAR 里 +1803... 400 → +1267... 200
       │
       ▼
④ POST auth.openai.com/api/accounts/phone-otp/validate      ★ 手机验证码(SMS 接码平台)
     body:   {"code":"258719"}
       │
       ▼
⑤ GET  auth.openai.com/sign-in-with-chatgpt/codex/consent.data   codex 授权同意
       │
       ▼
⑥ POST auth.openai.com/api/accounts/workspace/select        选工作区
     body:   {"workspace_id":"93ac5464-930a-4af1-b2f5-810b2d753e60"}
       │
       ▼
⑦ redirect → localhost:1455/auth/callback?code=<authorization_code>
       │  (这步在 CLI 本地,不在浏览器 HAR)
       ▼
⑧ POST auth.openai.com/oauth/token                          换 token
     grant_type=authorization_code, client_id=app_EMo..., code, code_verifier(PKCE)
     → { access_token, refresh_token, id_token }  ← ★ rt 在这里
```

每步都带 `openai-sentinel-token`(sentinel/req 生成,和注册用的是同一套机制)。

## 三、关键结论对照之前的现象

| 现象 | 解释 |
|---|---|
| 纯邮箱 rt 卡在 `/choose-an-account` | 我们复用注册登录态走 authorize,OpenAI 让选账号;但**即使选了账号,后面照样要 add-phone**(这个 HAR 证明) |
| README 说"要 rt 走 --phone" | ✅ 成立,codex OAuth 强制手机验证 |
| 网页 token 无 rt | 走的是 `/api/auth/session`(网页 client),不是 codex OAuth |

**所以:纯邮箱(无手机)拿不到 rt。要 rt 必须接手机验证码。**

## 四、现有代码已经实现了这条链!

`openai.ts` 里现成的:
- `authRegisterAndAuthorizeHTTP()` (603):注册+授权一体,**内含 add-phone 分支**(`smsBroker.getActivation → sendPhoneOtp → validatePhone`,45s 接不到自动换号、最多 8 次)
- `sendPhoneOtp(phone)` (1030):POST `add-phone/send` {phone_number}
- `validatePhone(code)` (1016):POST `phone-otp/validate` {code}
- `selectWorkspace()`:POST `workspace/select`
- `followOAuthRedirects` + `exchangeCodeForToken` + `normalizeAuthRecord`(强制要 refresh_token)→ 产出 `type:"codex"` 带 rt 的 auth 文件
- `config.json`:`heroSMSApiKey` / `heroSMSCountry` 等(hero-sms 接码平台配置)
- `index.ts` 模式1(`--sign --at [--phone]`)已经把这条串起来了

**即:拿 rt 的完整能力项目里已经有,只差在控制台里接上 SMS 接码平台。**

## 五、在控制台拿 rt 的方案

1. **配 SMS 接码平台**:`config.json` 填 `heroSMSApiKey`(hero-sms)等;或接别的接码平台(实现 `ISMSActivationBroker`)。
2. **worker 改用带手机验证的授权**:注册后走 `authRegisterAndAuthorizeHTTP` 或补一次带 `smsBroker` 的 codex OAuth,拿到 rt。
3. 产出 `type:"codex"` 的 auth 文件(含 `refresh_token`,可长期续期,配 codex/CLIProxyAPI)。

**成本提示**:每个号要消耗一个手机号接码(hero-sms 按条计费),且换号重试可能用掉几个号。纯邮箱注册(无 rt、10天)成本更低但不可续期;要 rt 就得接受接码成本。

## 六、决策建议

| 需求 | 方案 | 手机接码 | 续期 |
|---|---|---|---|
| 短期用(≤10天) | 当前控制台(网页 session token) | 否 | 否 |
| 长期可续期(rt) | 接 SMS 平台 + authRegisterAndAuthorizeHTTP | **是** | 是 |

要不要在控制台接上 SMS 接码、加"拿 rt"开关,取决于你能不能承担手机接码成本、以及是否真的需要长期续期。
