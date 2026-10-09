/**
 * D249 — catch a weekday cron that missed its fire because the process
 * was down, frozen, or restarted after the minute passed (Railway
 * deploy resets node-cron).
 *
 * Window is weekday 06:00–20:00 America/Chicago. Quiet hours and
 * weekends stay gated. Does not spend. InboxKit / Needs you / TERRL
 * EOD each run at most once per Chicago day.
 */

import { chicagoWallClock } from "./canonOpsHours.js";

export const CATCH_UP_TIMEZONE = "America/Chicago";
export const CATCH_UP_HOUR_START = 6;
export const CATCH_UP_HOUR_END = 20;
export const TERL_EOD_HOUR = 17;
export const TERL_EOD_MINUTE = 30;

export function inWeekdayCatchUpWindow(
  now: Date = new Date(),
  timeZone = CATCH_UP_TIMEZONE,
): boolean {
  const clock = chicagoWallClock(now, timeZone);
  if (clock.weekday === 0 || clock.weekday === 6) return false;
  return clock.hour >= CATCH_UP_HOUR_START && clock.hour < CATCH_UP_HOUR_END;
}

export function weekdayJobMissed(
  lastYmd: string | null | undefined,
  todayYmd: string,
): boolean {
  return Boolean(todayYmd) && lastYmd !== todayYmd;
}

export function chicagoYmdOfIso(
  iso: string | null | undefined,
  timeZone = CATCH_UP_TIMEZONE,
): string | null {
  if (!iso) return null;
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return null;
  return chicagoWallClock(new Date(at), timeZone).ymd;
}

/** TERRL EOD is due after 17:30 CT on a weekday inside the catch-up window. */
export function terlEodCatchUpDue(
  now: Date = new Date(),
  timeZone = CATCH_UP_TIMEZONE,
): boolean {
  if (!inWeekdayCatchUpWindow(now, timeZone)) return false;
  const clock = chicagoWallClock(now, timeZone);
  return (
    clock.hour > TERL_EOD_HOUR ||
    (clock.hour === TERL_EOD_HOUR && clock.minute >= TERL_EOD_MINUTE)
  );
}
