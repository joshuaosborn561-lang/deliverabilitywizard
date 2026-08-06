/**
 * Fleet mailbox signatures are plain two-line text:
 *   First Last
 *   {Client Brand}
 *
 * Smartlead sometimes stores the same content as HTML `<div>` pairs; we
 * normalize those back to newlines so every inbox matches the UI format.
 */

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
 * like "Mid-South Roof Systems" are preserved), else the Smartlead client logo.
 */
export function resolveSignatureBrand(opts: {
  signature?: string | null;
  clientBrand?: string | null;
}): string {
  const lines = extractSignatureLines(opts.signature);
  const fromSig = lines[1]?.trim() ?? "";
  if (fromSig) return fromSig;
  return (opts.clientBrand ?? "").trim();
}

/**
 * Target signature for a mailbox, or null when we cannot form a two-line
 * Name/Brand pair (e.g. unassigned pool inventory with an empty signature).
 */
export function desiredMailboxSignature(opts: {
  fromName?: string | null;
  signature?: string | null;
  clientBrand?: string | null;
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
