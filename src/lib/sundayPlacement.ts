/**
 * D335 — optional Sunday-only placement test path. OFF.
 *
 * Josh, 2026-11-11 ("turn off all deliverability testing" spec, item 6):
 * test at most on Sundays, and only if he approves the new plan (pending).
 * `SUNDAY_PLACEMENT_TEST_ENABLED` defaults to false and only the exact
 * string "true" enables it. Off means the cron is never registered, no
 * test is created, no canary shell, no finding, no SmartDelivery call.
 *
 * Master kill switch: `DELIVERABILITY_TESTING_ENABLED` (D333, open PR
 * #400) is not on this branch. When it lands, wire its helper into the
 * service's `masterSwitch` dep — the Sunday path must then need BOTH
 * flags on. Until then this flag alone gates it, and it is off.
 */
import { chicagoWallClock } from "./canonOpsHours.js";
import {
  MAILBOX_HEALTH_TIMEZONE,
  inMailboxHealthHours,
  mailboxHealthCronError,
} from "./mailboxHealthDaily.js";

export const SUNDAY_PLACEMENT_ENV = "SUNDAY_PLACEMENT_TEST_ENABLED";
/** Sunday 9:00am America/Chicago. */
export const SUNDAY_PLACEMENT_DEFAULT_CRON = "0 9 * * 0";
export const SUNDAY_PLACEMENT_TEST_PREFIX = "Sunday placement:";

export interface SundayPlacementConfig {
  enabled: boolean;
  cron: string;
  /** Tests per Sunday run (one per sg-owner, flagged owners first). */
  maxTests: number;
  /** Sender mailboxes per test. */
  maxSenders: number;
}

const posInt = (raw: string | undefined, fallback: number, max: number): number => {
  const n = Number(raw);
  return raw !== undefined && raw.trim() !== "" && Number.isInteger(n) && n >= 1
    ? Math.min(n, max)
    : fallback;
};

export function loadSundayPlacementConfig(
  env: NodeJS.ProcessEnv = process.env,
): SundayPlacementConfig {
  return {
    // Only the literal "true" turns this on — "1", "yes", "TRUE " do not.
    enabled: env[SUNDAY_PLACEMENT_ENV] === "true",
    cron: env.CRON_SUNDAY_PLACEMENT_TEST?.trim() || SUNDAY_PLACEMENT_DEFAULT_CRON,
    maxTests: posInt(env.SUNDAY_PLACEMENT_MAX_TESTS, 3, 10),
    maxSenders: posInt(env.SUNDAY_PLACEMENT_MAX_SENDERS, 20, 20),
  };
}

/**
 * Whether index.ts registers the cron. Off → never registered. On → the
 * hour must be 06–19 CT and the day-of-week field Sunday only.
 */
export function sundayPlacementScheduleError(cfg: SundayPlacementConfig): string | null {
  if (!cfg.enabled) return `${SUNDAY_PLACEMENT_ENV} is not "true"`;
  const hourError = mailboxHealthCronError(cfg.cron, "CRON_SUNDAY_PLACEMENT_TEST");
  if (hourError) return hourError;
  const fields = cfg.cron.trim().split(/\s+/);
  const dow = fields[fields.length - 1]!.toUpperCase();
  if (!["0", "7", "SUN"].includes(dow)) {
    return `CRON_SUNDAY_PLACEMENT_TEST day-of-week "${dow}" must be Sunday only (0)`;
  }
  return null;
}

/** Runtime gate. Null = may run now; else the reason it refuses. */
export function sundayPlacementGate(
  cfg: SundayPlacementConfig,
  now: Date,
  masterSwitch?: () => boolean,
): string | null {
  if (!cfg.enabled) return `${SUNDAY_PLACEMENT_ENV} is not "true"`;
  if (masterSwitch && !masterSwitch()) return "DELIVERABILITY_TESTING_ENABLED is off";
  if (chicagoWallClock(now, MAILBOX_HEALTH_TIMEZONE).weekday !== 0) {
    return "not Sunday in America/Chicago";
  }
  if (!inMailboxHealthHours(now)) return "outside 06:00–19:59 America/Chicago";
  return null;
}
