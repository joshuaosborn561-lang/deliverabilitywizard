import type { AppConfig } from "../config.js";
import { normalizeSenderEspFamily } from "./esp.js";

/**
 * Smartlead's account `message_per_day` (written as `max_email_per_day`) is
 * the UI field labeled "Message Per Day (Warmups not included)". Warmup has
 * its own `warmup_max_count`. D11/D24: write `MESSAGE_PER_DAY` (30) for
 * Gmail/SMTP. D183: Outlook/Microsoft (`account.type` microsoft family,
 * typically `OUTLOOK`) write 15. Do not drop the global constant to 15.
 */
export const OUTLOOK_MESSAGE_PER_DAY = 15;

export function isOutlookMailboxType(
  type: string | null | undefined,
): boolean {
  return normalizeSenderEspFamily(type) === "microsoft";
}

export function mailboxMessagePerDayTarget(
  account: { type?: string | null; platform?: string | null } | null | undefined,
  config: Pick<AppConfig, "messagePerDay">,
  opts?: { tenantZeroActive?: boolean } | null,
): number {
  // D208 — Josh-named Outlook seats on a tenant-cap hold stay at 0
  // until the UTC-day restore. Standing D183 15/30 is unchanged.
  if (opts?.tenantZeroActive) return 0;
  const type = account?.type ?? account?.platform;
  return isOutlookMailboxType(type) ? OUTLOOK_MESSAGE_PER_DAY : config.messagePerDay;
}

export function totalDailySendCeiling(
  config: Pick<AppConfig, "messagePerDay" | "warmupTotalPerDay">,
): number {
  void config.warmupTotalPerDay;
  return config.messagePerDay;
}
