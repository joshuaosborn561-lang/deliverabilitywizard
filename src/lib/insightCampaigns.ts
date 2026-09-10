/**
 * D184 — Insight outbound is a staffing split inside SalesGlider
 * client 345263, not a fleet mailbox rewrite.
 *
 * Live pattern (2026-09-10): Insight campaigns staff only seats that
 * are not on ACTIVE SalesGlider campaigns; those exclusive seats may
 * carry an empty mailbox signature (the sequence already closes
 * Josh Osborn / Insight); mailboxes that staff ACTIVE SG campaigns
 * keep Name / SalesGlider and are never blanked. Smartlead has no
 * campaign-level "don't append signature" switch. Do not converge
 * salesglider* domains to empty. `desiredMailboxSignature` is
 * unchanged.
 */

import {
  campaignIdsOf,
  type SmartleadAccountWithCampaigns,
} from "../clients/smartlead.js";
import type { SmartleadCampaign, SmartleadSequence } from "../types/index.js";
import { isAnyShellCampaign } from "./canaryShell.js";
import { findForeignBrand } from "./clientBrand.js";
import { extractSignatureLines } from "./mailboxSignature.js";
import {
  INSIGHT_CLOSE_BRAND,
  INSIGHT_CLOSE_NAME,
  sequenceBodiesContainInsight,
  signatureHay,
} from "./signatureQa.js";

/** Live Insight campaigns Josh named (client 345263). */
export const INSIGHT_CAMPAIGN_IDS: readonly number[] = [
  3921647, 3921651, 3921650, 3921654, 3921656, 3921653, 3921659,
];

export const SALESGLIDER_CLIENT_ID = 345263;

const INSIGHT_ID_SET = new Set(INSIGHT_CAMPAIGN_IDS);

/** Empty mailbox signature — Smartlead then has nothing to append. */
export const INSIGHT_MAILBOX_SIGNATURE_BLANK = "";

const INSIGHT_SECOND_BRANDS = ["SalesGlider", "SalesGlider Growth"];

export function isInsightCampaignId(id: number | null | undefined): boolean {
  return typeof id === "number" && INSIGHT_ID_SET.has(id);
}

/**
 * D189 — client-rest must not unlink these. Named D184 ids, or any
 * campaign whose name starts with `Insight ` on SalesGlider (345263).
 * Status does not matter: once a seat leaves Insight, D184 restore
 * cannot put it back (`insightRequiresExisting`).
 */
export function isInsightRestStickyCampaign(
  campaign:
    | {
        id?: number | null;
        name?: string | null;
        client_id?: number | null;
      }
    | undefined,
): boolean {
  if (!campaign) return false;
  if (isInsightCampaignId(campaign.id)) return true;
  if (campaign.client_id !== SALESGLIDER_CLIENT_ID) return false;
  return String(campaign.name ?? "").startsWith("Insight ");
}

export function campaignIsActive(
  campaign: { status?: string | null } | undefined,
): boolean {
  return String(campaign?.status ?? "").toUpperCase() === "ACTIVE";
}

/**
 * Named Insight campaign, or (when sequences are in hand) any campaign
 * whose copy contains the D178 `Insight` needle. Name-only does not
 * count — "Insight Pipeline A" without Insight in the body is still
 * a SalesGlider campaign (D178).
 */
export function isInsightCampaign(
  campaign: { id?: number | null },
  sequences?: SmartleadSequence[] | null,
): boolean {
  if (isInsightCampaignId(campaign.id)) return true;
  return sequenceBodiesContainInsight(sequences);
}

/**
 * ACTIVE SalesGlider Engagers (and other non-Insight client-345263
 * lives). Shells and Insight ids are never this.
 */
export function isActiveSalesGliderCampaign(
  campaign: SmartleadCampaign | undefined,
): boolean {
  if (!campaign || !campaignIsActive(campaign)) return false;
  if (isAnyShellCampaign(campaign)) return false;
  if (isInsightCampaignId(campaign.id)) return false;
  return campaign.client_id === SALESGLIDER_CLIENT_ID;
}

export function insightCampaignIdSet(
  campaigns: Iterable<{ id?: number | null }>,
): Set<number> {
  const out = new Set<number>();
  for (const campaign of campaigns) {
    if (isInsightCampaignId(campaign.id)) out.add(campaign.id!);
  }
  return out;
}

export function mailboxInsightCampaignIds(
  account: SmartleadAccountWithCampaigns,
  campaignById: Map<number, SmartleadCampaign>,
): number[] {
  const out: number[] = [];
  for (const id of campaignIdsOf(account)) {
    const campaign = campaignById.get(id);
    if (campaign && isAnyShellCampaign(campaign)) continue;
    if (isInsightCampaignId(id)) out.push(id);
  }
  return out;
}

export function mailboxActiveSalesGliderCampaigns(
  account: SmartleadAccountWithCampaigns,
  campaignById: Map<number, SmartleadCampaign>,
): SmartleadCampaign[] {
  const out: SmartleadCampaign[] = [];
  for (const id of campaignIdsOf(account)) {
    const campaign = campaignById.get(id);
    if (isActiveSalesGliderCampaign(campaign)) out.push(campaign!);
  }
  return out;
}

export function mailboxStaffsActiveSalesGlider(
  account: SmartleadAccountWithCampaigns,
  campaignById: Map<number, SmartleadCampaign>,
): boolean {
  return mailboxActiveSalesGliderCampaigns(account, campaignById).length > 0;
}

/**
 * On at least one Insight campaign and not on any ACTIVE SalesGlider
 * campaign. PAUSED/STOPPED SG memberships do not count as shared.
 * An unknown campaign id is treated as shared — do not blank.
 */
export function mailboxIsExclusiveInsightStaff(
  account: SmartleadAccountWithCampaigns,
  campaignById: Map<number, SmartleadCampaign>,
): boolean {
  const ids = campaignIdsOf(account);
  if (!ids.length) return false;
  let onInsight = false;
  for (const id of ids) {
    const campaign = campaignById.get(id);
    if (!campaign) return false;
    if (isAnyShellCampaign(campaign)) continue;
    if (isInsightCampaignId(id)) {
      onInsight = true;
      continue;
    }
    if (campaignIsActive(campaign)) return false;
  }
  return onInsight;
}

/**
 * Fan-out / top-up / on-week restore gate. Insight is not default
 * client-345263 fan-out: only mailboxes already on Insight may spread
 * across the Insight set, and never onto ACTIVE SG. ACTIVE SG staff
 * never attach to Insight.
 */
export function canAttachMailboxToCampaign(
  account: SmartleadAccountWithCampaigns,
  target: SmartleadCampaign,
  campaignById: Map<number, SmartleadCampaign>,
  opts?: { insightRequiresExisting?: boolean },
): boolean {
  if (isAnyShellCampaign(target)) return true;
  if (isInsightCampaignId(target.id)) {
    if (mailboxStaffsActiveSalesGlider(account, campaignById)) return false;
    if (opts?.insightRequiresExisting) {
      return mailboxInsightCampaignIds(account, campaignById).length > 0;
    }
    return true;
  }
  if (isActiveSalesGliderCampaign(target)) {
    return mailboxInsightCampaignIds(account, campaignById).length === 0;
  }
  return true;
}

/** Empty, whitespace, or the Josh Osborn / Insight two-line close. */
export function insightMailboxSignatureAllowed(
  signature?: string | null,
): boolean {
  const lines = extractSignatureLines(signature);
  if (lines.length === 0) return true;
  if (
    lines.length === 2 &&
    /^josh\s+osborn$/i.test(lines[0]!) &&
    lines[1] === INSIGHT_CLOSE_BRAND
  ) {
    return true;
  }
  if (
    lines.length === 1 &&
    /^josh\s+osborn\s*\/\s*insight$/i.test(lines[0]!)
  ) {
    return true;
  }
  return false;
}

/**
 * Second brand on an Insight-staffed mailbox (SalesGlider, SalesGlider
 * Growth, or any other known client). Empty / Insight-only is fine.
 */
export function insightMailboxSecondBrand(opts: {
  fromName?: string | null;
  signature?: string | null;
  otherClientBrands?: string[];
}): string | null {
  if (insightMailboxSignatureAllowed(opts.signature)) return null;
  const hay = signatureHay({
    fromName: opts.fromName,
    signature: opts.signature,
  });
  const brands = [
    ...INSIGHT_SECOND_BRANDS,
    ...(opts.otherClientBrands ?? []),
  ];
  return findForeignBrand(hay, INSIGHT_CLOSE_BRAND, brands);
}

/**
 * D184 QA: Insight sequence already has the in-body close, and the
 * staffed mailbox would append a second brand.
 */
export function insightDualSignatureMismatch(opts: {
  fromName?: string | null;
  signature?: string | null;
  otherClientBrands?: string[];
}): string | null {
  const foreign = insightMailboxSecondBrand(opts);
  if (!foreign) return null;
  return `carries ${foreign} under Insight close (want empty mailbox signature)`;
}

export { INSIGHT_CLOSE_NAME, INSIGHT_CLOSE_BRAND };
