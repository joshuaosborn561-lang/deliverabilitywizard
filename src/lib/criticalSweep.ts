/**
 * A1 (D312) — critical sweep constants.
 *
 * Placement results (`monitor-results`), `test-reconcile` and
 * `isolation-branch` run on their own lock and the top-priority Smartlead
 * lane every 30 minutes (`CRON_CRITICAL_SWEEP`, default `7,37 * * * *`).
 * A stage that ran inside CRITICAL_FRESH_MS is not repeated by the health
 * pass or the 6-hour monitor chain.
 */
export const CRITICAL_SWEEP_LOCK_MAX_MS = 40 * 60 * 1000;
export const CRITICAL_FRESH_MS = 20 * 60 * 1000;
