/**
 * D205 — weekday business hours for the canon-ops stages
 * (hold-enforcement, min40-topup, powergryd-watch, generic-cleanup).
 * Default window is 08:00–18:00 America/Chicago, Monday–Friday.
 * Idle ticks outside the window still refresh lastOkAt so /health
 * does not go OVERDUE over a weekend.
 */

export const CANON_OPS_TIMEZONE_DEFAULT = "America/Chicago";
export const CANON_OPS_HOUR_START_DEFAULT = 8;
export const CANON_OPS_HOUR_END_DEFAULT = 18;

export interface CanonOpsHoursInput {
  timezone?: string;
  weekdayOnly?: boolean;
  hourStart?: number;
  hourEnd?: number;
  now?: Date;
}

export interface ChicagoWallClock {
  weekday: number;
  hour: number;
  minute: number;
  ymd: string;
}

export function chicagoWallClock(
  now: Date = new Date(),
  timeZone = CANON_OPS_TIMEZONE_DEFAULT,
): ChicagoWallClock {
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

/** True when the wall clock is a weekday inside [hourStart, hourEnd). */
export function isCanonOpsBusinessHours(
  input: CanonOpsHoursInput = {},
): boolean {
  const weekdayOnly = input.weekdayOnly !== false;
  const hourStart = Number.isFinite(input.hourStart)
    ? Math.max(0, Math.min(23, Math.floor(input.hourStart!)))
    : CANON_OPS_HOUR_START_DEFAULT;
  const hourEnd = Number.isFinite(input.hourEnd)
    ? Math.max(1, Math.min(24, Math.floor(input.hourEnd!)))
    : CANON_OPS_HOUR_END_DEFAULT;
  const clock = chicagoWallClock(
    input.now ?? new Date(),
    input.timezone ?? CANON_OPS_TIMEZONE_DEFAULT,
  );
  if (weekdayOnly && (clock.weekday === 0 || clock.weekday === 6)) {
    return false;
  }
  return clock.hour >= hourStart && clock.hour < hourEnd;
}

/** Chicago Mon-Fri. Surplus generic return is weekday-only (D225). */
export function isChicagoWeekday(
  now: Date = new Date(),
  timeZone = CANON_OPS_TIMEZONE_DEFAULT,
): boolean {
  const { weekday } = chicagoWallClock(now, timeZone);
  return weekday >= 1 && weekday <= 5;
}

export function canonOpsIdleReason(
  input: CanonOpsHoursInput = {},
): string | undefined {
  if (isCanonOpsBusinessHours(input)) return undefined;
  const tz = input.timezone ?? CANON_OPS_TIMEZONE_DEFAULT;
  return `outside weekday ${String(input.hourStart ?? CANON_OPS_HOUR_START_DEFAULT).padStart(2, "0")}:00–${String(input.hourEnd ?? CANON_OPS_HOUR_END_DEFAULT).padStart(2, "0")}:00 ${tz}`;
}

/**
 * D234 — Sat/Sun writers idle unless Josh is live (`/run` with
 * RUN_TOKEN). Cron health / monitor must not retag or rest-unlink
 * over a weekend.
 */
export function weekendWriterIdleReason(input: {
  now?: Date;
  joshLive?: boolean;
  timeZone?: string;
} = {}): string | undefined {
  if (input.joshLive) return undefined;
  if (isChicagoWeekday(input.now, input.timeZone ?? CANON_OPS_TIMEZONE_DEFAULT)) {
    return undefined;
  }
  return "weekend (writers idle Sat/Sun except Josh-live)";
}
