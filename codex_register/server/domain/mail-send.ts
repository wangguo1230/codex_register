// @ts-nocheck
// 发信兼容门面。实现按 Worker、mail.com 发送、批处理和交付测试职责拆分。
export {sendMailcomViaPool} from "./mailcom-send-service.js";
export {sendMailboxViaProvider} from "./mailbox-send-service.js";
export {sendMailcomBatch, listMailSendLogsPublic} from "./mail-send-batch-service.js";
export {refundSenderOf, buildTestMailContent} from "./mail-send-policy.js";
export {previewDeliveredSend, testSendDelivered} from "./delivered-mail-service.js";
export {getDeliveredSendJob, stopDeliveredSend, startTestSendDelivered} from "./delivered-mail-job.js";
