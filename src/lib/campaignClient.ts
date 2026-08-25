import {
  clientDisplayName,
  type SmartleadClientRecord,
} from "../clients/smartlead.js";
import { brandFromClientDisplayName, normalizeBrand } from "./clientBrand.js";

/**
 * Distinctive needles for matching a campaign name to a Smartlead client.
 * Short tokens (BCP) stay if they are the whole brand acronym.
 */
export function clientMatchNeedles(client: SmartleadClientRecord): string[] {
  const pieces = [
    brandFromClientDisplayName(clientDisplayName(client)),
    client.logo ?? "",
    client.name ?? "",
  ];
  const needles = new Set<string>();
  for (const piece of pieces) {
    const normalized = normalizeBrand(piece);
    if (!normalized) continue;
    if (normalized.length >= 3) needles.add(normalized);
    for (const token of normalized.split(" ").filter((row) => row.length >= 4)) {
      needles.add(token);
    }
    const initials = normalized
      .split(" ")
      .filter((row) => row.length)
      .map((row) => row[0])
      .join("");
    if (initials.length >= 3) needles.add(initials);
  }
  return [...needles];
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
