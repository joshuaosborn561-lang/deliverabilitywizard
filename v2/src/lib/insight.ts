/**
 * D282 — Insight (client 582890) live campaigns send only from Josh
 * Osborn inboxes on a salesglider* or Insight domain. Generics and
 * other named senders never attach. Floor is the Josh-seats that
 * exist; never backfill to 40.
 */

import { INSIGHT_CLIENT_ID, SALESGLIDER_CLIENT_ID } from "../canon/constants.js";
import { emailDomain } from "./staffable.js";
import type { SlimAccount, SlimCampaign } from "../types.js";

export const INSIGHT_CAMPAIGN_IDS: readonly number[] = [
  3921647, 3921651, 3921650, 3921654, 3921656, 3921653, 3921659,
];

const INSIGHT_ID_SET = new Set(INSIGHT_CAMPAIGN_IDS);

/** Visible from-name that may send on Insight (D282). */
export const INSIGHT_JOSH_FROM_NAME = /^josh\s+osborn$/i;

export function isInsightCampaignId(id: number | null | undefined): boolean {
  return typeof id === "number" && INSIGHT_ID_SET.has(id);
}

export function isInsightClientId(id: number | null | undefined): boolean {
  return id === INSIGHT_CLIENT_ID;
}

export function isInsightJoshOnlyCampaign(
  campaign: Pick<SlimCampaign, "id" | "name" | "clientId"> | null | undefined,
): boolean {
  if (!campaign) return false;
  if (isInsightClientId(campaign.clientId)) return true;
  if (isInsightCampaignId(campaign.id)) return true;
  if (
    campaign.clientId !== SALESGLIDER_CLIENT_ID &&
    campaign.clientId !== INSIGHT_CLIENT_ID
  ) {
    return false;
  }
  return String(campaign.name ?? "").startsWith("Insight ");
}

function sendingDomainBase(domain: string): string {
  return domain
    .toLowerCase()
    .replace(/\.[a-z0-9]+$/i, "")
    .replace(/[^a-z0-9]/g, "");
}

export function isSalesGliderOrInsightSendingDomain(
  domain: string | null | undefined,
): boolean {
  if (!domain) return false;
  const base = sendingDomainBase(domain);
  if (!base) return false;
  return (
    base.includes("salesglider") ||
    base.includes("joshosborn") ||
    base.includes("insight")
  );
}

export function isInsightJoshAllowedSender(
  account: Pick<SlimAccount, "fromName" | "email"> | null | undefined,
): boolean {
  if (!account) return false;
  const from = String(account.fromName ?? "").trim();
  if (!INSIGHT_JOSH_FROM_NAME.test(from)) return false;
  return isSalesGliderOrInsightSendingDomain(emailDomain(account.email));
}

/** D282 — min40, generic fill, TERRL substitute, and understaffed skip. */
export function insightExemptFromSenderTopUp(
  campaign: Pick<SlimCampaign, "id" | "name" | "clientId"> | null | undefined,
): boolean {
  return isInsightJoshOnlyCampaign(campaign);
}

export function canStaffInsightCampaign(
  account: Pick<SlimAccount, "fromName" | "email">,
  campaign: Pick<SlimCampaign, "id" | "name" | "clientId">,
): boolean {
  if (!isInsightJoshOnlyCampaign(campaign)) return true;
  return isInsightJoshAllowedSender(account);
}
