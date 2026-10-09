/**
 * D211 / D214 — the 15-minute health chain is resumable.
 *
 * `runHealth` used to restart from inventory on every tick. A Railway
 * SIGTERM mid-pass (deploy recycle) left mailbox-gap / pod-cover at
 * their morning stamp with consecutiveFailures=0 until a lucky sitting
 * finished end-to-end.
 *
 * D211 resumed only when an early stage was still inside the 15-minute
 * cycle. A deploy resets the cron, so the next tick is ~15 minutes
 * later — the early lastOks have aged out, resume is false, and the
 * pass starts from inventory again (prod 2026-09-30: campaign-health
 * 15:11Z, pod-cover still 13:13Z).
 *
 * D214 resumes on **chain inversion**: a later HEALTH_LOOP stage has
 * an older lastOk than an earlier one. Skip everything before the
 * leftover and continue. The 15m cron still runs the full chain when
 * the board is monotonic (a finished sitting). Never at boot (D122).
 * `/run?mode=mailbox-gap` and `/run?mode=pod-cover` are single-stage
 * manual paths.
 *
 * D215 — inventory lastOk is not the sitting frontier. skip-if-fresh
 * and a SIGTERM right after the shared-book fetch stamp inventory
 * newest while campaign-health is still the deepest ok. Treating that
 * as the frontier resumes at client-rest and re-runs the Smartlead
 * prefix (prod 2026-09-30 15:45Z). Newest is taken from the rest of
 * the loop; leftover is the first subsequent older stage.
 */

import { isMonitorStageFresh } from "./monitorResume.js";

/** One health cycle — skip-if-fresh window. Not the 45m overdue grace. */
export const HEALTH_CYCLE_MS = 15 * 60 * 1000;

/**
 * D249 — a leftover sitting dies with the health lock (45m). An inverted
 * board whose newest non-inventory lastOk is older than this is yesterday's
 * interrupt, not "still inside the cycle". Run the full chain.
 */
export const HEALTH_SITTING_MAX_MS = 45 * 60 * 1000;

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

export function stageLastOkMs(
  row: { lastOkAt?: string | null } | undefined,
): number {
  const at = Date.parse(row?.lastOkAt ?? "");
  return Number.isFinite(at) ? at : Number.NEGATIVE_INFINITY;
}

/**
 * First health-loop stage after the newest lastOk that is older than
 * that newest stamp. The newest stamp is where the sitting died; the
 * next older stage is the leftover. Skip the prefix, continue there.
 *
 * A first-inversion walk (client-rest 14:49 < inventory 15:00) is the
 * wrong leftover: skip-if-fresh refreshes inventory while rest stays
 * on the previous sitting. The starve is always *after* the newest ok.
 *
 * D215 — inventory is excluded from that newest stamp. A killed-early
 * sitting or skip-if-fresh refresh makes inventory newest and would
 * resume at client-rest, hiding a deeper campaign-health → pod-cover
 * interrupt.
 */
export function firstInterruptedHealthStage(
  stageHealth: Record<string, { lastOkAt: string | null } | undefined>,
  now = Date.now(),
  sittingMaxMs = HEALTH_SITTING_MAX_MS,
): HealthLoopStage | null {
  let newest = Number.NEGATIVE_INFINITY;
  let newestName: HealthLoopStage | null = null;
  for (const name of HEALTH_LOOP_STAGES) {
    // D215 — inventory lastOk is a shared-book / skip-if-fresh stamp,
    // not "how far the sitting got".
    if (name === "inventory") continue;
    const ok = stageLastOkMs(stageHealth[name]);
    if (ok >= newest) {
      newest = ok;
      newestName = name;
    }
  }
  if (!newestName || newest === Number.NEGATIVE_INFINITY) return null;
  // D249 — a 24h-old inversion is not a live sitting.
  if (now - newest > sittingMaxMs) return null;
  const start = HEALTH_LOOP_STAGES.indexOf(newestName) + 1;
  for (const name of HEALTH_LOOP_STAGES.slice(start)) {
    if (stageLastOkMs(stageHealth[name]) < newest) return name;
  }
  return null;
}

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

export function shouldSkipHealthStage(
  name: string,
  lastOkAt: string | null | undefined,
  opts: {
    skipIfFreshMs?: number;
    skipIfBeforeStage?: HealthLoopStage | null;
    now?: number;
  },
): boolean {
  const leftover = opts.skipIfBeforeStage;
  if (leftover) {
    const i = (HEALTH_LOOP_STAGES as readonly string[]).indexOf(name);
    const cut = HEALTH_LOOP_STAGES.indexOf(leftover);
    if (i >= 0 && cut >= 0 && i < cut) return true;
  }
  if (opts.skipIfFreshMs != null) {
    return isMonitorStageFresh(lastOkAt, opts.now ?? Date.now(), opts.skipIfFreshMs);
  }
  return false;
}

/**
 * Resume when a later health-loop stage is older than an earlier one
 * (D214/D215). The 15-minute early-fresh gate (D211) is not required — a
 * deploy recycle waits ~15m before the next cron, which aged that
 * signal out and starved pod-cover. Newest lastOk ignores inventory
 * (D215).
 *
 * An all-stale monotonic board is a normal 15-minute tick — full chain.
 */
export function healthNeedsResume(
  stageHealth: Record<string, { lastOkAt: string | null } | undefined>,
  now = Date.now(),
  _freshMs = HEALTH_CYCLE_MS,
  sittingMaxMs = HEALTH_SITTING_MAX_MS,
): boolean {
  return firstInterruptedHealthStage(stageHealth, now, sittingMaxMs) != null;
}
