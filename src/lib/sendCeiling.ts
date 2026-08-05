import type { AppConfig } from "../config.js";

/**
 * Smartlead's `max_email_per_day` is a shared ceiling: warmup draws from it
 * first, and campaign sends get whatever is left. D11's `MESSAGE_PER_DAY` is
 * the *campaign* target, so the Smartlead field must be campaign + warmup.
 */
export function totalDailySendCeiling(
  config: Pick<AppConfig, "messagePerDay" | "warmupTotalPerDay">,
): number {
  return config.messagePerDay + config.warmupTotalPerDay;
}
