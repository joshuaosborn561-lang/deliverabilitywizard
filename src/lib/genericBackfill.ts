import { isPocClient } from "./pocClient.js";
import { isPowerGrydHay } from "./powerGryd.js";

export interface GenericBackfillApproval {
  campaignId: number;
  approvedAt: string;
  approvedBy: string;
}

export function hasGenericBackfillApproval(
  approvals: Record<string, GenericBackfillApproval | undefined>,
  campaignId: number,
): boolean {
  return Boolean(approvals[String(campaignId)]?.approvedAt);
}

/**
 * Rotating-pool generics may sit on a POC client only (currently
 * Goliath) for *new attaches beyond a named POD's shortfall-to-40*.
 *
 * D193 — leftover D134 Slack / retire-tap approvals are a historical
 * record, not attach permission. Do not dump GENERIC / pool-brand
 * senders onto a named lane past the shortfall.
 *
 * D203 narrows D193's "leave it short / client-inbox only" read for
 * the min-40 fill path: exclusive client-signed generics may layer
 * on top of each named POD to fill that POD up to 40 when the named
 * half is short. Prefer named first. SalesGlider with ≥40 named per
 * POD must not carry pool generics.
 */
export function campaignMayTakeGenerics(
  campaign: { id: number; name?: string | null },
  clientName: string | null | undefined,
  pocPatterns: string[],
  _approvals?: Record<string, GenericBackfillApproval | undefined>,
): boolean {
  void _approvals;
  const hay = `${campaign.name ?? ""} ${clientName ?? ""}`;
  // D204 — PowerGryd is a POC but its 40 dedicated seats are the
  // staff. Do not dump rotating-pool generics onto those lanes.
  if (isPowerGrydHay(hay)) return false;
  return isPocClient(hay, pocPatterns);
}
