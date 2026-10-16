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

export function desiredMailboxSignature(opts: {
  fromName?: string | null;
  clientBrand?: string | null;
  tags?: readonly string[];
}): string | null {
  if (hasTag(opts.tags ?? [], CALLER_FOLLOWUP_SENDER_TAG)) return "";
  const name = (opts.fromName ?? "").trim();
  const brand = (opts.clientBrand ?? "").trim();
  if (!name || !brand) return null;
  return `${name}\n${brand}`;
}

export function mailboxSignatureMismatch(opts: {
  fromName?: string | null;
  signature?: string | null;
  clientBrand?: string | null;
  tags?: readonly string[];
}): string | null {
  if (hasTag(opts.tags ?? [], CALLER_FOLLOWUP_SENDER_TAG)) return null;
  const desired = desiredMailboxSignature(opts);
  if (desired === null) return null;
  const actual = extractSignatureLines(opts.signature).join("\n");
  const want = extractSignatureLines(desired).join("\n");
  if (actual === want) return null;
  if (!actual) return "has no signature (want First Last / client brand)";
  return `signature is ${actual.replace(/\n/g, " / ")} (want ${want.replace(/\n/g, " / ")})`;
}

/** D255 — Insight sequences keep %signature%; never write in-body Josh Osborn / Insight. */
export function insightSequenceIllegal(body: string): boolean {
  return /Josh Osborn[\s\S]{0,80}Insight/i.test(body) && !/%signature%|{{Signature}}/i.test(body);
}
