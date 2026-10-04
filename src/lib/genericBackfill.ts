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
 * Rotating-pool *dump* (fan-out / top-up extras past a POD's 40)
 * still stays POC-only. That is not D193's old "named clients
 * never receive generics."
 *
 * D203 narrows D193 for the min-40 fill path; D221 / D229 retire
 * the leftover "named clients never receive generics" read.
 * Every named client takes fleet-pool generics to fill that POD
 * to 40. min40-topup is the assign path. Assigned generics
 * (`client_id` + POD) must not be stripped from non-POC clients.
 * Leftover D134 Slack / retire-tap approvals are a historical
 * record, not attach permission — they do not dump the rotating
 * pool onto a named lane past the shortfall.
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
