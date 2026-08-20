// @ts-nocheck

/** 人工验证通过后迁入此分组，自动换绑只从这里领号。 */
export const REBIND_GMAIL_POOL_GRP = "换绑池";

/** 独立未售、凭据齐全且未关联账号的 Gmail 筛选条件。 */
export const FREE_GOOGLE_IMAP_SQL = `
    m.usage='hold' AND m.deleted_at=0
    AND COALESCE(m.sold_at,0)=0
    AND m.provider='google'
    AND COALESCE(m.password,'') <> ''
    AND COALESCE(m.totp_secret,'') <> ''
    AND COALESCE(m.imap_password,'') <> ''
    AND COALESCE(m.google_stage,'') NOT IN ('gpt_ok','login_fail','blocked','imported')
    AND NOT EXISTS (SELECT 1 FROM gpt_accounts g WHERE g.mailbox_id=m.id AND COALESCE(g.deleted_at,0)=0)
    AND NOT EXISTS (SELECT 1 FROM claude_accounts c WHERE c.mailbox_id=m.id)
`;

export function googleImapClaimWhere({grp, emails, excludeIds} = {}) {
    const conditions = [FREE_GOOGLE_IMAP_SQL];
    const params = [];
    if (grp !== undefined && grp !== null && grp !== "__ALL__") {
        params.push(String(grp));
        conditions.push(`COALESCE(m.grp,'') = $${params.length}`);
    }
    if (Array.isArray(emails) && emails.length) {
        params.push(emails.map((email) => String(email || "").trim().toLowerCase()).filter(Boolean));
        conditions.push(`lower(m.email) = ANY($${params.length})`);
    }
    if (Array.isArray(excludeIds) && excludeIds.length) {
        params.push(excludeIds.map(Number).filter(Number.isInteger));
        conditions.push(`NOT (m.id = ANY($${params.length}))`);
    }
    return {sql: conditions.join(" AND "), params};
}
