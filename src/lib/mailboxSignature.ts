/**
 * Fleet mailbox signatures are plain two-line text:
 *   First Last
 *   {Client Brand}
 *
 * Smartlead sometimes stores the same content as HTML `<div>` pairs; we
 * normalize those back to newlines so every inbox matches the UI format.
 */

import { normalizeName } from "./nameMatch.js";

export function extractSignatureLines(signature?: string | null): string[] {
  const raw = (signature ?? "").trim();
  if (!raw) return [];

  if (/<(div|p|br)/i.test(raw)) {
    const withBreaks = raw.replace(/<br\s*\/?>/gi, "\n");
    const blocks = [
      ...withBreaks.matchAll(/<(?:div|p)[^>]*>(.*?)<\/(?:div|p)>/gis),
    ].map((m) => m[1]!.replace(/<[^>]+>/g, "").trim()).filter(Boolean);
    if (blocks.length) return blocks;
    return withBreaks
      .replace(/<[^>]+>/g, "")
      .split(/\n/)
      .map((l) => l.trim())
      .filter(Boolean);
  }

  return raw
    .split(/\n/)
    .map((l) => l.trim())
    .filter(Boolean);
}

function brandAcronym(normalized: string): string {
  return normalized
    .split(" ")
    .filter(Boolean)
    .map((word) => word[0] ?? "")
    .join("");
}

/**
 * True when two brand strings name the same client — exact, substring of a
 * longer legal name, or acronym ("MSRS" vs "Mid-South Roof Systems").
 */
export function isSameBrand(a?: string | null, b?: string | null): boolean {
  const left = normalizeName(a ?? "");
  const right = normalizeName(b ?? "");
  if (!left || !right) return false;
  if (left === right) return true;
  const shorter = left.length <= right.length ? left : right;
  const longer = left.length <= right.length ? right : left;
  if (shorter.length >= 4 && longer.includes(shorter)) return true;
  if (brandAcronym(longer) === shorter) return true;
  return false;
}

function isOtherClientBrand(
  existing: string,
  thisBrand: string,
  otherClientBrands: string[],
): boolean {
  if (isSameBrand(existing, thisBrand)) return false;
  return otherClientBrands.some(
    (brand) => brand.trim() && isSameBrand(existing, brand),
  );
}

/**
 * Brand line for signature: prefer an existing second line when it is the
 * same client (so "Mid-South Roof Systems" is kept over logo "MSRS"). A
 * second line that belongs to a *different* known client is discarded and
 * replaced with this mailbox's client brand.
 */
export function resolveSignatureBrand(opts: {
  signature?: string | null;
  clientBrand?: string | null;
  otherClientBrands?: string[];
}): string {
  const lines = extractSignatureLines(opts.signature);
  const fromSig = lines[1]?.trim() ?? "";
  const clientBrand = (opts.clientBrand ?? "").trim();
  if (
    fromSig &&
    clientBrand &&
    isOtherClientBrand(fromSig, clientBrand, opts.otherClientBrands ?? [])
  ) {
    return clientBrand;
  }
  if (fromSig) return fromSig;
  return clientBrand;
}

/**
 * Target signature for a mailbox, or null when we cannot form a two-line
 * Name/Brand pair (e.g. unassigned pool inventory with an empty signature).
 */
export function desiredMailboxSignature(opts: {
  fromName?: string | null;
  signature?: string | null;
  clientBrand?: string | null;
  otherClientBrands?: string[];
}): string | null {
  const name = (opts.fromName ?? "").trim();
  if (!name) return null;
  const brand = resolveSignatureBrand(opts);
  if (!brand) return null;
  return `${name}\n${brand}`;
}

/** Strip "Logo (Person)" client display names down to the brand/logo. */
export function brandFromClientDisplayName(clientName: string): string {
  return clientName.replace(/\s*\(.*?\)\s*$/, "").trim() || clientName.trim();
}
