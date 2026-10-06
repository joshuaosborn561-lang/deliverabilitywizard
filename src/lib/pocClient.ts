/**
 * D81 / D82 / D236 — one name-pattern list says who is a POC.
 * Goliath stays on that list for D81 generic-allow / QA-unpause / hold,
 * but is not a 60-seat no-POD engagement (D223 / Oct 15 hold).
 * Deep Roots (and later name-list matches except Goliath) are
 * engagement POCs: 60 seats, no PODs, survive DRAFTED, fill without
 * an Allow-generics card, release only when marked done.
 */

import { GOLIATH_CLIENT_ID } from "./holdPolicy.js";

export const DEFAULT_POC_CLIENT_NAME_PATTERNS = ["goliath", "deep roots"] as const;

export const DEEP_ROOTS_CLIENT_ID = 597783;

/** Gabe's post-call shell on Deep Roots — never staff (D236). */
export const GABE_POST_CALL_CAMPAIGN_ID = 4074266;

export const POC_ENGAGEMENT_SEAT_TARGET = 60;

export const POC_LIVING_STATUSES = [
  "ACTIVE",
  "START",
  "DRAFT",
  "DRAFTED",
] as const;

export { GOLIATH_CLIENT_ID };

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

export function pocClientHay(client: {
  name?: string | null;
  logo?: string | null;
}): string {
  return `${client.name ?? ""} ${client.logo ?? ""}`;
}

export function pocClientId(
  clients: Array<{ id: number; name?: string | null; logo?: string | null }>,
  patterns: string[] = [...DEFAULT_POC_CLIENT_NAME_PATTERNS],
): number | null {
  for (const client of clients) {
    if (isPocClient(pocClientHay(client), patterns)) return client.id;
  }
  return null;
}

export function isGoliathClientId(clientId: number | null | undefined): boolean {
  return clientId === GOLIATH_CLIENT_ID;
}

export function isGabePostCallCampaign(
  campaignId: number | null | undefined,
): boolean {
  return campaignId === GABE_POST_CALL_CAMPAIGN_ID;
}

export function isPocLivingCampaignStatus(
  status: string | null | undefined,
): boolean {
  const value = String(status ?? "").toUpperCase();
  return (POC_LIVING_STATUSES as readonly string[]).includes(value);
}

/**
 * Name-list match, not Goliath, not marked done. This is the 60-seat
 * no-POD engagement — not D81's "may take generics" flag.
 */
export function isPocEngagementClient(input: {
  clientId?: number | null;
  hay?: string;
  name?: string | null;
  logo?: string | null;
  patterns?: string[];
  endedIds?: Iterable<number>;
}): boolean {
  const id = input.clientId;
  if (typeof id !== "number" || !Number.isFinite(id) || id <= 0) return false;
  if (isGoliathClientId(id)) return false;
  const ended = new Set(
    [...(input.endedIds ?? [])].filter((n) => Number.isFinite(n) && n > 0),
  );
  if (ended.has(id)) return false;
  const hay = input.hay ?? pocClientHay({ name: input.name, logo: input.logo });
  return isPocClient(hay, input.patterns ?? [...DEFAULT_POC_CLIENT_NAME_PATTERNS]);
}

export function pocEngagementClientIds(
  clients: Array<{ id: number; name?: string | null; logo?: string | null }>,
  patterns: string[] = [...DEFAULT_POC_CLIENT_NAME_PATTERNS],
  endedIds: Iterable<number> = [],
): number[] {
  return clients
    .filter((client) =>
      isPocEngagementClient({
        clientId: client.id,
        name: client.name,
        logo: client.logo,
        patterns,
        endedIds,
      }),
    )
    .map((client) => client.id);
}

/** Living POC campaign we may staff — not Gabe's post-call shell. */
export function shouldStaffPocCampaign(campaign: {
  id?: number | null;
  status?: string | null;
}): boolean {
  if (isGabePostCallCampaign(campaign.id)) return false;
  return isPocLivingCampaignStatus(campaign.status);
}

export function pocEngagementSeatTarget(): number {
  return POC_ENGAGEMENT_SEAT_TARGET;
}

/**
 * POC signature is the mailbox from_name plus the full client brand.
 * Deep Roots: `<from_name>\nDeep Roots Capital`.
 */
export function pocSignature(fromName: string, brand: string): string {
  const name = fromName.trim();
  const clientBrand = brand.trim();
  if (!name) throw new Error("fromName is required for POC signature");
  if (!clientBrand) throw new Error("clientBrand is required for POC signature");
  return `${name}\n${clientBrand}`;
}
