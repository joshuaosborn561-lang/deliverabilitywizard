/**
 * D325 — Jeremy Ciotola seats are their own client even though they
 * sit under Smartlead SalesGlider 345263 (no Ciotola client exists).
 *
 * Tag `JEREMY-CIOTOLA` (id 533700) is only eligible for Ciotola
 * campaigns, whether the seat also carries POD-A, POD-B, or no
 * POD tag. Non-Jeremy seats never sit on those campaigns, except
 * Gabe Calls | Ciotola #4236534 which keeps its GABE-VM-RESERVED
 * seats. POD counts treat Ciotola as its own client so the 38
 * Jeremy inboxes do not inflate SalesGlider's 40/POD cylinder.
 */

const GABE_VM_RESERVED_TAG = "GABE-VM-RESERVED";

/** Local — importing markerClients cycles through clientNamedDomain → insightCampaigns. */
function tagNamesOf(account: CiotolaTagAccount | null | undefined): string[] {
  return (account?.tags ?? []).map((tag) =>
    String(tag.tag_name ?? tag.name ?? "").trim(),
  );
}

function seatHasGabeVmReserved(account: CiotolaTagAccount): boolean {
  return tagNamesOf(account).some(
    (name) => name.toUpperCase() === GABE_VM_RESERVED_TAG,
  );
}

export const JEREMY_CIOTOLA_TAG = "JEREMY-CIOTOLA";
export const JEREMY_CIOTOLA_TAG_ID = 533700;

/**
 * D328 — mailbox signature for a Ciotola sender. Exactly this
 * string: no SalesGlider line, no agency footer, no brand line.
 * These seats still live under Smartlead client 345263.
 */
export const CIOTOLA_MAILBOX_SIGNATURE = "Jeremy Ciotola";

/** Tag JEREMY-CIOTOLA, or the sender name is exactly that signature. */
export function ciotolaNameOnlySignature(input: {
  account?: CiotolaTagAccount | null;
  fromName?: string | null;
}): boolean {
  if (isJeremyCiotolaSeat(input.account)) return true;
  return (input.fromName ?? "").trim() === CIOTOLA_MAILBOX_SIGNATURE;
}

/**
 * Virtual owner for POD counts / rest / fan-out. Not a Smartlead
 * client record — Ciotola campaigns still carry `client_id` 345263.
 */
export const CIOTOLA_CLIENT_ID = 900345263;
export const CIOTOLA_CLIENT_NAME = "Ciotola";
export const CIOTOLA_FANOUT_GROUP = "ciotola";

export const CIOTOLA_CAMPAIGN_IDS = [
  4289735, 4289736, 4289737, 4289738, 4236534,
] as const;

export const GABE_CALLS_CIOTOLA_ID = 4236534;

export const CIOTOLA_NAME_PREFIXES = ["Ciotola", "Gabe Calls | Ciotola"] as const;

const CIOTOLA_ID_SET = new Set<number>(CIOTOLA_CAMPAIGN_IDS);

export type CiotolaTagAccount = {
  tags?: Array<{
    id?: number | null;
    tag_id?: number | null;
    tag_name?: unknown;
    name?: unknown;
  }> | null;
};

export type CiotolaCampaign = {
  id?: number | null;
  name?: string | null;
} | null | undefined;

export function isJeremyCiotolaSeat(
  account: CiotolaTagAccount | null | undefined,
): boolean {
  if (!account) return false;
  for (const tag of account.tags ?? []) {
    const id = Number(tag.id ?? tag.tag_id);
    if (id === JEREMY_CIOTOLA_TAG_ID) return true;
  }
  return tagNamesOf(account).some(
    (name) => name.toUpperCase() === JEREMY_CIOTOLA_TAG,
  );
}

export function isCiotolaCampaign(campaign: CiotolaCampaign): boolean {
  if (!campaign) return false;
  const id = Number(campaign.id);
  if (Number.isFinite(id) && CIOTOLA_ID_SET.has(id)) return true;
  const name = String(campaign.name ?? "");
  return CIOTOLA_NAME_PREFIXES.some((prefix) => name.startsWith(prefix));
}

export function isGabeCallsCiotolaCampaign(campaign: CiotolaCampaign): boolean {
  if (!campaign) return false;
  const id = Number(campaign.id);
  if (id === GABE_CALLS_CIOTOLA_ID) return true;
  return String(campaign.name ?? "").startsWith("Gabe Calls | Ciotola");
}

export function ciotolaOwnedClientId(
  account: CiotolaTagAccount | null | undefined,
): number | null {
  return isJeremyCiotolaSeat(account) ? CIOTOLA_CLIENT_ID : null;
}

export function isCiotolaClientId(id: number | null | undefined): boolean {
  return id === CIOTOLA_CLIENT_ID;
}

export function ciotolaExemptFromSenderTopUp(campaign: CiotolaCampaign): boolean {
  return isCiotolaCampaign(campaign);
}

export function ciotolaExemptFromGenericTopUp(
  clientId: number | null | undefined,
): boolean {
  return isCiotolaClientId(clientId);
}

export type CiotolaAttachDecision =
  | { ok: true; reason: string }
  | { ok: false; reason: string };

/**
 * Attach gate for every staffing path.
 *
 * Jeremy → Ciotola campaigns only (including Gabe Calls | Ciotola).
 * Non-Jeremy → never Ciotola, except GABE-VM-RESERVED on #4236534.
 */
export function ciotolaMayAttach(input: {
  account: CiotolaTagAccount & {
    from_email?: string | null;
    email?: string | null;
    id?: number | null;
  };
  campaign: CiotolaCampaign;
}): CiotolaAttachDecision {
  const jeremy = isJeremyCiotolaSeat(input.account);
  const ciotola = isCiotolaCampaign(input.campaign);
  if (jeremy && ciotola) {
    return { ok: true, reason: "JEREMY-CIOTOLA on Ciotola campaign (D325)" };
  }
  if (jeremy) {
    return {
      ok: false,
      reason: "JEREMY-CIOTOLA never fans out of Ciotola (D325)",
    };
  }
  if (!ciotola) {
    return { ok: true, reason: "not a Ciotola attach" };
  }
  if (
    isGabeCallsCiotolaCampaign(input.campaign) &&
    seatHasGabeVmReserved(input.account)
  ) {
    return {
      ok: true,
      reason: "GABE-VM-RESERVED on Gabe Calls | Ciotola (D325)",
    };
  }
  return { ok: false, reason: "non-Jeremy never sits on Ciotola (D325)" };
}

/** Campaign ids a JEREMY-CIOTOLA seat must leave (non-Ciotola, non-shell). */
export function ciotolaCrossoverCampaignIds(input: {
  account: CiotolaTagAccount;
  memberships: Iterable<{
    campaignId: number;
    shell?: boolean;
    protected?: boolean;
    name?: string | null;
    campaign?: CiotolaCampaign;
  }>;
}): number[] {
  if (!isJeremyCiotolaSeat(input.account)) return [];
  const out: number[] = [];
  for (const row of input.memberships) {
    if (row.shell || row.protected) continue;
    const campaign = row.campaign ?? {
      id: row.campaignId,
      name: row.name,
    };
    if (isCiotolaCampaign(campaign)) continue;
    out.push(row.campaignId);
  }
  return out;
}

/** Non-Jeremy seats that must leave a regular Ciotola campaign. */
export function ciotolaStrayCampaignIds(input: {
  account: CiotolaTagAccount & {
    from_email?: string | null;
    email?: string | null;
    id?: number | null;
  };
  memberships: Iterable<{
    campaignId: number;
    shell?: boolean;
    protected?: boolean;
    name?: string | null;
    campaign?: CiotolaCampaign;
  }>;
}): number[] {
  if (isJeremyCiotolaSeat(input.account)) return [];
  const out: number[] = [];
  for (const row of input.memberships) {
    if (row.shell) continue;
    const campaign = row.campaign ?? {
      id: row.campaignId,
      name: row.name,
    };
    if (!isCiotolaCampaign(campaign)) continue;
    if (ciotolaMayAttach({ account: input.account, campaign }).ok) continue;
    out.push(row.campaignId);
  }
  return out;
}
