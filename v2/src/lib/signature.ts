import { CALLER_FOLLOWUP_SENDER_TAG } from "../canon/constants.js";
import { hasTag } from "./staffable.js";

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

/** Strip "Logo (Person)" client display names down to the brand/logo (old wizard clientBrand.ts). */
export function brandFromClientDisplayName(clientName: string): string {
  return clientName.replace(/\s*\(.*?\)\s*$/, "").trim() || clientName.trim();
}

/** Old wizard clientDisplayName: "Logo (Name)" when both differ, else logo or name. */
export function clientDisplayName(client?: { name?: string | null; logo?: string | null }): string {
  const logo = client?.logo?.trim();
  const name = client?.name?.trim();
  if (logo && name && logo.toLowerCase() !== name.toLowerCase()) return `${logo} (${name})`;
  return logo || name || "";
}

/** Brand line for a Smartlead client record, or "" when the record has none. */
export function clientBrandFromRecord(client?: { name?: string | null; logo?: string | null }): string {
  const display = clientDisplayName(client);
  return display ? brandFromClientDisplayName(display) : "";
}

export function clientBrandList(clients: ReadonlyArray<{ name?: string | null; logo?: string | null }>): string[] {
  const out = new Set<string>();
  for (const client of clients) {
    const brand = clientBrandFromRecord(client);
    if (brand) out.add(brand);
    const logo = client.logo?.trim();
    if (logo) out.add(logo);
    const name = client.name?.trim();
    if (name && name.length >= 5) out.add(name);
  }
  return [...out];
}

export function normalizeBrand(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

export function brandInText(hay: string, brand: string): boolean {
  const text = normalizeBrand(hay);
  const needle = normalizeBrand(brand);
  if (!text || !needle || needle.length < 5) return false;
  if (text === needle || text.includes(needle)) return true;
  const tokens = needle.split(" ").filter((token) => token.length >= 4);
  return tokens.length >= 2 && tokens.every((token) => text.includes(token));
}

export function findForeignBrand(hay: string, ownBrand: string, allBrands: readonly string[]): string | null {
  const others = allBrands.filter(
    (brand) => brand && !brandInText(ownBrand, brand) && !brandInText(brand, ownBrand),
  );
  const hits = others
    .filter((brand) => brandInText(hay, brand))
    .sort((a, b) => normalizeBrand(b).length - normalizeBrand(a).length);
  return hits[0] ?? null;
}

/**
 * Old wizard D74 rule, ported: keep the mailbox's existing brand line unless
 * it names another known client; else use the Smartlead client brand. The
 * campaign name is never a brand (D298: shadow planned "Name / <campaign>").
 */
export function resolveSignatureBrand(opts: {
  signature?: string | null;
  clientBrand?: string | null;
  otherClientBrands?: readonly string[];
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
 * Target two-line "First Last / Client Brand" signature, or null when we
 * cannot form a real pair (never a placeholder). Caller follow-up seats: "".
 */
export function desiredMailboxSignature(opts: {
  fromName?: string | null;
  signature?: string | null;
  clientBrand?: string | null;
  otherClientBrands?: readonly string[];
  tags?: readonly string[];
}): string | null {
  if (hasTag(opts.tags ?? [], CALLER_FOLLOWUP_SENDER_TAG)) return "";
  const name = (opts.fromName ?? "").trim();
  if (!name) return null;
  const brand = resolveSignatureBrand(opts);
  if (!brand) return null;
  return `${name}\n${brand}`;
}

export interface SignatureMismatch {
  reason: string;
  /** Exact text a signature_write would set. Never a template. */
  desired: string;
}

export function signatureMismatch(opts: {
  fromName?: string | null;
  signature?: string | null;
  clientBrand?: string | null;
  otherClientBrands?: readonly string[];
  tags?: readonly string[];
}): SignatureMismatch | null {
  if (hasTag(opts.tags ?? [], CALLER_FOLLOWUP_SENDER_TAG)) return null;
  const desired = desiredMailboxSignature(opts);
  if (!desired) return null;
  const actual = extractSignatureLines(opts.signature).join("\n");
  const want = extractSignatureLines(desired).join("\n");
  if (actual === want) return null;
  const target = want.replace(/\n/g, " / ");
  const foreign = findForeignBrand(
    [opts.fromName ?? "", actual].filter(Boolean).join("\n"),
    opts.clientBrand ?? "",
    opts.otherClientBrands ?? [],
  );
  if (foreign) return { reason: `carries ${foreign} (want ${target})`, desired };
  if (!actual) return { reason: `has no signature (want ${target})`, desired };
  return { reason: `signature is ${actual.replace(/\n/g, " / ")} (want ${target})`, desired };
}

export function mailboxSignatureMismatch(opts: Parameters<typeof signatureMismatch>[0]): string | null {
  return signatureMismatch(opts)?.reason ?? null;
}

/** D255 — Insight sequences keep %signature%; never write in-body Josh Osborn / Insight. */
export function insightSequenceIllegal(body: string): boolean {
  return /Josh Osborn[\s\S]{0,80}Insight/i.test(body) && !/%signature%|{{Signature}}/i.test(body);
}
