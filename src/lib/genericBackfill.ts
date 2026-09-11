import { isPocClient } from "./pocClient.js";

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
 * Generics may sit on a POC client only (currently Goliath).
 *
 * D193 — leftover D134 Slack / retire-tap approvals are a historical
 * record, not attach permission. A named client campaign (TechEvo,
 * BCP, SalesGlider, Parlay, Insight, …) stays client-inbox only.
 * Understaffed client lanes stay short; they do not borrow the pool.
 */
export function campaignMayTakeGenerics(
  campaign: { id: number; name?: string | null },
  clientName: string | null | undefined,
  pocPatterns: string[],
  _approvals?: Record<string, GenericBackfillApproval | undefined>,
): boolean {
  void _approvals;
  return isPocClient(`${campaign.name ?? ""} ${clientName ?? ""}`, pocPatterns);
}
