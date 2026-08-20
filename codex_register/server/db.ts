// @ts-nocheck
// 数据访问兼容门面。新代码应按领域依赖 repositories/*，旧调用方继续从 db.ts 导入。
export {instanceId} from "./repositories/database-context.js";
export * from "./repositories/application-work-repository.js";
export * from "./repositories/gpt-account-repository.js";
export * from "./repositories/operation-log-repository.js";
export * from "./repositories/sms-repository.js";
export * from "./repositories/mailbox-repository.js";
export * from "./repositories/mailbox-google-state-repository.js";
export * from "./repositories/gmail-rebind-mailbox-repository.js";
export * from "./repositories/claude-account-repository.js";
export * from "./repositories/recharge-card-repository.js";
export * from "./repositories/recharge-queue-repository.js";
export * from "./repositories/recharge-submission-repository.js";
export * from "./repositories/rebind-execution-repository.js";
export * from "./repositories/password-queue-repository.js";
export * from "./repositories/mail-job-repository.js";
export * from "./repositories/mail-job-runtime-repository.js";
export * from "./repositories/mail-job-query-repository.js";
export * from "./repositories/work-task-repository.js";
