/**
 * D184 — Insight outbound is campaign-scoped, not a SalesGlider mailbox
 * rewrite. Smartlead has no campaign-level "don't append the mailbox
 * signature" switch (GET /campaigns/{id} and POST /settings expose
 * tracking, stop-on-reply, plain-text, schedule — not add_signature).
 * The campaign levers are: keep `%signature%` out of Insight copy
 * (D178) and, only when a mailbox sits on Insight campaigns and no
 * other non-shell campaign, blank the mailbox signature so Smartlead
 * has nothing to append. Shared SalesGlider mailboxes stay Name /
 * SalesGlider (D31). `desiredMailboxSignature` is unchanged.
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

const INSIGHT_ID_SET = new Set(INSIGHT_CAMPAIGN_IDS);

/** Empty mailbox signature — Smartlead then has nothing to append. */
export const INSIGHT_MAILBOX_SIGNATURE_BLANK = "";

const INSIGHT_SECOND_BRANDS = ["SalesGlider", "SalesGlider Growth"];

export function isInsightCampaignId(id: number | null | undefined): boolean {
  return typeof id === "number" && INSIGHT_ID_SET.has(id);
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

export function insightCampaignIdSet(
  campaigns: Iterable<{ id?: number | null }>,
): Set<number> {
  const out = new Set<number>();
  for (const campaign of campaigns) {
    if (isInsightCampaignId(campaign.id)) out.add(campaign.id!);
  }
  return out;
}

/**
 * True when every non-shell membership is a named Insight campaign
 * and at least one such membership exists. An unknown campaign id
 * (not in the map) is treated as shared — do not blank. A mailbox
 * that also sits on SalesGlider Nurture (any status, non-shell) is
 * shared. Shells (canary / pod-control) do not count.
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
    if (!isInsightCampaignId(id)) return false;
    onInsight = true;
  }
  return onInsight;
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
