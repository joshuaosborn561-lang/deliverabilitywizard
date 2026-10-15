/**
 * D276 — no scheduled job or Slack post outside weekdays 6am–8pm
 * America/Chicago. Overnight and weekend work waits.
 */

export const QUIET_HOURS_TIMEZONE = "America/Chicago";
export const STAFFING_HOUR_START = 6;
export const STAFFING_HOUR_END = 20;

export interface ChicagoClock {
  weekday: number;
  hour: number;
  minute: number;
  ymd: string;
}

export function chicagoClock(
  now: Date = new Date(),
  timeZone = QUIET_HOURS_TIMEZONE,
): ChicagoClock {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "short",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const num = (type: string): number =>
    Number(parts.find((p) => p.type === type)?.value ?? NaN);
  const weekdayName = parts.find((p) => p.type === "weekday")?.value ?? "";
  const weekdayMap: Record<string, number> = {
    Sun: 0,
    Mon: 1,
    Tue: 2,
    Wed: 3,
    Thu: 4,
    Fri: 5,
    Sat: 6,
  };
  const year = num("year");
  const month = num("month");
  const day = num("day");
  return {
    weekday: weekdayMap[weekdayName] ?? 0,
    hour: num("hour"),
    minute: num("minute"),
    ymd: `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`,
  };
}

/** True on a weekday inside [6:00, 20:00) America/Chicago. */
export function inStaffingHours(
  now: Date = new Date(),
  timeZone = QUIET_HOURS_TIMEZONE,
): boolean {
  const clock = chicagoClock(now, timeZone);
  if (clock.weekday === 0 || clock.weekday === 6) return false;
  return clock.hour >= STAFFING_HOUR_START && clock.hour < STAFFING_HOUR_END;
}

/** Inverse of inStaffingHours — nights, weekends, and 8pm onward. */
export function isQuietHours(
  now: Date = new Date(),
  timeZone = QUIET_HOURS_TIMEZONE,
): boolean {
  return !inStaffingHours(now, timeZone);
}

export function mayPostSlack(now: Date = new Date()): boolean {
  return inStaffingHours(now);
}
