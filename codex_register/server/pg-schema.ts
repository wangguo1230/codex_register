// @ts-nocheck
import {pool} from "./pg.js";
import {appConfig} from "../src/config.js";

export async function ensureSchema() {
    const client = await pool.connect();
    try {
        await client.query(`
            CREATE TABLE IF NOT EXISTS accounts (
                id SERIAL PRIMARY KEY,
                email TEXT UNIQUE NOT NULL,
                password TEXT NOT NULL,
                status TEXT NOT NULL DEFAULT 'pending',
                plan TEXT DEFAULT '',
                token TEXT DEFAULT '',
                auth_file TEXT DEFAULT '',
                error TEXT DEFAULT '',
                started_at BIGINT,
                finished_at BIGINT,
                created_at BIGINT NOT NULL,
                phone TEXT DEFAULT '',
                card TEXT DEFAULT '',
                at_status TEXT DEFAULT '',
                rt_status TEXT DEFAULT '',
                chat_status TEXT DEFAULT '',
                rt_file TEXT DEFAULT '',
                dead_at BIGINT DEFAULT 0,
                sold_at BIGINT DEFAULT 0,
                pw_status TEXT DEFAULT '',
                batch TEXT DEFAULT ''
            )
        `);
        await client.query(`CREATE INDEX IF NOT EXISTS idx_accounts_status ON accounts(status)`);

        await client.query(`
            CREATE TABLE IF NOT EXISTS logs (
                id SERIAL PRIMARY KEY,
                account_id INTEGER NOT NULL,
                ts BIGINT NOT NULL,
                line TEXT NOT NULL
            )
        `);
        await client.query(`CREATE INDEX IF NOT EXISTS idx_logs_account ON logs(account_id, id)`);

        await client.query(`
            CREATE TABLE IF NOT EXISTS mailbox_logs (
                id SERIAL PRIMARY KEY,
                mailbox_id INTEGER NOT NULL,
                ts BIGINT NOT NULL,
                line TEXT NOT NULL
            )
        `);
        await client.query(`CREATE INDEX IF NOT EXISTS idx_mblogs_mailbox ON mailbox_logs(mailbox_id, id)`);

        await client.query(`
            CREATE TABLE IF NOT EXISTS claude_logs (
                id SERIAL PRIMARY KEY,
                claude_id INTEGER NOT NULL,
                ts BIGINT NOT NULL,
                line TEXT NOT NULL
            )
        `);
        await client.query(`CREATE INDEX IF NOT EXISTS idx_claudelogs ON claude_logs(claude_id, id)`);

        await client.query(`
            CREATE TABLE IF NOT EXISTS sms_pool (
                id SERIAL PRIMARY KEY,
                phone TEXT UNIQUE NOT NULL,
                link TEXT NOT NULL,
                status TEXT NOT NULL DEFAULT 'free',
                bound_email TEXT DEFAULT '',
                created_at BIGINT NOT NULL,
                card TEXT DEFAULT '',
                bind_count INTEGER DEFAULT 0,
                bind_emails TEXT DEFAULT ''
            )
        `);

        await client.query(`
            CREATE TABLE IF NOT EXISTS mailboxes (
                id SERIAL PRIMARY KEY,
                email TEXT UNIQUE NOT NULL,
                password TEXT NOT NULL,
                provider TEXT NOT NULL DEFAULT 'mailcom',
                usage TEXT NOT NULL DEFAULT 'free',
                grp TEXT DEFAULT '',
                pw_status TEXT DEFAULT '',
                note TEXT DEFAULT '',
                created_at BIGINT NOT NULL
            )
        `);
        await client.query(`CREATE INDEX IF NOT EXISTS idx_mailboxes_usage ON mailboxes(usage)`);

        await client.query(`
            CREATE TABLE IF NOT EXISTS gpt_accounts (
                id SERIAL PRIMARY KEY,
                mailbox_id INTEGER NOT NULL UNIQUE REFERENCES mailboxes(id),
                status TEXT NOT NULL DEFAULT 'pending',
                token TEXT DEFAULT '',
                auth_file TEXT DEFAULT '',
                rt_file TEXT DEFAULT '',
                plan TEXT DEFAULT '',
                phone TEXT DEFAULT '',
                card TEXT DEFAULT '',
                engine TEXT DEFAULT '',
                batch TEXT DEFAULT '',
                at_status TEXT DEFAULT '',
                rt_status TEXT DEFAULT '',
                chat_status TEXT DEFAULT '',
                error TEXT DEFAULT '',
                dead_at BIGINT DEFAULT 0,
                sold_at BIGINT DEFAULT 0,
                started_at BIGINT,
                finished_at BIGINT,
                created_at BIGINT NOT NULL,
                deleted_at BIGINT DEFAULT 0,
                auth_data JSONB,
                rt_data JSONB
            )
        `);
        await client.query(`CREATE INDEX IF NOT EXISTS idx_gpt_status ON gpt_accounts(status)`);
        await client.query(`CREATE INDEX IF NOT EXISTS idx_gpt_mailbox ON gpt_accounts(mailbox_id)`);

        await client.query(`
            CREATE TABLE IF NOT EXISTS claude_accounts (
                id SERIAL PRIMARY KEY,
                mailbox_id INTEGER NOT NULL UNIQUE REFERENCES mailboxes(id),
                status TEXT NOT NULL DEFAULT 'pending',
                session_key TEXT DEFAULT '',
                org_id TEXT DEFAULT '',
                auth_file TEXT DEFAULT '',
                plan TEXT DEFAULT '',
                engine TEXT DEFAULT 'bit',
                batch TEXT DEFAULT '',
                error TEXT DEFAULT '',
                dead_at BIGINT DEFAULT 0,
                sold_at BIGINT DEFAULT 0,
                started_at BIGINT,
                finished_at BIGINT,
                created_at BIGINT NOT NULL,
                claude_code TEXT DEFAULT '',
                auth_data JSONB
            )
        `);
        await client.query(`CREATE INDEX IF NOT EXISTS idx_claude_status ON claude_accounts(status)`);

        await client.query(`
            CREATE TABLE IF NOT EXISTS recharge_cards (
                id SERIAL PRIMARY KEY,
                code TEXT UNIQUE NOT NULL,
                plan_type TEXT DEFAULT '',
                plan_name TEXT DEFAULT '',
                product TEXT DEFAULT '',
                category TEXT DEFAULT '',
                auth_mode TEXT DEFAULT '',
                status TEXT NOT NULL DEFAULT 'unused',
                account_id INTEGER DEFAULT 0,
                account_email TEXT DEFAULT '',
                task_no TEXT DEFAULT '',
                task_status TEXT DEFAULT '',
                task_message TEXT DEFAULT '',
                error TEXT DEFAULT '',
                batch TEXT DEFAULT '',
                created_at BIGINT NOT NULL,
                updated_at BIGINT NOT NULL
            )
        `);
        await client.query(`CREATE INDEX IF NOT EXISTS idx_rc_status ON recharge_cards(status)`);

        await client.query(`
            CREATE TABLE IF NOT EXISTS recharge_queue (
                id SERIAL PRIMARY KEY,
                account_id INTEGER NOT NULL UNIQUE,
                email TEXT NOT NULL,
                auth_file TEXT DEFAULT '',
                plan TEXT DEFAULT '',
                batch TEXT DEFAULT '',
                card_id INTEGER DEFAULT 0,
                card_code TEXT DEFAULT '',
                status TEXT NOT NULL DEFAULT 'pending',
                task_no TEXT DEFAULT '',
                task_status TEXT DEFAULT '',
                task_message TEXT DEFAULT '',
                error TEXT DEFAULT '',
                created_at BIGINT NOT NULL,
                plan_type TEXT DEFAULT '',
                auth_data JSONB
            )
        `);

        // 兼容已有表：追加 JSONB 列（IF NOT EXISTS 避免重复）
        await client.query(`ALTER TABLE gpt_accounts ADD COLUMN IF NOT EXISTS auth_data JSONB`);
        await client.query(`ALTER TABLE gpt_accounts ADD COLUMN IF NOT EXISTS rt_data JSONB`);
        await client.query(`ALTER TABLE claude_accounts ADD COLUMN IF NOT EXISTS auth_data JSONB`);
        await client.query(`ALTER TABLE recharge_queue ADD COLUMN IF NOT EXISTS auth_data JSONB`);

        // 多实例并行：记录任务归属的实例 ID
        await client.query(`ALTER TABLE gpt_accounts ADD COLUMN IF NOT EXISTS instance_id TEXT DEFAULT ''`);
        await client.query(`ALTER TABLE claude_accounts ADD COLUMN IF NOT EXISTS instance_id TEXT DEFAULT ''`);
        await client.query(`ALTER TABLE sms_pool ADD COLUMN IF NOT EXISTS claimed_by TEXT DEFAULT ''`);

        // 邮箱软删除
        await client.query(`ALTER TABLE mailboxes ADD COLUMN IF NOT EXISTS deleted_at BIGINT DEFAULT 0`);
        // GPT 账号软删除:删号只打标记,记录/日志保留,可按邮箱回查
        await client.query(`ALTER TABLE gpt_accounts ADD COLUMN IF NOT EXISTS deleted_at BIGINT DEFAULT 0`);
        // Gmail 老号:辅助邮箱 + Google 自身 TOTP(收 ChatGPT 码/改密/换 2FA 用)
        await client.query(`ALTER TABLE mailboxes ADD COLUMN IF NOT EXISTS recovery_email TEXT DEFAULT ''`);
        await client.query(`ALTER TABLE mailboxes ADD COLUMN IF NOT EXISTS totp_secret TEXT DEFAULT ''`);
        await client.query(`ALTER TABLE mailboxes ADD COLUMN IF NOT EXISTS imap_password TEXT DEFAULT ''`);
        await client.query(`ALTER TABLE mailboxes ADD COLUMN IF NOT EXISTS google_state JSONB DEFAULT '{}'::jsonb`);
        await client.query(`ALTER TABLE mailboxes ADD COLUMN IF NOT EXISTS google_stage TEXT DEFAULT ''`);
        await client.query(`ALTER TABLE mailboxes ADD COLUMN IF NOT EXISTS sold_at BIGINT DEFAULT 0`);
        await client.query(`ALTER TABLE mailboxes ADD COLUMN IF NOT EXISTS password_prev TEXT DEFAULT ''`);
        await client.query(`CREATE INDEX IF NOT EXISTS idx_mailboxes_google_stage ON mailboxes(google_stage)`);
        await client.query(`ALTER TABLE mailboxes ADD COLUMN IF NOT EXISTS proxy_url TEXT DEFAULT ''`);
        await client.query(`ALTER TABLE mailboxes ADD COLUMN IF NOT EXISTS proxy_ip TEXT DEFAULT ''`);

        // 充值提交时间 + 多实例认领(谁点的谁跑)
        await client.query(`ALTER TABLE recharge_queue ADD COLUMN IF NOT EXISTS submitted_at BIGINT DEFAULT 0`);
        await client.query(`ALTER TABLE recharge_queue ADD COLUMN IF NOT EXISTS finished_at BIGINT DEFAULT 0`);
        await client.query(`ALTER TABLE recharge_queue ADD COLUMN IF NOT EXISTS instance_id TEXT DEFAULT ''`);
        await client.query(`ALTER TABLE recharge_queue ADD COLUMN IF NOT EXISTS rebind_status TEXT DEFAULT ''`);
        await client.query(`ALTER TABLE recharge_queue ADD COLUMN IF NOT EXISTS rebind_email TEXT DEFAULT ''`);
        await client.query(`ALTER TABLE recharge_queue ADD COLUMN IF NOT EXISTS rebind_error TEXT DEFAULT ''`);
        await client.query(`ALTER TABLE recharge_queue ADD COLUMN IF NOT EXISTS rebind_target TEXT DEFAULT ''`);
        await client.query(`ALTER TABLE recharge_queue ADD COLUMN IF NOT EXISTS rebind_pool JSONB`);
        // 交付：未交付=充值作业中；移除→已交付（保留记录与换绑关系，不删号）
        await client.query(`ALTER TABLE recharge_queue ADD COLUMN IF NOT EXISTS delivery_status TEXT DEFAULT 'undelivered'`);
        await client.query(`ALTER TABLE recharge_queue ADD COLUMN IF NOT EXISTS delivered_at BIGINT DEFAULT 0`);
        // 换绑前邮箱（首次换绑写入后保留，便于看 原→新）
        await client.query(`ALTER TABLE recharge_queue ADD COLUMN IF NOT EXISTS rebind_from TEXT DEFAULT ''`);
        await client.query(`CREATE INDEX IF NOT EXISTS idx_recharge_queue_delivery ON recharge_queue(delivery_status)`);

        // ChatGPT 登录凭证(与邮箱密码分离):每号独立密码 + TOTP
        await client.query(`ALTER TABLE gpt_accounts ADD COLUMN IF NOT EXISTS gpt_password TEXT DEFAULT ''`);
        await client.query(`ALTER TABLE gpt_accounts ADD COLUMN IF NOT EXISTS totp_secret TEXT DEFAULT ''`);
        await client.query(`ALTER TABLE gpt_accounts ADD COLUMN IF NOT EXISTS mfa_status TEXT DEFAULT ''`);

        // 已碰过的旧号空密码回填默认密码(未启动过的 pending 仍留给 spawn 生成随机密码)
        const defaultPw = String(appConfig.defaultPassword || "").trim();
        if (defaultPw) {
            await client.query(
                `UPDATE gpt_accounts SET gpt_password=$1
                 WHERE COALESCE(gpt_password,'')=''
                   AND (COALESCE(auth_file,'')<>'' OR COALESCE(token,'')<>'' OR COALESCE(error,'')<>'' OR started_at IS NOT NULL)`,
                [defaultPw]
            );
        }

        // 改密队列(多实例 FOR UPDATE SKIP LOCKED)
        await client.query(`
            CREATE TABLE IF NOT EXISTS pw_queue (
                id SERIAL PRIMARY KEY,
                mailbox_id INTEGER NOT NULL,
                email TEXT NOT NULL,
                old_pw TEXT NOT NULL,
                new_pw TEXT DEFAULT '',
                status TEXT NOT NULL DEFAULT 'pending',
                instance_id TEXT DEFAULT '',
                detail TEXT DEFAULT '',
                created_at BIGINT NOT NULL
            )
        `);

        // 邮箱任务共享队列：各实例用本机代理认领，任务本身跨机
        await client.query(`
            CREATE TABLE IF NOT EXISTS mail_jobs (
                id SERIAL PRIMARY KEY,
                kind TEXT NOT NULL DEFAULT 'harden',
                mailbox_id INTEGER NOT NULL,
                email TEXT NOT NULL DEFAULT '',
                batch_id TEXT NOT NULL DEFAULT '',
                status TEXT NOT NULL DEFAULT 'pending',
                instance_id TEXT DEFAULT '',
                last_line TEXT DEFAULT '',
                error TEXT DEFAULT '',
                ok BOOLEAN DEFAULT FALSE,
                result JSONB,
                created_at BIGINT NOT NULL,
                claimed_at BIGINT DEFAULT 0,
                heartbeat_at BIGINT DEFAULT 0,
                finished_at BIGINT DEFAULT 0
            )
        `);
        await client.query(`ALTER TABLE mail_jobs ADD COLUMN IF NOT EXISTS payload JSONB`);
        await client.query(`CREATE INDEX IF NOT EXISTS idx_mail_jobs_status ON mail_jobs(status, kind)`);
        await client.query(`CREATE INDEX IF NOT EXISTS idx_mail_jobs_batch ON mail_jobs(batch_id)`);
        await client.query(`
            CREATE UNIQUE INDEX IF NOT EXISTS idx_mail_jobs_active
            ON mail_jobs(kind, mailbox_id)
            WHERE status IN ('pending', 'running')
        `);
        await client.query(`
            CREATE TABLE IF NOT EXISTS mail_control (
                id INTEGER PRIMARY KEY DEFAULT 1,
                claim_paused BOOLEAN NOT NULL DEFAULT FALSE,
                updated_at BIGINT DEFAULT 0
            )
        `);
        await client.query(`INSERT INTO mail_control(id, claim_paused, updated_at) VALUES(1, FALSE, 0) ON CONFLICT (id) DO NOTHING`);
        await client.query(`
            CREATE TABLE IF NOT EXISTS mail_instances (
                instance_id TEXT PRIMARY KEY,
                stop_claim BOOLEAN NOT NULL DEFAULT FALSE,
                proxy_slots INTEGER DEFAULT 0,
                proxy_leased INTEGER DEFAULT 0,
                running_jobs INTEGER DEFAULT 0,
                last_seen BIGINT NOT NULL DEFAULT 0
            )
        `);

        console.log("[pg] Schema 已就绪");
    } finally {
        client.release();
    }
}
