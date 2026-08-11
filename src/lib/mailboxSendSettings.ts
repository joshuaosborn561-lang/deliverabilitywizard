import type { SmartleadAccountWithCampaigns } from "../clients/smartlead.js";

/**
 * Read helpers for per-mailbox send settings. Smartlead's GET-by-id and
 * campaign account lists often omit `minTimeToWaitInMins` — the fleet list
 * (`GET /email-accounts/`) is the source of truth for the gap (D30).
 */

export function readMessagePerDay(account: SmartleadAccountWithCampaigns): number {
  const raw =
    (account as { message_per_day?: number | string }).message_per_day ??
    account.max_email_per_day;
  if (typeof raw === "number" && Number.isFinite(raw)) return raw;
  if (typeof raw === "string" && raw.trim() !== "") {
    const n = Number(raw);
    if (Number.isFinite(n)) return n;
  }
  return NaN;
}

export function readMinTimeGapMins(account: SmartleadAccountWithCampaigns): number {
  const raw =
    (account as { minTimeToWaitInMins?: number | string | null })
      .minTimeToWaitInMins ??
    (account as { time_to_wait_in_mins?: number | string | null })
      .time_to_wait_in_mins;
  if (typeof raw === "number" && Number.isFinite(raw)) return raw;
  if (typeof raw === "string" && raw.trim() !== "") {
    const n = Number(raw);
    if (Number.isFinite(n)) return n;
  }
  return NaN;
}

/** True when the mailbox must be written to hold the standing 10-minute gap. */
export function needsMinTimeGap(
  account: SmartleadAccountWithCampaigns,
  targetGapMins: number,
): boolean {
  const current = readMinTimeGapMins(account);
  return !(Number.isFinite(current) && current === targetGapMins);
}
