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

/**
 * D85 — the one-click signature fix. Appends `%signature%` to every step /
 * variant body that has copy but no tag. Appends only; never rewrites,
 * reorders, or touches subjects. Empty bodies and bodies that already carry
 * the tag are left exactly as they were.
 */
export function appendSignatureTag(sequences: SmartleadSequence[]): {
  sequences: SmartleadSequence[];
  changed: string[];
} {
  const changed: string[] = [];
  const fixBody = (body: string | undefined, label: string): string | undefined => {
    const text = String(body ?? "");
    if (!missingSignatureTag(text)) return body;
    changed.push(label);
    return `${text}<br><br>%signature%`;
  };
  const next = sequences.map((sequence) => {
    const out: SmartleadSequence = { ...sequence };
    if (sequence.sequence_variants?.length) {
      out.sequence_variants = sequence.sequence_variants.map((variant, index) => ({
        ...variant,
        email_body: fixBody(
          variant.email_body,
          `step ${sequence.seq_number} ${variant.variant_label ?? String.fromCharCode(65 + index)}`,
        ),
      }));
    }
    if (sequence.variants?.length) {
      out.variants = sequence.variants.map((variant, index) => ({
        ...variant,
        email_body: fixBody(
          variant.email_body,
          `step ${sequence.seq_number} ${variant.variant_label ?? String.fromCharCode(65 + index)}`,
        ),
      }));
    }
    out.email_body = fixBody(sequence.email_body, `step ${sequence.seq_number}`);
    return out;
  });
  return { sequences: next, changed };
}

const SEQUENCE_WRITE_OMIT = new Set([
  "created_at",
  "updated_at",
  "createdAt",
  "updatedAt",
]);

/**
 * D101 — Smartlead POST /sequences rejects read-only timestamps
 * (`"sequences[0].created_at" is not allowed`). Strip them (and the
 * same on variants) before every write.
 */
export function sequencesForWrite(
  sequences: SmartleadSequence[],
): SmartleadSequence[] {
  return sequences.map((sequence) => omitReadonlySequence(sequence));
}

function omitReadonlySequence(row: SmartleadSequence): SmartleadSequence {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    if (SEQUENCE_WRITE_OMIT.has(key)) continue;
    if (
      (key === "sequence_variants" || key === "variants") &&
      Array.isArray(value)
    ) {
      out[key] = value.map((variant) => omitReadonlySequence(variant as SmartleadSequence));
      continue;
    }
    out[key] = value;
  }
  return out as unknown as SmartleadSequence;
}
