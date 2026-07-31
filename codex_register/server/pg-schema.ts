// @ts-nocheck
import {pool} from "./pg.js";

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
                created_at BIGINT NOT NULL
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
                claude_code TEXT DEFAULT ''
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
                plan_type TEXT DEFAULT ''
            )
        `);

        console.log("[pg] Schema 已就绪");
    } finally {
        client.release();
    }
}
