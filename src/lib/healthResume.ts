/**
 * D211 — the 15-minute health chain is resumable.
 *
 * `runHealth` used to restart from inventory on every tick. A Railway
 * SIGTERM mid-pass (deploy recycle) left mailbox-gap / isolation-branch
 * at their morning stamp with consecutiveFailures=0 until a lucky
 * sitting finished end-to-end. Resume skips stages still fresh inside
 * the 15-minute cycle and continues the leftover tail. The 15m cron
 * still runs the full chain when nothing is leftover. Never at boot
 * (D122). `/run?mode=mailbox-gap` is the gap-only manual path.
 */

import { isMonitorStageFresh } from "./monitorResume.js";

/** One health cycle — skip-if-fresh window. Not the 45m overdue grace. */
export const HEALTH_CYCLE_MS = 15 * 60 * 1000;

/**
 * Stages that live on the 15-minute `runHealth` chain, in order.
 * scan-backfill is event-driven; mailbox-settings-full has its own 6h
 * throttle — neither belongs on the leftover-tail list.
 */
export const HEALTH_LOOP_STAGES = [
  "inventory",
  "client-rest",
  "generic-rest",
  "client-tag",
  "one-client",
  "qa-unpause",
  "campaign-check-first",
  "warmup-gate",
  "campaign-health",
  "pod-cover",
  "reconnect",
  "mailbox-gap",
  "isolation-branch",
  "isolation-buy-resume",
] as const;

export type HealthLoopStage = (typeof HEALTH_LOOP_STAGES)[number];

/** Late stages that starve when a deploy kills the sitting after campaign-health. */
export const HEALTH_TAIL_STAGES = [
  "pod-cover",
  "reconnect",
  "mailbox-gap",
  "isolation-branch",
  "isolation-buy-resume",
] as const;

export type HealthTailStage = (typeof HEALTH_TAIL_STAGES)[number];

const TAIL = new Set<string>(HEALTH_TAIL_STAGES);

export function staleHealthStages(
  stageHealth: Record<string, { lastOkAt: string | null } | undefined>,
  now = Date.now(),
  freshMs = HEALTH_CYCLE_MS,
): HealthLoopStage[] {
  return HEALTH_LOOP_STAGES.filter(
    (name) => !isMonitorStageFresh(stageHealth[name]?.lastOkAt, now, freshMs),
  );
}

export function staleHealthTail(
  stageHealth: Record<string, { lastOkAt: string | null } | undefined>,
  now = Date.now(),
  freshMs = HEALTH_CYCLE_MS,
): HealthTailStage[] {
  return HEALTH_TAIL_STAGES.filter(
    (name) => !isMonitorStageFresh(stageHealth[name]?.lastOkAt, now, freshMs),
  );
}

/**
 * Resume when at least one early stage is still fresh (the sitting
 * started) and at least one tail stage is leftover (SIGTERM / overdue).
 * An all-stale board is a normal 15-minute tick — run the full chain.
 */
export function healthNeedsResume(
  stageHealth: Record<string, { lastOkAt: string | null } | undefined>,
  now = Date.now(),
  freshMs = HEALTH_CYCLE_MS,
): boolean {
  if (staleHealthTail(stageHealth, now, freshMs).length === 0) return false;
  return HEALTH_LOOP_STAGES.some(
    (name) =>
      !TAIL.has(name) &&
      isMonitorStageFresh(stageHealth[name]?.lastOkAt, now, freshMs),
  );
}
