/**
 * D192 — Insight is Smartlead client 582890 (mailbox sig
 * `Josh Osborn\nInsight`). SalesGlider stays 345263 (`salesglider*`
 * only). Insight ≠ SG. D184's exclusive-blank Insight staff inside
 * 345263 is retired — never revive.
 *
 * D282 — Insight live campaigns send only from Josh Osborn inboxes
 * on a salesglider* or Insight domain. Generics and other named
 * senders never attach. Mix with ACTIVE SalesGlider still refuses.
 */

import {
  campaignIdsOf,
  type SmartleadAccountWithCampaigns,
} from "../clients/smartlead.js";
import type { SmartleadCampaign, SmartleadSequence } from "../types/index.js";
import { isAnyShellCampaign } from "./canaryShell.js";
import { findForeignBrand } from "./clientBrand.js";
import { emailDomainOf } from "./isolationDomain.js";
import { extractSignatureLines } from "./mailboxSignature.js";
import {
  INSIGHT_CLOSE_BRAND,
  INSIGHT_CLOSE_NAME,
  sequenceBodiesContainInsight,
  signatureHay,
} from "./signatureQa.js";
import { isAttachForbiddenSeat, isDoNotRelinkPair } from "./attachGuard.js";

/** Live Insight campaigns Josh named (now client 582890 — D192). */
export const INSIGHT_CAMPAIGN_IDS: readonly number[] = [
  3921647, 3921651, 3921650, 3921654, 3921656, 3921653, 3921659,
];

export const SALESGLIDER_CLIENT_ID = 345263;
/** Josh personal Insight client — not SalesGlider. */
export const INSIGHT_CLIENT_ID = 582890;

const INSIGHT_ID_SET = new Set(INSIGHT_CAMPAIGN_IDS);

/** Empty mailbox signature — Smartlead then has nothing to append. */
export const INSIGHT_MAILBOX_SIGNATURE_BLANK = "";

/** Title line on the Insight mailbox signature (D255). */
export const INSIGHT_MAILBOX_TITLE = "Strategic Account Executive";

const INSIGHT_SECOND_BRANDS = ["SalesGlider", "SalesGlider Growth"];

export function isInsightCampaignId(id: number | null | undefined): boolean {
  return typeof id === "number" && INSIGHT_ID_SET.has(id);
}

export function isInsightClientId(id: number | null | undefined): boolean {
  return id === INSIGHT_CLIENT_ID;
}

/**
 * Visible from-name that may send on Insight (D282 / D290).
 * Production seats use `Joshua Osborn` (Smartlead GET 2026-10-19);
 * `Josh Osborn` still matches.
 */
export const INSIGHT_JOSH_FROM_NAME = /^josh(ua)?\s+osborn$/i;

/**
 * D282 — Insight (client 582890, named Insight ids, or `Insight ` prefix
 * on 582890 / leftover 345263). Shells are not this class.
 */
export function isInsightJoshOnlyCampaign(
  campaign:
    | {
        id?: number | null;
        name?: string | null;
        client_id?: number | null;
      }
    | null
    | undefined,
): boolean {
  if (!campaign) return false;
  if (isAnyShellCampaign(campaign)) return false;
  if (isInsightClientId(campaign.client_id)) return true;
  return isInsightRestStickyCampaign(campaign);
}

function insightSendingDomainBase(domain: string): string {
  return domain
    .toLowerCase()
    .replace(/\.[a-z0-9]+$/i, "")
    .replace(/[^a-z0-9]/g, "");
}

/**
 * D282 / D290 — SalesGlider (`salesglider*`) or Insight
 * (`insight` / `joshosborn*` / `joshuaosborn*`) sending domains.
 * `joshosborn` is not a substring of `joshuaosbornco`.
 * Other client brands are never Insight supply.
 */
export function isSalesGliderOrInsightSendingDomain(
  domain: string | null | undefined,
): boolean {
  if (!domain) return false;
  const base = insightSendingDomainBase(domain);
  if (!base) return false;
  return (
    base.includes("salesglider") ||
    /josh(ua)?osborn/.test(base) ||
    base.includes("insight")
  );
}

export type InsightJoshSenderAccount = {
  from_name?: string | null;
  from_email?: string | null;
  email?: string | null;
  username?: string | null;
  signature?: string | null;
};

export function insightSenderEmail(
  account: InsightJoshSenderAccount,
): string | undefined {
  return (
    account.from_email?.trim() ||
    account.email?.trim() ||
    account.username?.trim() ||
    undefined
  );
}

/**
 * D282 / D290 — a Josh / Joshua Osborn mailbox on a salesglider*
 * or Insight (`joshosborn*` / `joshuaosborn*` / `insight*`) domain.
 * Generics and other named senders (Owen Sanchez, …) never qualify.
 */
export function isInsightJoshAllowedSender(
  account: InsightJoshSenderAccount | null | undefined,
): boolean {
  if (!account) return false;
  const from = String(account.from_name ?? "").trim();
  if (!INSIGHT_JOSH_FROM_NAME.test(from)) return false;
  const email = insightSenderEmail(account);
  return isSalesGliderOrInsightSendingDomain(emailDomainOf(email));
}

/**
 * D282 — Insight's floor is whatever Josh-seats exist. min40, generic
 * backfill, TERRL substitute, and understaffed findings skip the class.
 * Fan-out / rest of Josh seats still run.
 */
export function insightExemptFromSenderTopUp(
  campaign:
    | {
        id?: number | null;
        name?: string | null;
        client_id?: number | null;
      }
    | null
    | undefined,
): boolean {
  return isInsightJoshOnlyCampaign(campaign);
}

export class InsightNonJoshSenderBlockedError extends Error {
  readonly blockedIds: number[];
  readonly campaignId: number;

  constructor(campaignId: number, blockedIds: number[]) {
    super(
      `Insight campaigns may only send from Josh Osborn inboxes on SalesGlider or Insight domains (client 582890, D282): campaign ${campaignId} blocked account ids ${blockedIds.join(",")}`,
    );
    this.name = "InsightNonJoshSenderBlockedError";
    this.blockedIds = blockedIds;
    this.campaignId = campaignId;
  }
}

export function insightJoshLinkCampaignIds(
  campaigns: Iterable<{
    id?: number | null;
    name?: string | null;
    client_id?: number | null;
  }> = [],
): Set<number> {
  const out = new Set<number>(INSIGHT_CAMPAIGN_IDS);
  for (const campaign of campaigns) {
    if (typeof campaign.id !== "number" || !Number.isFinite(campaign.id)) {
      continue;
    }
    if (isInsightJoshOnlyCampaign(campaign)) out.add(campaign.id);
  }
  return out;
}

export function assertInsightJoshOnlyAccountIds(
  campaignId: number,
  accountIds: number[],
  ctx: {
    insightCampaignIds: ReadonlySet<number>;
    accountsById: ReadonlyMap<number, InsightJoshSenderAccount>;
  },
): void {
  if (
    !ctx.insightCampaignIds.has(campaignId) &&
    !isInsightCampaignId(campaignId)
  ) {
    return;
  }
  const blocked = accountIds.filter((id) => {
    const account = ctx.accountsById.get(id);
    return !account || !isInsightJoshAllowedSender(account);
  });
  if (blocked.length) {
    throw new InsightNonJoshSenderBlockedError(campaignId, blocked);
  }
}

/**
 * Insight campaign classifier (named ids, or name starting with
 * `Insight ` on Insight 582890 / leftover SalesGlider 345263).
 * D229 retired the D189 rest-sticky exception — client-rest
 * unlinks off-week seats from these like any other ACTIVE
 * campaign. The D184/D192 mix still uses this set:
 * `insightRequiresExisting` on restore/fan-out so a seat that
 * left Insight is not put back from ACTIVE SalesGlider staff.
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
  if (
    campaign.client_id !== SALESGLIDER_CLIENT_ID &&
    campaign.client_id !== INSIGHT_CLIENT_ID
  ) {
    return false;
  }
  return String(campaign.name ?? "").startsWith("Insight ");
}

export function campaignIsActive(
  campaign: { status?: string | null } | undefined,
): boolean {
  return String(campaign?.status ?? "").toUpperCase() === "ACTIVE";
}

/**
 * Named Insight campaign, or (when sequences are in hand) any campaign
 * whose copy contains the capital-I `Insight` needle. Name-only does
 * not count — "Insight Pipeline A" without Insight in the body is
 * still a SalesGlider campaign (D192).
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
 * across leftover 345263 Insight ids, and never onto ACTIVE SG.
 * ACTIVE SG staff never attach to Insight. D282 — Insight live
 * campaigns also refuse any sender that is not a Josh Osborn mailbox
 * on a salesglider* or Insight domain. Client 582890 Josh seats
 * restaff after A/B rest without already sitting on Insight; min40
 * never backfills the 40 floor.
 */
export function canAttachMailboxToCampaign(
  account: SmartleadAccountWithCampaigns,
  target: SmartleadCampaign,
  campaignById: Map<number, SmartleadCampaign>,
  opts?: { insightRequiresExisting?: boolean },
): boolean {
  // D283 — CornerStone client seats and HOLD-UNTIL never attach,
  // including onto EMCOR / TechEvo campaign-fill. Shells stay open
  // for instrumentation only when the seat is not hold-blocked.
  if (isAttachForbiddenSeat(account)) return false;
  if (isDoNotRelinkPair(insightSenderEmail(account), target.id)) return false;
  if (isAnyShellCampaign(target)) return true;
  if (isInsightJoshOnlyCampaign(target) || isInsightCampaignId(target.id)) {
    if (!isInsightJoshAllowedSender(account)) return false;
    if (mailboxStaffsActiveSalesGlider(account, campaignById)) return false;
    // D184 leftover: named Insight ids still sitting in 345263 are not
    // default SalesGlider fan-out. Client 582890 Josh seats are the
    // Insight fleet — restaff them after A/B rest (D229), never require
    // they already sit on an Insight campaign.
    if (
      opts?.insightRequiresExisting &&
      !isInsightClientId(target.client_id)
    ) {
      return mailboxInsightCampaignIds(account, campaignById).length > 0;
    }
    return true;
  }
  if (isActiveSalesGliderCampaign(target)) {
    return mailboxInsightCampaignIds(account, campaignById).length === 0;
  }
  return true;
}

/**
 * Empty, whitespace, Josh Osborn / Insight, or the D255 three-line
 * mailbox sign-off (Josh Osborn / Strategic Account Executive / Insight).
 */
export function insightMailboxSignatureAllowed(
  signature?: string | null,
): boolean {
  const lines = extractSignatureLines(signature);
  if (lines.length === 0) return true;
  if (
    lines.length === 3 &&
    /^josh\s+osborn$/i.test(lines[0]!) &&
    lines[1] === INSIGHT_MAILBOX_TITLE &&
    lines[2] === INSIGHT_CLOSE_BRAND
  ) {
    return true;
  }
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
