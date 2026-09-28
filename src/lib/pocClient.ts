/**
 * D81 / D82 / D204 — a POC client is a flag, not a pile of Goliath-named
 * rules. Goliath (548611) is the rotating-pool owner. PowerGryd (592842)
 * is also a POC (dedicated 40, no pods, leave-alone). Floor, signatures,
 * and canaries are the same for every *normal* client.
 */

import {
  isPowerGrydClientId,
  isPowerGrydHay,
  POWERGRYD_CLIENT_ID,
} from "./powerGryd.js";

export const GOLIATH_CLIENT_ID = 548611;

export const POC_CLIENT_IDS: readonly number[] = [
  GOLIATH_CLIENT_ID,
  POWERGRYD_CLIENT_ID,
];

export function isPocClientId(id: number | null | undefined): boolean {
  return id === GOLIATH_CLIENT_ID || isPowerGrydClientId(id);
}

export function isPocClient(
  hay: string,
  patterns: string[] = ["goliath"],
): boolean {
  if (isPowerGrydHay(hay)) return true;
  const text = hay.toLowerCase();
  return patterns.some((pattern) => {
    const needle = pattern.trim().toLowerCase();
    return Boolean(needle) && text.includes(needle);
  });
}

/**
 * Rotating-pool owner. Always Goliath when that client is in the book.
 * PowerGryd is a POC but never becomes genericOwnerId (D76 / D204) —
 * that would rewrite leftover pool client_ids onto 592842.
 */
export function pocClientId(
  clients: Array<{ id: number; name?: string | null; logo?: string | null }>,
  patterns: string[] = ["goliath"],
): number | null {
  for (const client of clients) {
    if (client.id === GOLIATH_CLIENT_ID) return client.id;
    const hay = `${client.name ?? ""} ${client.logo ?? ""}`;
    if (isPocClient(hay, ["goliath"]) || isPocClient(hay, patterns)) {
      if (isPowerGrydClientId(client.id) || isPowerGrydHay(hay)) continue;
      return client.id;
    }
  }
  return null;
}
