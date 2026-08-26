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
      : sequence.seq_variants?.length
        ? sequence.seq_variants
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
    if (sequence.seq_variants?.length) {
      out.seq_variants = sequence.seq_variants.map((variant, index) => ({
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

/** GET extras Smartlead rejects on POST /sequences. */
const SEQUENCE_WRITE_OMIT = new Set([
  "created_at",
  "updated_at",
  "createdAt",
  "updatedAt",
  "email_campaign_id",
  "emailCampaignId",
]);

/**
 * Documented writable sequence / variant keys. GET returns more
 * (timestamps, email_campaign_id). After D101 stripped timestamps,
 * live 2026-08-26 then rejected email_campaign_id — keep only these.
 */
const SEQUENCE_WRITE_KEEP = new Set([
  "id",
  "seq_number",
  "subject",
  "email_body",
  "seq_delay_details",
  "seq_variants",
  "variant_distribution_type",
  "variant_label",
  "variant_name",
]);

/**
 * D101 / D103 / D104 / D110 — Smartlead POST /sequences rejects
 * GET-only fields (`created_at`, `email_campaign_id`) and GET's
 * `sequence_variants` key. Live 2026-08-26 then rejected `variants`
 * too (`"sequences[0].variants" is not allowed`). Keep the writable
 * set, remap GET variants onto `seq_variants`, and never send
 * `variants` or `sequence_variants`.
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
    if (key === "sequence_variants" || key === "variants") continue;
    if (!SEQUENCE_WRITE_KEEP.has(key)) continue;
    if (key === "seq_variants" && Array.isArray(value)) {
      out[key] = value.map((variant) => omitReadonlySequence(variant as SmartleadSequence));
      continue;
    }
    out[key] = value;
  }
  const raw = row as SmartleadSequence & {
    sequence_variants?: unknown;
    seq_variants?: unknown;
  };
  if (out.seq_variants == null) {
    const source = Array.isArray(raw.seq_variants)
      ? raw.seq_variants
      : Array.isArray(raw.sequence_variants)
        ? raw.sequence_variants
        : Array.isArray(raw.variants)
          ? raw.variants
          : null;
    if (source) {
      out.seq_variants = source.map((variant) =>
        omitReadonlySequence(variant as SmartleadSequence),
      );
    }
  }
  return out as unknown as SmartleadSequence;
}
