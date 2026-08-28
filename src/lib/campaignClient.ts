import {
  clientDisplayName,
  type SmartleadClientRecord,
} from "../clients/smartlead.js";
import { brandFromClientDisplayName, normalizeBrand } from "./clientBrand.js";

/**
 * Distinctive needles for matching a campaign name to a Smartlead client.
 * Short tokens (BCP, MSRS) stay if they are the whole brand acronym.
 */
export function clientMatchNeedles(client: SmartleadClientRecord): string[] {
  const pieces = [
    brandFromClientDisplayName(clientDisplayName(client)),
    client.logo ?? "",
    client.name ?? "",
  ];
  const generic = new Set([
    "tech",
    "offer",
    "sports",
    "group",
    "other",
    "with",
    "team",
    "firms",
    "airpods",
    "tickets",
  ]);
  const needles = new Set<string>();
  for (const piece of pieces) {
    const normalized = normalizeBrand(piece);
    if (!normalized) continue;
    if (normalized.length >= 5) needles.add(normalized);
    else if (
      normalized.length >= 3 &&
      !normalized.includes(" ") &&
      !generic.has(normalized)
    ) {
      // Whole-logo acronyms (MSRS, BCP) used to produce zero needles
      // because the floor was 5. "MSRS2 Ticket Offer…" then never tagged.
      needles.add(normalized);
    }
    for (const token of normalized.split(" ").filter((row) => row.length >= 5 && !generic.has(row))) {
      needles.add(token);
    }
    const initials = normalized
      .split(" ")
      .filter((row) => row.length)
      .map((row) => row[0])
      .join("");
    if (initials.length >= 3 && !generic.has(initials)) needles.add(initials);
  }
  return [...needles];
}

/** Smartlead list payloads sometimes send client_id as a string. */
export function numericClientId(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return value;
  }
  if (typeof value === "string" && /^\d+$/.test(value.trim())) {
    const parsed = Number(value.trim());
    return parsed > 0 ? parsed : null;
  }
  return null;
}

/**
 * D144 restored Nieto / MSRS / Positive campaigns after D61 wiped their
 * inboxes — and often the Smartlead client row too. The tagger may
 * ensure these three (only) so a unique name match has something to
 * write. Anything else stays on the EOD brief (D85).
 */
export const RESTORED_CLIENT_BRANDS = [
  {
    brand: "Nieto",
    email: "nieto-client@salesglidergrowth.com",
    pattern: /\bnieto\b/i,
  },
  {
    brand: "MSRS",
    email: "msrs-client@salesglidergrowth.com",
    pattern: /\bmsrs\d*\b/i,
  },
  {
    brand: "Positive",
    email: "positive-client@salesglidergrowth.com",
    pattern: /^positive\b/i,
  },
] as const;

export function restoredClientBrand(
  campaignName: string,
): (typeof RESTORED_CLIENT_BRANDS)[number] | null {
  const hits = RESTORED_CLIENT_BRANDS.filter((row) =>
    row.pattern.test(String(campaignName ?? "")),
  );
  return hits.length === 1 ? hits[0]! : null;
}

/** Unique Smartlead client whose brand appears in the campaign name. */
export function matchClientForCampaign(
  campaignName: string,
  clients: SmartleadClientRecord[],
): SmartleadClientRecord | null {
  const hay = normalizeBrand(campaignName);
  if (!hay) return null;
  const hits: SmartleadClientRecord[] = [];
  for (const client of clients) {
    const needles = clientMatchNeedles(client);
    if (needles.some((needle) => hay === needle || hay.includes(needle))) {
      hits.push(client);
    }
  }
  const unique = [...new Map(hits.map((client) => [client.id, client])).values()];
  return unique.length === 1 ? unique[0]! : null;
}
