/**
 * Evidence tags from standing control history. These are a cull *note*,
 * not an automatic pull (D48). Rotation still uses D32 / D5.
 */

export type MailboxControlPlacement = "PRIMARY" | "SPAM" | "OTHER" | "UNKNOWN";
export type MailboxControlTag = "keep" | "watch" | "kill";

export const CONTROL_PRIMARY_THRESHOLD = 80;
export const CONTROL_KILL_FAILS = 2;
export const CONTROL_HISTORY = 3;

export function placementFromInboxRate(input: {
  inboxRate?: number;
  scoredSameEsp?: boolean;
  /** When same-ESP samples are thin, do not invent a placement. */
  requireSameEsp?: boolean;
}): MailboxControlPlacement {
  const requireSameEsp = input.requireSameEsp !== false;
  if (requireSameEsp && input.scoredSameEsp !== true) return "UNKNOWN";
  if (typeof input.inboxRate !== "number" || !Number.isFinite(input.inboxRate)) {
    return "UNKNOWN";
  }
  if (input.inboxRate >= CONTROL_PRIMARY_THRESHOLD) return "PRIMARY";
  return "SPAM";
}

export function tagFromPlacements(
  placements: MailboxControlPlacement[],
  history = CONTROL_HISTORY,
): MailboxControlTag {
  const recent = placements
    .filter((placement) => placement !== "UNKNOWN")
    .slice(-history);
  const fails = recent.filter((placement) => placement === "SPAM").length;
  if (fails >= CONTROL_KILL_FAILS) return "kill";
  if (fails >= 1) return "watch";
  return "keep";
}

export function rollingFailCount(
  placements: MailboxControlPlacement[],
  history = CONTROL_HISTORY,
): number {
  return placements
    .filter((placement) => placement !== "UNKNOWN")
    .slice(-history)
    .filter((placement) => placement === "SPAM").length;
}

export function podVerdictFromSenders(
  placements: MailboxControlPlacement[],
): "CLEAN" | "DEGRADED" | "FAILING" | "INSUFFICIENT" {
  const known = placements.filter((placement) => placement !== "UNKNOWN");
  if (!known.length) return "INSUFFICIENT";
  const failing = known.filter((placement) => placement === "SPAM").length;
  if (failing === 0) return "CLEAN";
  if (failing === known.length) return "FAILING";
  return "DEGRADED";
}

/**
 * Campaign inherits the reading of *its* senders, not the pod average.
 * Any spam among known senders is inboxes. All known primary is clean.
 */
export function campaignSenderControl(
  placements: MailboxControlPlacement[],
): "CLEAN" | "FAILING" | "INSUFFICIENT" {
  const known = placements.filter((placement) => placement !== "UNKNOWN");
  if (!known.length) return "INSUFFICIENT";
  if (known.some((placement) => placement === "SPAM")) return "FAILING";
  return "CLEAN";
}
