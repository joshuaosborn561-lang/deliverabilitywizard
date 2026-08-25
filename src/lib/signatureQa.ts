/**
 * D74 — a mailbox or sequence must not carry another client's brand.
 *
 * D31 still wants a two-line Name / Brand signature and still preserves a
 * richer same-client brand line (Mid-South Roof Systems vs MSRS). It does
 * not preserve a leftover Peterson line on a Goliath send.
 */

import type { SmartleadSequence } from "../types/index.js";
import { extractSignatureLines } from "./mailboxSignature.js";

export {
  brandInText,
  clientBrandList,
  findForeignBrand,
  normalizeBrand,
} from "./clientBrand.js";

export function signatureHay(opts: {
  fromName?: string | null;
  signature?: string | null;
}): string {
  const lines = extractSignatureLines(opts.signature);
  return [opts.fromName ?? "", ...lines].filter(Boolean).join("\n");
}

export function sequenceCopyHay(sequences: SmartleadSequence[]): Array<{
  label: string;
  text: string;
}> {
  const out: Array<{ label: string; text: string }> = [];
  for (const sequence of sequences) {
    const variants = sequence.sequence_variants?.length
      ? sequence.sequence_variants
      : sequence.variants?.length
        ? sequence.variants
        : [{ email_body: sequence.email_body, subject: sequence.subject }];
    variants.forEach((variant, index) => {
      const body = String(variant.email_body ?? sequence.email_body ?? "");
      const subject = String(variant.subject ?? sequence.subject ?? "");
      const label = `step ${sequence.seq_number} ${variant.variant_label ?? String.fromCharCode(65 + index)}`;
      out.push({ label, text: `${subject}\n${body}` });
    });
  }
  return out;
}

export function missingSignatureTag(html: string): boolean {
  if (!html.replace(/<[^>]+>/g, " ").trim()) return false;
  return !/%signature%/i.test(html);
}
