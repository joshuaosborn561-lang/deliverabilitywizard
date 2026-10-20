/**
 * D272 — campaign-audit (and other monitor CPU walks) can already be in
 * flight when the 15-minute health cron starts. D270 only skips a *new*
 * monitor tick; it does not pause a sitting that reached campaign-audit.
 * Production 2026-10-15 froze while health:inventory overlapped
 * monitor:campaign-audit. This is a hunch, not the whole fix: pause
 * campaign-audit CPU while health is live so the two walks do not pin
 * the loop together. Health itself must never wait on this (deadlock).
 *
 * D293 — overdue weekday canon-ops (hold/min40) must not overlap a
 * live health scan either. Two time-sliced walks interleave
 * `setImmediate` and starve the freeze watchdog (prod 2026-10-19
 * 22:03:43Z, event-loop delay 22.4s, `scan:indexAccountsByCampaign`
 * 27.6s during health:client-rest). Health CPU yields to overdue
 * canon-ops; canon-ops itself must not wait on this flag (deadlock).
 */

export const HEALTH_CPU_PAUSE_MS = 25;

let overdueCanonOpsExclusive = false;
let slackInteractionExclusive = false;

export function setOverdueCanonOpsExclusive(on: boolean): void {
  overdueCanonOpsExclusive = on;
}

export function isOverdueCanonOpsExclusive(): boolean {
  return overdueCanonOpsExclusive;
}

/** D294 — a live Slack tap must not wait behind a 20–50s fleet scan. */
export function setSlackInteractionExclusive(on: boolean): void {
  slackInteractionExclusive = on;
}

export function isSlackInteractionExclusive(): boolean {
  return slackInteractionExclusive;
}

export async function pauseWhileHealthLive(
  isLive: (() => boolean) | undefined,
  opts: { label?: string } = {},
): Promise<void> {
  if (!isLive || !isLive()) return;
  const label = opts.label ?? "campaign-audit";
  console.log(
    `[${label}] health pass live — pausing CPU until health ends (D272)`,
  );
  while (isLive()) {
    await new Promise<void>((resolve) => {
      setTimeout(resolve, HEALTH_CPU_PAUSE_MS);
    });
  }
}

export async function pauseWhileOverdueCanonOps(
  opts: { label?: string; skip?: boolean } = {},
): Promise<void> {
  if (opts.skip || !overdueCanonOpsExclusive) return;
  const label = opts.label ?? "health";
  console.log(
    `[${label}] overdue canon-ops live — pausing CPU until min40 ends (D293)`,
  );
  while (overdueCanonOpsExclusive) {
    await new Promise<void>((resolve) => {
      setTimeout(resolve, HEALTH_CPU_PAUSE_MS);
    });
  }
}

export async function pauseWhileSlackInteraction(
  opts: { label?: string; skip?: boolean } = {},
): Promise<void> {
  if (opts.skip || !slackInteractionExclusive) return;
  const label = opts.label ?? "scan";
  console.log(
    `[${label}] Slack tap live — pausing CPU until the ack/decide stamps (D294)`,
  );
  while (slackInteractionExclusive) {
    await new Promise<void>((resolve) => {
      setTimeout(resolve, HEALTH_CPU_PAUSE_MS);
    });
  }
}
