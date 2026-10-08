/**
 * D248 — Josh's quiet-hours rule. Human #deliverability cards generated
 * 8pm–6am America/Chicago or on Sat/Sun queue until the next weekday
 * 8am Needs you post. The Watchdog pulse is not this rule.
 */

import { chicagoWallClock } from "./canonOpsHours.js";

export const QUIET_HOURS_TIMEZONE = "America/Chicago";
export const QUIET_HOUR_START = 20;
export const QUIET_HOUR_END = 6;
export const NEEDS_YOU_HOUR = 8;

export function isJoshQuietHours(
  now: Date = new Date(),
  timeZone = QUIET_HOURS_TIMEZONE,
): boolean {
  const clock = chicagoWallClock(now, timeZone);
  if (clock.weekday === 0 || clock.weekday === 6) return true;
  return clock.hour >= QUIET_HOUR_START || clock.hour < QUIET_HOUR_END;
}

export function isNeedsYouWeekdayMorning(
  now: Date = new Date(),
  timeZone = QUIET_HOURS_TIMEZONE,
): boolean {
  const clock = chicagoWallClock(now, timeZone);
  return clock.weekday >= 1 && clock.weekday <= 5 && clock.hour === NEEDS_YOU_HOUR;
}
