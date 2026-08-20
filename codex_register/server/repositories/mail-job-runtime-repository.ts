// @ts-nocheck
import {query} from "./database-context.js";

export async function setMailClaimPaused(paused) {
    await query(`UPDATE mail_control SET claim_paused=$1, updated_at=$2 WHERE id=1`, [!!paused, Date.now()]);
}

export async function isMailClaimPaused() {
    const {rows: [row]} = await query(`SELECT claim_paused FROM mail_control WHERE id=1`);
    return !!row?.claim_paused;
}

export async function upsertMailInstance(instId, snapshot = {}) {
    const now = Date.now();
    await query(
        `INSERT INTO mail_instances(instance_id, stop_claim, proxy_slots, proxy_leased, running_jobs, last_seen)
         VALUES($1,$2,$3,$4,$5,$6)
         ON CONFLICT (instance_id) DO UPDATE SET
           stop_claim=EXCLUDED.stop_claim,
           proxy_slots=EXCLUDED.proxy_slots,
           proxy_leased=EXCLUDED.proxy_leased,
           running_jobs=EXCLUDED.running_jobs,
           last_seen=EXCLUDED.last_seen`,
        [instId, !!snapshot.stopClaim, Number(snapshot.proxySlots || 0), Number(snapshot.proxyLeased || 0), Number(snapshot.runningJobs || 0), now],
    );
}

export async function listMailInstances(maxAgeMs = 45_000) {
    const cutoff = Date.now() - maxAgeMs;
    const {rows} = await query(
        `SELECT instance_id, stop_claim, proxy_slots, proxy_leased, running_jobs, last_seen
         FROM mail_instances WHERE last_seen>=$1 ORDER BY instance_id`,
        [cutoff],
    );
    return rows.map((row) => ({
        instanceId: row.instance_id,
        stopClaim: !!row.stop_claim,
        proxySlots: row.proxy_slots || 0,
        proxyLeased: row.proxy_leased || 0,
        runningJobs: row.running_jobs || 0,
        lastSeen: Number(row.last_seen || 0),
        free: Math.max(0, (row.proxy_slots || 0) - (row.proxy_leased || 0)),
    }));
}
