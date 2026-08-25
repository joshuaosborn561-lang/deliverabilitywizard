/**
 * Fleet mailbox signatures are plain two-line text:
 *   First Last
 *   {Client Brand}
 *
 * Smartlead sometimes stores the same content as HTML `<div>` pairs; we
 * normalize those back to newlines so every inbox matches the UI format.
 */

import { findForeignBrand } from "./clientBrand.js";

export { brandFromClientDisplayName } from "./clientBrand.js";

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

/**
 * Brand line for signature: prefer an existing second line (so HTML brands
 * like "Mid-South Roof Systems" are preserved) unless that line is another
 * known client (D74). Else the Smartlead client logo.
 */
export function resolveSignatureBrand(opts: {
  signature?: string | null;
  clientBrand?: string | null;
  otherClientBrands?: string[];
}): string {
  const lines = extractSignatureLines(opts.signature);
  const fromSig = lines[1]?.trim() ?? "";
  const clientBrand = (opts.clientBrand ?? "").trim();
  if (fromSig) {
    const foreign = findForeignBrand(fromSig, clientBrand, opts.otherClientBrands ?? []);
    if (foreign && clientBrand) return clientBrand;
    return fromSig;
  }
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

