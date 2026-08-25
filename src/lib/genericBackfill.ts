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
 * Generics may sit on a POC client, or on any campaign Josh Slack-approved.
 */
export function campaignMayTakeGenerics(
  campaign: { id: number; name?: string | null },
  clientName: string | null | undefined,
  pocPatterns: string[],
  approvals: Record<string, GenericBackfillApproval | undefined>,
): boolean {
  if (isPocClient(`${campaign.name ?? ""} ${clientName ?? ""}`, pocPatterns)) {
    return true;
  }
  return hasGenericBackfillApproval(approvals, campaign.id);
}
