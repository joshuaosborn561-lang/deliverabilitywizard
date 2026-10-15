/**
 * D223 / D236 / D254 — Deep Roots POC 60-seat fill.
 * Goliath 548611 is on the name list for other POC flags but is NOT
 * a 60-seat engagement. PowerGRYD is a full named client. CALLER
 * FOLLOW-UP / Gabe campaigns are never staffed this way.
 */

import {
  CALLER_FOLLOWUP_CAMPAIGN_IDS,
  CALLER_FOLLOWUP_NAME_PREFIX,
  DEEP_ROOTS_NAMED_CLIENT_ID,
  GOLIATH_CLIENT_ID,
  POC_FILL_SEATS,
  POWERGRYD_CLIENT_ID,
  minFloorForClient,
} from "../canon/constants.js";
import type { SlimCampaign } from "../types.js";

export const DEFAULT_POC_CLIENT_NAME_PATTERNS = ["goliath", "deep roots"] as const;
export const GABE_POST_CALL_CAMPAIGN_ID = 4074266;
export const GABE_FOLLOW_UP_CAMPAIGN_IDS = [
  4074264, 4074265, 4074266, 4085158, 4085159, 4085160,
] as const;
export const POC_LIVING_STATUSES = ["ACTIVE", "START", "DRAFT", "DRAFTED"] as const;

export function isCallerFollowUpCampaign(campaign: {
  id?: number | null;
  name?: string | null;
}): boolean {
  const id = Number(campaign.id);
  if (
    Number.isFinite(id) &&
    (CALLER_FOLLOWUP_CAMPAIGN_IDS as readonly number[]).includes(id)
  ) {
    return true;
  }
  return String(campaign.name ?? "").startsWith(CALLER_FOLLOWUP_NAME_PREFIX);
}

export function isGabeFollowUpCampaign(campaign: {
  id?: number | null;
  name?: string | null;
}): boolean {
  if (isCallerFollowUpCampaign(campaign)) return true;
  const id = Number(campaign.id);
  if (
    Number.isFinite(id) &&
    (GABE_FOLLOW_UP_CAMPAIGN_IDS as readonly number[]).includes(id)
  ) {
    return true;
  }
  return String(campaign.name ?? "").toLowerCase().includes("gabe");
}

export function isPocClient(
  hay: string,
  patterns: string[] = [...DEFAULT_POC_CLIENT_NAME_PATTERNS],
): boolean {
  const text = hay.toLowerCase();
  return patterns.some((pattern) => {
    const needle = pattern.trim().toLowerCase();
    return Boolean(needle) && text.includes(needle);
  });
}

export function isPocEngagementClient(input: {
  clientId?: number | null;
  hay?: string;
  name?: string | null;
}): boolean {
  const id = input.clientId;
  if (typeof id !== "number" || !Number.isFinite(id) || id <= 0) return false;
  if (id === GOLIATH_CLIENT_ID) return false;
  if (id === POWERGRYD_CLIENT_ID) return false;
  const hay = input.hay ?? String(input.name ?? "");
  if (id === DEEP_ROOTS_NAMED_CLIENT_ID) return true;
  return isPocClient(hay);
}

export function isPocLivingCampaignStatus(status: string | null | undefined): boolean {
  return (POC_LIVING_STATUSES as readonly string[]).includes(
    String(status ?? "").toUpperCase(),
  );
}

export function shouldStaffPocCampaign(campaign: SlimCampaign): boolean {
  if (isGabeFollowUpCampaign(campaign)) return false;
  return isPocLivingCampaignStatus(campaign.status);
}

export function seatTargetForCampaign(campaign: SlimCampaign): number {
  if (
    isPocEngagementClient({
      clientId: campaign.clientId,
      name: campaign.name,
    })
  ) {
    return POC_FILL_SEATS;
  }
  return minFloorForClient(campaign.clientId);
}
