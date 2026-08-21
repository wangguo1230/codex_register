// @ts-nocheck
// 公共代理池仓储：配置是数据库事实源，租约用事务和 fencing token 跨实例协调。
import {randomUUID} from "node:crypto";
import {instanceId, query, withTransaction} from "./database-context.js";
import {proxyTemplateKey} from "../../src/mail/proxy-pool.js";

const CONFIG_ID = 1;
const ACTIVE_LEASE = "lease.lease_until > $3";

function kindOf(value) {
    const kind = String(value || "").trim();
    if (kind !== "exit" && kind !== "jump") throw new Error("代理池资源类型无效");
    return kind;
}

function scopeColumn(kind, scope) {
    const normalizedKind = kindOf(kind);
    const normalizedScope = scope === "gpt" ? "gpt" : "mail";
    return `${normalizedKind}_${normalizedScope}_enabled`;
}

function unique(values) {
    return [...new Set((values || []).map((value) => String(value || "").trim()).filter(Boolean))];
}

function configValues(config = {}) {
    return {
        exitMailEnabled: config.exitMailEnabled !== false,
        exitGptEnabled: config.exitGptEnabled !== false,
        jumpMailEnabled: config.jumpMailEnabled !== false,
        jumpGptEnabled: config.jumpGptEnabled !== false,
    };
}

export function createProxyPoolRepository({
    queryFn = query,
    transactionFn = withTransaction,
    instance = instanceId,
    clock = Date,
} = {}) {
    async function ensureConfig(client) {
        await client.query(
            `INSERT INTO proxy_pool_config(id, initialized, updated_at)
             VALUES($1, FALSE, $2)
             ON CONFLICT (id) DO NOTHING`,
            [CONFIG_ID, clock.now()],
        );
    }

    async function loadConfiguration() {
        const {rows: configRows} = await queryFn(`SELECT * FROM proxy_pool_config WHERE id=$1`, [CONFIG_ID]);
        const config = configRows[0] || {};
        const {rows: entries} = await queryFn(
            `SELECT kind, resource_key, url, template_key
             FROM proxy_pool_entries WHERE active=TRUE ORDER BY kind, id`,
        );
        return {
            initialized: config.initialized === true,
            exitUrls: entries.filter((row) => row.kind === "exit").map((row) => row.url),
            jumpUrls: entries.filter((row) => row.kind === "jump").map((row) => row.url),
            exitMailEnabled: config.exit_mail_enabled !== false,
            exitGptEnabled: config.exit_gpt_enabled !== false,
            jumpMailEnabled: config.jump_mail_enabled !== false,
            jumpGptEnabled: config.jump_gpt_enabled !== false,
        };
    }

    async function saveConfiguration({exitUrls = [], jumpUrls = [], ...scopeValues} = {}) {
        const scopes = configValues(scopeValues);
        const exit = unique(exitUrls);
        const jump = unique(jumpUrls);
        await transactionFn(async (client) => {
            const now = clock.now();
            await ensureConfig(client);
            await client.query(
                `UPDATE proxy_pool_config
                 SET initialized=TRUE, exit_mail_enabled=$1, exit_gpt_enabled=$2,
                     jump_mail_enabled=$3, jump_gpt_enabled=$4, updated_at=$5
                 WHERE id=$6`,
                [scopes.exitMailEnabled, scopes.exitGptEnabled, scopes.jumpMailEnabled, scopes.jumpGptEnabled, now, CONFIG_ID],
            );
            for (const [kind, urls] of [["exit", exit], ["jump", jump]]) {
                for (const url of urls) {
                    await client.query(
                        `INSERT INTO proxy_pool_entries(kind, resource_key, url, template_key, active, created_at, updated_at)
                         VALUES($1, $2, $3, $4, TRUE, $5, $5)
                         ON CONFLICT(kind, resource_key) DO UPDATE SET
                             url=EXCLUDED.url, template_key=EXCLUDED.template_key,
                             active=TRUE, updated_at=EXCLUDED.updated_at`,
                        [kind, url, url, proxyTemplateKey(url), now],
                    );
                }
                await client.query(
                    `UPDATE proxy_pool_entries SET active=FALSE, updated_at=$1
                     WHERE kind=$2 AND active=TRUE AND NOT (resource_key = ANY($3::text[]))`,
                    [now, kind, urls],
                );
            }
        });
        return loadConfiguration();
    }

    async function acquire({kind, scope = "mail", owner = "", candidates = [], maxPerTemplate = 1, leaseMs = 600_000, signal} = {}) {
        const normalizedKind = kindOf(kind);
        const cap = Math.max(1, Number(maxPerTemplate) || 1);
        const ttl = Math.max(30_000, Number(leaseMs) || 600_000);
        if (!candidates.length) return null;
        if (signal?.aborted) throw signal.reason || new Error("任务已取消");
        return transactionFn(async (client) => {
            const now = clock.now();
            await client.query(`DELETE FROM proxy_pool_leases WHERE lease_until <= $1`, [now]);
            await ensureConfig(client);
            const column = scopeColumn(normalizedKind, scope);
            const {rows: enabledRows} = await client.query(`SELECT ${column} AS enabled FROM proxy_pool_config WHERE id=$1`, [CONFIG_ID]);
            if (enabledRows[0]?.enabled === false) return null;
            for (const candidate of candidates) {
                if (signal?.aborted) throw signal.reason || new Error("任务已取消");
                const resourceKey = String(candidate.resourceKey || candidate.baseUrl || "").trim();
                if (!resourceKey) continue;
                const {rows: entries} = await client.query(
                    `SELECT resource_key, url, template_key
                     FROM proxy_pool_entries
                     WHERE kind=$1 AND resource_key=$2 AND active=TRUE
                     FOR UPDATE SKIP LOCKED`,
                    [normalizedKind, resourceKey],
                );
                const entry = entries[0];
                if (!entry) continue;
                const template = String(entry.template_key || candidate.templateKey || resourceKey);
                const leaseKey = String(candidate.leaseKey || resourceKey);
                const {rows: sameLease} = await client.query(
                    `SELECT 1 FROM proxy_pool_leases
                     WHERE kind=$1 AND resource_key=$2 AND lease_key=$3 AND lease_until > $4
                     LIMIT 1`,
                    [normalizedKind, resourceKey, leaseKey, now],
                );
                if (sameLease.length) continue;
                await client.query(`SELECT pg_advisory_xact_lock(hashtext($1)::bigint)`, [`codex:proxy:${normalizedKind}:${template}`]);
                const {rows: countRows} = await client.query(
                    `SELECT COUNT(*)::int AS count
                     FROM proxy_pool_leases lease
                     WHERE lease.kind=$1 AND lease.template_key=$2 AND ${ACTIVE_LEASE}`,
                    [normalizedKind, template, now],
                );
                if (Number(countRows[0]?.count || 0) >= cap) continue;
                const token = randomUUID();
                await client.query(
                    `INSERT INTO proxy_pool_leases(
                        kind, resource_key, template_key, lease_key, lease_url, owner, lease_token,
                        lease_until, heartbeat_at, created_at
                     ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$9)`,
                    [normalizedKind, resourceKey, template, leaseKey, String(candidate.liveUrl || entry.url || ""), `${String(instance)}:${String(owner || "")}`, token, now + ttl, now],
                );
                await client.query(
                    `UPDATE proxy_pool_entries SET last_used_at=$1, updated_at=$1 WHERE kind=$2 AND resource_key=$3`,
                    [now, normalizedKind, resourceKey],
                );
                return {
                    leaseToken: token,
                    url: String(candidate.liveUrl || entry.url || ""),
                    resourceKey,
                    leaseKey,
                };
            }
            return null;
        });
    }

    async function release({kind, leaseToken} = {}) {
        const normalizedKind = kindOf(kind);
        const {rowCount} = await queryFn(
            `DELETE FROM proxy_pool_leases WHERE kind=$1 AND lease_token=$2`,
            [normalizedKind, String(leaseToken || "")],
        );
        return (rowCount || 0) > 0;
    }

    async function releaseByInstance(ownerInstance = instance) {
        const prefix = `${String(ownerInstance || "").trim()}:`;
        if (prefix === ":") return 0;
        const {rowCount} = await queryFn(
            `DELETE FROM proxy_pool_leases WHERE owner LIKE $1`,
            [`${prefix}%`],
        );
        return rowCount || 0;
    }

    async function renew({kind, leaseToken, leaseMs = 600_000} = {}) {
        const normalizedKind = kindOf(kind);
        const now = clock.now();
        const ttl = Math.max(30_000, Number(leaseMs) || 600_000);
        const {rowCount} = await queryFn(
            `UPDATE proxy_pool_leases
             SET lease_until=$1, heartbeat_at=$2
             WHERE kind=$3 AND lease_token=$4 AND lease_until > $2`,
            [now + ttl, now, normalizedKind, String(leaseToken || "")],
        );
        return (rowCount || 0) > 0;
    }

    async function snapshot({kind, scope = null} = {}) {
        const normalizedKind = kindOf(kind);
        const now = clock.now();
        if (scope) {
            const column = scopeColumn(normalizedKind, scope);
            const {rows: enabledRows} = await queryFn(`SELECT ${column} AS enabled FROM proxy_pool_config WHERE id=$1`, [CONFIG_ID]);
            if (enabledRows[0]?.enabled === false) return {total: 0, leased: 0, items: []};
        }
        const {rows} = await queryFn(
            `SELECT item.resource_key, item.url,
                    COUNT(lease.id)::int AS leased,
                    COALESCE(array_agg(lease.owner) FILTER (WHERE lease.id IS NOT NULL), ARRAY[]::text[]) AS owners
             FROM proxy_pool_entries item
             LEFT JOIN proxy_pool_leases lease
               ON lease.kind=item.kind AND lease.resource_key=item.resource_key AND lease.lease_until > $2
             WHERE item.kind=$1 AND item.active=TRUE
             GROUP BY item.id, item.resource_key, item.url
             ORDER BY item.id`,
            [normalizedKind, now],
        );
        const items = rows.map((row) => ({
            resourceKey: row.resource_key,
            url: row.url,
            leased: Number(row.leased || 0),
            owners: (row.owners || []).map((owner) => String(owner).replace(`${String(instance)}:`, "")),
        }));
        return {
            total: items.length,
            leased: items.reduce((sum, item) => sum + item.leased, 0),
            items,
        };
    }

    async function reserveExitIp({ip = "", owner = "", cooldownMs = 24 * 60 * 60 * 1000} = {}) {
        const value = String(ip || "").trim();
        if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(value)) return true;
        const now = clock.now();
        const until = now + Math.max(30_000, Number(cooldownMs) || 24 * 60 * 60 * 1000);
        return transactionFn(async (client) => {
            await client.query(`SELECT pg_advisory_xact_lock(hashtext($1)::bigint)`, [`codex:proxy-exit-ip:${value}`]);
            await client.query(`DELETE FROM proxy_exit_ip_usage WHERE used_until <= $1`, [now]);
            const {rows} = await client.query(`SELECT used_until FROM proxy_exit_ip_usage WHERE ip=$1 FOR UPDATE`, [value]);
            if (rows[0] && Number(rows[0].used_until || 0) > now) return false;
            await client.query(
                `INSERT INTO proxy_exit_ip_usage(ip, owner, used_until, updated_at)
                 VALUES($1,$2,$3,$4)
                 ON CONFLICT (ip) DO UPDATE SET owner=EXCLUDED.owner, used_until=EXCLUDED.used_until, updated_at=EXCLUDED.updated_at`,
                [value, String(owner || ""), until, now],
            );
            return true;
        });
    }

    return {loadConfiguration, saveConfiguration, acquire, release, releaseByInstance, renew, snapshot, reserveExitIp};
}

export const proxyPoolRepository = createProxyPoolRepository();
