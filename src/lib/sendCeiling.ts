import type { AppConfig } from "../config.js";

/**
 * Smartlead's account `message_per_day` (written as `max_email_per_day`) is
 * the UI field labeled "Message Per Day (Warmups not included)". Warmup has
 * its own `warmup_max_count`. D11/D24: write `MESSAGE_PER_DAY` (30) directly.
 */
export function totalDailySendCeiling(
  config: Pick<AppConfig, "messagePerDay" | "warmupTotalPerDay">,
): number {
  void config.warmupTotalPerDay;
  return config.messagePerDay;
}
