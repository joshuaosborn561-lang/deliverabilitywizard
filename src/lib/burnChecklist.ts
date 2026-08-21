/**
 * D41 — blacklist alone is not enough to burn / purge a domain.
 *
 * Approval still gates the spend (D4/D15). This checklist is the extra
 * evidence bar before we even ask: a named non-SURBL listing plus at least
 * one corroborating sending-health signal.
 */

export interface BurnChecklistInput {
  /** Named non-SURBL list hit (Spamhaus, etc.). */
  namedBlacklist: boolean;
  /** Same-ESP inbox % when scored; null if unknown. */
  sameEspInbox: number | null;
  scoredSameEsp?: boolean;
  /** Bounce % (0–100) when sampled. */
  bounceRate: number | null;
  sent: number;
  inboxThreshold?: number;
  bounceThreshold?: number;
  minBounceSample?: number;
}

export interface BurnChecklistResult {
  ready: boolean;
  reasons: string[];
}

export function burnChecklistReady(
  input: BurnChecklistInput,
): BurnChecklistResult {
  const inboxThreshold = input.inboxThreshold ?? 80;
  const bounceThreshold = input.bounceThreshold ?? 5;
  const minSample = input.minBounceSample ?? 50;
  const reasons: string[] = [];

  if (!input.namedBlacklist) {
    reasons.push("no named (non-SURBL) blacklist hit");
  }

  const placementBad =
    input.scoredSameEsp === true &&
    typeof input.sameEspInbox === "number" &&
    input.sameEspInbox < inboxThreshold;
  const bounceBad =
    typeof input.bounceRate === "number" &&
    input.sent >= minSample &&
    input.bounceRate > bounceThreshold;

  if (!placementBad && !bounceBad) {
    reasons.push(
      "no corroborating same-ESP placement fail or bounce-over-threshold",
    );
  }

  return { ready: reasons.length === 0, reasons };
}
