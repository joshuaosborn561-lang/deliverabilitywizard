/**
 * Strings the /ops board shows for rules that are still current canon.
 * Send-window hours come from `campaignSendCanon` so a later canon edit
 * to the standing window shows up here without a second copy.
 * A fixed 1,000/day client pace is not canon; Watchdog sums mailbox caps
 * until CANON names one (`CLIENT_DAILY_SEND_PACE`).
 */

export const OPS_ALERTS_LABEL = "Dashboard";

/** D325 — under 80% same-ESP rests four weeks, then is burn-due. */
export const OPS_ISOLATION_HINT = "under 80% rests 4 weeks, then burn";

/** Approved watchdog display thresholds. Not a sweep-cadence change. */
export const OPS_TOP_UP_LEADS = 5_000;
export const OPS_BRING_TO_JOSH_LEADS = 2_000;

/**
 * null = no fixed client pace in canon. Watchdog uses the sum of
 * type-aware mailbox caps (Outlook 15 / Gmail-SMTP 30).
 */
export const CLIENT_DAILY_SEND_PACE: number | null = null;
