// @ts-nocheck
import {PG_QUERY_TIMEOUT_MS, PG_STATEMENT_TIMEOUT_MS, pool} from "./pg.js";
import {appConfig} from "../src/config.js";

const SCHEMA_LOCK_NAME = "codex-register:schema";
const SCHEMA_LOCK_TIMEOUT_MS = 5_000;

export function schemaStatementLabel(sql) {
    const normalized = String(sql || "").replace(/\s+/g, " ").trim();
    const match = normalized.match(/^(CREATE TABLE(?: IF NOT EXISTS)?\s+\S+|CREATE (?:UNIQUE )?INDEX(?: IF NOT EXISTS)?\s+\S+|ALTER TABLE\s+\S+\s+ADD COLUMN(?: IF NOT EXISTS)?\s+\S+|UPDATE\s+\S+|DELETE FROM\s+\S+|DROP INDEX(?: IF EXISTS)?\s+\S+|INSERT INTO\s+\S+)/i);
    return (match?.[1] || normalized.slice(0, 100) || "SQL").replace(/[;(]+$/, "");
}

export async function ensureSchemaWithPool(databasePool, {
    logger = console,
    lockTimeoutMs = SCHEMA_LOCK_TIMEOUT_MS,
    statementTimeoutMs = PG_STATEMENT_TIMEOUT_MS,
    queryTimeoutMs = PG_QUERY_TIMEOUT_MS,
} = {}) {
    const dbClient = await databasePool.connect();
    let acquired = false;
    let step = 0;
    try {
        await dbClient.query(`SELECT set_config('lock_timeout', $1, false)`, [`${lockTimeoutMs}ms`]);
        await dbClient.query(`SELECT set_config('statement_timeout', $1, false)`, [`${statementTimeoutMs}ms`]);
        const {rows: [lock]} = await dbClient.query(
            `SELECT pg_try_advisory_lock(hashtext($1)::bigint) AS acquired`,
            [SCHEMA_LOCK_NAME],
        );
        acquired = lock?.acquired === true;
        if (!acquired) {
            const error = new Error("另一个实例正在执行 Schema 迁移");
            error.code = "SCHEMA_MIGRATION_BUSY";
            throw error;
        }

        const client = {
            async query(queryOrConfig, values) {
                const text = typeof queryOrConfig === "string" ? queryOrConfig : queryOrConfig?.text;
                const label = schemaStatementLabel(text);
                const currentStep = ++step;
                const startedAt = Date.now();
                logger.log(`[pg] Schema [${currentStep}] ${label}`);
                try {
                    const config = typeof queryOrConfig === "string"
                        ? {text: queryOrConfig, values, query_timeout: queryTimeoutMs}
                        : {...queryOrConfig, query_timeout: queryOrConfig?.query_timeout || queryTimeoutMs};
                    return await dbClient.query(config);
                } catch (error) {
                    throw new Error(`Schema [${currentStep}] ${label} 失败: ${error?.message || error}`, {cause: error});
                } finally {
                    const elapsed = Date.now() - startedAt;
                    if (elapsed >= 1_000) logger.warn(`[pg] Schema [${currentStep}] ${label} 耗时 ${elapsed}ms`);
                }
            },
        };

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
        const accountLogLimit = Math.max(100, Math.min(10_000, Number(process.env.ACCOUNT_LOG_MAX_ENTRIES || 5_000) || 5_000));
        await client.query(
            `DELETE FROM logs WHERE id IN (
                SELECT id FROM (
                    SELECT id, ROW_NUMBER() OVER (PARTITION BY account_id ORDER BY id DESC) AS row_no
                    FROM logs
                ) ranked
                WHERE row_no > $1
            )`,
            [accountLogLimit],
        );

        await client.query(`
            CREATE TABLE IF NOT EXISTS operation_logs (
                id BIGSERIAL PRIMARY KEY,
                ts BIGINT NOT NULL,
                instance_id TEXT NOT NULL DEFAULT '',
                scope TEXT NOT NULL DEFAULT 'recharge',
                account_id INTEGER,
                line TEXT NOT NULL
            )
        `);
        await client.query(`CREATE INDEX IF NOT EXISTS idx_operation_logs_scope ON operation_logs(scope, id DESC)`);
        await client.query(`CREATE INDEX IF NOT EXISTS idx_operation_logs_account ON operation_logs(account_id, id DESC)`);
        const operationLogLimit = Math.max(5_000, Math.min(100_000, Number(process.env.OPERATION_LOG_MAX_ENTRIES || 50_000) || 50_000));
        await client.query(
            `DELETE FROM operation_logs WHERE id IN (
                SELECT id FROM (
                    SELECT id, ROW_NUMBER() OVER (PARTITION BY scope ORDER BY id DESC) AS row_no
                    FROM operation_logs
                ) ranked
                WHERE row_no > $1
            )`,
            [operationLogLimit],
        );

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
        // 导入时的卖家 2FA：换密钥只改 totp_secret，这份永远不覆盖
        await client.query(`ALTER TABLE mailboxes ADD COLUMN IF NOT EXISTS totp_secret_orig TEXT DEFAULT ''`);
        await client.query(`ALTER TABLE mailboxes ADD COLUMN IF NOT EXISTS job_lock_instance TEXT DEFAULT ''`);
        await client.query(`ALTER TABLE mailboxes ADD COLUMN IF NOT EXISTS job_lock_at BIGINT DEFAULT 0`);
        await client.query(`ALTER TABLE mailboxes ADD COLUMN IF NOT EXISTS imap_password TEXT DEFAULT ''`);
        await client.query(`ALTER TABLE mailboxes ADD COLUMN IF NOT EXISTS google_state JSONB DEFAULT '{}'::jsonb`);
        await client.query(`
            UPDATE mailboxes
            SET totp_secret_orig = totp_secret
            WHERE COALESCE(totp_secret_orig,'')=''
              AND COALESCE(totp_secret,'')<>''
              AND COALESCE(google_state->>'totp_rotated','') <> 'true'
        `);
        await client.query(`ALTER TABLE mailboxes ADD COLUMN IF NOT EXISTS google_stage TEXT DEFAULT ''`);
        await client.query(`ALTER TABLE mailboxes ADD COLUMN IF NOT EXISTS sold_at BIGINT DEFAULT 0`);
        await client.query(`ALTER TABLE mailboxes ADD COLUMN IF NOT EXISTS password_prev TEXT DEFAULT ''`);
        await client.query(`CREATE INDEX IF NOT EXISTS idx_mailboxes_google_stage ON mailboxes(google_stage)`);
        await client.query(`ALTER TABLE mailboxes ADD COLUMN IF NOT EXISTS proxy_url TEXT DEFAULT ''`);
        await client.query(`ALTER TABLE mailboxes ADD COLUMN IF NOT EXISTS proxy_ip TEXT DEFAULT ''`);
        await client.query(`ALTER TABLE mailboxes ADD COLUMN IF NOT EXISTS proxy_fail INTEGER DEFAULT 0`);
        await client.query(`ALTER TABLE mailboxes ADD COLUMN IF NOT EXISTS browser_fp JSONB DEFAULT '{}'::jsonb`);
        await client.query(`ALTER TABLE mailboxes ADD COLUMN IF NOT EXISTS claimed_at BIGINT DEFAULT 0`);
        // 上次被当作换绑目标试过的时间。候选按它升序排，失败放回池的号排到最后，
        // 否则 ORDER BY id DESC 会让同一个号被每个账号反复探活（探活要开比特窗口，很贵）。
        await client.query(`ALTER TABLE mailboxes ADD COLUMN IF NOT EXISTS rebind_tried_at BIGINT DEFAULT 0`);

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

        // 换绑意图：打官方 verify 之前先落盘。verify 之后失联时，靠这几列去官方对账，
        // 判断"平台到底改没改"，避免库里还是旧邮箱、目标邮箱又被放回池给下一个号。
        await client.query(`ALTER TABLE recharge_queue ADD COLUMN IF NOT EXISTS rebind_attempt_email TEXT DEFAULT ''`);
        await client.query(`ALTER TABLE recharge_queue ADD COLUMN IF NOT EXISTS rebind_attempt_mailbox_id INTEGER DEFAULT 0`);
        await client.query(`ALTER TABLE recharge_queue ADD COLUMN IF NOT EXISTS rebind_attempt_at BIGINT DEFAULT 0`);
        await client.query(`ALTER TABLE recharge_queue ADD COLUMN IF NOT EXISTS rebind_attempt_stage TEXT DEFAULT ''`);
        // 多实例：对账任务按行认领，避免两个实例同时给一个号收敛
        await client.query(`ALTER TABLE recharge_queue ADD COLUMN IF NOT EXISTS rebind_instance TEXT DEFAULT ''`);
        await client.query(`CREATE INDEX IF NOT EXISTS idx_recharge_queue_rebind_status ON recharge_queue(rebind_status)`);
        // 官方 24h 换绑次数上限：限的是这个 ChatGPT 号，换目标/换出口都没用，只能等。
        // 记下解禁时间，拦住"反复点换绑"——每点一次都要探活+begin，白烧目标号和限流额度。
        await client.query(`ALTER TABLE recharge_queue ADD COLUMN IF NOT EXISTS rebind_blocked_until BIGINT DEFAULT 0`);
        // 充值提交、人工卡密处理与换绑对账的高频过滤条件。
        await client.query(`CREATE INDEX IF NOT EXISTS idx_recharge_queue_card ON recharge_queue(card_id)`);
        // 统一跨实例任务控制面。业务表保存最终状态，本表只保存调度、租约和 fencing token。
        await client.query(`
            CREATE TABLE IF NOT EXISTS work_tasks (
                id BIGSERIAL PRIMARY KEY,
                kind TEXT NOT NULL,
                entity_id BIGINT NOT NULL,
                status TEXT NOT NULL DEFAULT 'pending',
                payload JSONB NOT NULL DEFAULT '{}'::jsonb,
                priority INTEGER NOT NULL DEFAULT 0,
                available_at BIGINT NOT NULL DEFAULT 0,
                attempts INTEGER NOT NULL DEFAULT 0,
                lease_owner TEXT NOT NULL DEFAULT '',
                lease_token TEXT NOT NULL DEFAULT '',
                lease_until BIGINT NOT NULL DEFAULT 0,
                heartbeat_at BIGINT NOT NULL DEFAULT 0,
                started_at BIGINT NOT NULL DEFAULT 0,
                finished_at BIGINT NOT NULL DEFAULT 0,
                last_error TEXT NOT NULL DEFAULT '',
                result JSONB NOT NULL DEFAULT '{}'::jsonb,
                created_at BIGINT NOT NULL,
                updated_at BIGINT NOT NULL
            )
        `);
        await client.query(`CREATE INDEX IF NOT EXISTS idx_work_tasks_claim ON work_tasks(kind, status, available_at, priority DESC, id)`);
        await client.query(`CREATE INDEX IF NOT EXISTS idx_work_tasks_owner ON work_tasks(lease_owner, status)`);
        await client.query(`DROP INDEX IF EXISTS idx_work_tasks_active`);
        await client.query(`
            CREATE UNIQUE INDEX IF NOT EXISTS idx_work_tasks_active_entity
            ON work_tasks(kind, entity_id)
            WHERE status IN ('pending','running')
        `);
        await client.query(`
            CREATE INDEX IF NOT EXISTS idx_recharge_queue_active_submission
            ON recharge_queue(id)
            WHERE status IN ('submitting','submitted')
              AND COALESCE(delivery_status,'undelivered') <> 'delivered'
        `);
        await client.query(`
            CREATE INDEX IF NOT EXISTS idx_recharge_queue_rebind_reconcile
            ON recharge_queue(rebind_attempt_at, id)
            WHERE rebind_status='unknown' AND COALESCE(rebind_instance,'')=''
        `);
        // 公共代理池：配置和租约均落 PostgreSQL，多个 HTTP 实例通过同一租约表互斥。
        await client.query(`
            CREATE TABLE IF NOT EXISTS proxy_pool_config (
                id INTEGER PRIMARY KEY DEFAULT 1,
                initialized BOOLEAN NOT NULL DEFAULT FALSE,
                exit_mail_enabled BOOLEAN NOT NULL DEFAULT TRUE,
                exit_gpt_enabled BOOLEAN NOT NULL DEFAULT TRUE,
                jump_mail_enabled BOOLEAN NOT NULL DEFAULT TRUE,
                jump_gpt_enabled BOOLEAN NOT NULL DEFAULT TRUE,
                updated_at BIGINT NOT NULL DEFAULT 0,
                CHECK (id = 1)
            )
        `);
        await client.query(`
            CREATE TABLE IF NOT EXISTS proxy_pool_entries (
                id BIGSERIAL PRIMARY KEY,
                kind TEXT NOT NULL,
                resource_key TEXT NOT NULL,
                url TEXT NOT NULL,
                template_key TEXT NOT NULL DEFAULT '',
                active BOOLEAN NOT NULL DEFAULT TRUE,
                health_ok BOOLEAN,
                health_at BIGINT NOT NULL DEFAULT 0,
                health_ms INTEGER NOT NULL DEFAULT 0,
                health_ip TEXT NOT NULL DEFAULT '',
                health_google INTEGER NOT NULL DEFAULT 0,
                health_reason TEXT NOT NULL DEFAULT '',
                last_used_at BIGINT NOT NULL DEFAULT 0,
                created_at BIGINT NOT NULL,
                updated_at BIGINT NOT NULL,
                UNIQUE(kind, resource_key)
            )
        `);
        await client.query(`CREATE INDEX IF NOT EXISTS idx_proxy_pool_entries_active ON proxy_pool_entries(kind, active, id)`);
        await client.query(`
            CREATE TABLE IF NOT EXISTS proxy_pool_leases (
                id BIGSERIAL PRIMARY KEY,
                kind TEXT NOT NULL,
                resource_key TEXT NOT NULL,
                template_key TEXT NOT NULL DEFAULT '',
                lease_key TEXT NOT NULL,
                lease_url TEXT NOT NULL DEFAULT '',
                owner TEXT NOT NULL DEFAULT '',
                lease_token TEXT NOT NULL UNIQUE,
                lease_until BIGINT NOT NULL,
                heartbeat_at BIGINT NOT NULL,
                created_at BIGINT NOT NULL,
                UNIQUE(kind, resource_key, lease_key)
            )
        `);
        await client.query(`ALTER TABLE proxy_pool_leases ADD COLUMN IF NOT EXISTS template_key TEXT NOT NULL DEFAULT ''`);
        await client.query(`CREATE INDEX IF NOT EXISTS idx_proxy_pool_leases_active ON proxy_pool_leases(kind, resource_key, lease_until)`);
        await client.query(`CREATE INDEX IF NOT EXISTS idx_proxy_pool_leases_template ON proxy_pool_leases(kind, template_key, lease_until)`);
        await client.query(`CREATE INDEX IF NOT EXISTS idx_proxy_pool_leases_expire ON proxy_pool_leases(lease_until)`);
        await client.query(`
            CREATE TABLE IF NOT EXISTS proxy_exit_ip_usage (
                ip TEXT PRIMARY KEY,
                owner TEXT NOT NULL DEFAULT '',
                used_until BIGINT NOT NULL,
                updated_at BIGINT NOT NULL
            )
        `);
        await client.query(`CREATE INDEX IF NOT EXISTS idx_proxy_exit_ip_usage_until ON proxy_exit_ip_usage(used_until)`);
        // 发信：每次使用的粘性代理 session（一号一出口，日志可回放）
        await client.query(`
            CREATE TABLE IF NOT EXISTS mail_send_logs (
                id SERIAL PRIMARY KEY,
                mailbox_id INTEGER DEFAULT 0,
                email TEXT NOT NULL,
                to_email TEXT NOT NULL DEFAULT '',
                subject TEXT DEFAULT '',
                status TEXT NOT NULL DEFAULT 'pending',
                http_status INTEGER DEFAULT 0,
                location TEXT DEFAULT '',
                error TEXT DEFAULT '',
                proxy_url TEXT DEFAULT '',
                proxy_session TEXT DEFAULT '',
                proxy_ip TEXT DEFAULT '',
                jump_url TEXT DEFAULT '',
                reused INTEGER DEFAULT 0,
                created_at BIGINT NOT NULL
            )
        `);
        await client.query(`CREATE INDEX IF NOT EXISTS idx_mail_send_logs_email ON mail_send_logs(email, id DESC)`);
        await client.query(`CREATE INDEX IF NOT EXISTS idx_mail_send_logs_created ON mail_send_logs(created_at DESC)`);

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
            DELETE FROM mail_jobs a USING mail_jobs b
            WHERE a.status IN ('pending', 'running')
              AND b.status IN ('pending', 'running')
              AND a.mailbox_id = b.mailbox_id
              AND a.id > b.id
        `);
        await client.query(`DROP INDEX IF EXISTS idx_mail_jobs_active`);
        await client.query(`
            CREATE UNIQUE INDEX IF NOT EXISTS idx_mail_jobs_active_mailbox
            ON mail_jobs(mailbox_id)
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

        logger.log(`[pg] Schema 已就绪，共 ${step} 条`);
    } finally {
        if (acquired) {
            try {
                await dbClient.query(`SELECT pg_advisory_unlock(hashtext($1)::bigint)`, [SCHEMA_LOCK_NAME]);
            } catch { /* 连接释放后 PostgreSQL 会自动释放会话锁 */ }
        }
        dbClient.release();
    }
}

export async function ensureSchema() {
    return ensureSchemaWithPool(pool);
}
