// @ts-nocheck
import {query} from "./database-context.js";
import {refreshMailboxGoogleState} from "./mailbox-google-state-repository.js";

export async function setMailboxPassword(id, password, pwStatus?) {
    const next = String(password || "");
    if (!next) return;
    await query(
        `UPDATE mailboxes
         SET password_prev=CASE WHEN password<>$1 AND COALESCE(password,'')<>'' THEN password ELSE password_prev END,
             password=$1, pw_status=$2
         WHERE id=$3`,
        [next, pwStatus ?? "", id],
    );
    await refreshMailboxGoogleState(id).catch(() => {});
}

export async function setMailboxPwStatus(id, pwStatus) {
    await query(`UPDATE mailboxes SET pw_status=$1 WHERE id=$2`, [String(pwStatus || ""), id]);
    await refreshMailboxGoogleState(id).catch(() => {});
}

export async function setMailboxProxy(id, url, ip = "", fail) {
    const u = String(url || "").trim();
    const p = String(ip || "").trim();
    if (!u) {
        await query(`UPDATE mailboxes SET proxy_url='', proxy_ip='', proxy_fail=0 WHERE id=$1`, [id]);
        return;
    }
    if (fail !== undefined) {
        await query(`UPDATE mailboxes SET proxy_url=$1, proxy_ip=$2, proxy_fail=$3 WHERE id=$4`, [u, p, Number(fail) || 0, id]);
        return;
    }
    if (p) {
        await query(`UPDATE mailboxes SET proxy_url=$1, proxy_ip=$2 WHERE id=$3`, [u, p, id]);
    } else {
        await query(`UPDATE mailboxes SET proxy_url=$1 WHERE id=$2`, [u, id]);
    }
}

export async function bumpMailboxProxyFail(id) {
    const {rows} = await query(
        `UPDATE mailboxes SET proxy_fail=COALESCE(proxy_fail,0)+1 WHERE id=$1 RETURNING proxy_fail`,
        [id],
    );
    return Number(rows[0]?.proxy_fail || 0);
}

export async function resetMailboxProxyFail(id) {
    await query(`UPDATE mailboxes SET proxy_fail=0 WHERE id=$1`, [id]);
}

export async function setMailboxBrowserFp(id, profile) {
    if (!id || !profile) return;
    await query(`UPDATE mailboxes SET browser_fp=$1::jsonb WHERE id=$2`, [JSON.stringify(profile), id]);
}
