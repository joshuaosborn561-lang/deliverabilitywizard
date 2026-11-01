/**
 * D313 — inbox warmup is 14 days (Josh, 10/29/2026 7:18am CT). One default
 * for every clock (pool, campaign-min, fresh InboxKit, evidence hold,
 * Generics Ledger warm-ready date, named-warm swap). Env vars
 * POOL_WARMUP_DAYS / MIN_CAMPAIGN_WARMUP_DAYS / FRESH_INBOX_WARMUP_DAYS
 * can still override. This is NOT the mailbox rest (28 days, D310).
 */
export const DEFAULT_WARMUP_DAYS = 14;
