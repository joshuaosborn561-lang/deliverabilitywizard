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

/** Smartlead / Instantly-style signature placeholders D92 writes. */
const SIGNATURE_PLACEHOLDER = /%signature%|\{\{\s*Signature\s*\}\}/i;

export function missingSignatureTag(html: string): boolean {
  if (!html.replace(/<[^>]+>/g, " ").trim()) return false;
  return !SIGNATURE_PLACEHOLDER.test(html);
}

/**
 * D177 / D178 — exact capital-I substring `Insight` in sequence copy.
 * Not a name-prefix or client-tag match. `insight` / `INSIGHT` alone
 * do not count.
 */
export const INSIGHT_COPY_NEEDLE = "Insight";

/** D178 — plain two-line close written into Insight sequence bodies. */
export const INSIGHT_CLOSE_NAME = "Josh Osborn";
export const INSIGHT_CLOSE_BRAND = "Insight";
export const INSIGHT_CLOSE_HTML = "Josh Osborn<br>Insight";

const PS_START =
  /(?:<(?:div|p|span)[^>]*>\s*)*(?:<br\s*\/?>\s*)*P\.?\s*S\.?\b/i;

export function bodyContainsInsight(
  html: string | null | undefined,
): boolean {
  return String(html ?? "").includes(INSIGHT_COPY_NEEDLE);
}

/** Visible text lines from an HTML sequence body (div/p/br → newlines). */
export function htmlToCopyLines(html: string | null | undefined): string[] {
  return String(html ?? "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(?:div|p)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .split(/\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

/**
 * D178 — the Josh Osborn / Insight close is already in the body as
 * consecutive lines (or a single "Josh Osborn / Insight" line). The
 * word Insight elsewhere in the copy does not count.
 */
export function bodyHasInsightClose(
  html: string | null | undefined,
): boolean {
  const lines = htmlToCopyLines(html);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (
      /^josh\s+osborn$/i.test(line) &&
      lines[i + 1] === INSIGHT_CLOSE_BRAND
    ) {
      return true;
    }
    if (/^josh\s+osborn\s*\/\s*insight$/i.test(line)) return true;
  }
  return false;
}

export function sequencesHaveSignaturePlaceholder(
  sequences: SmartleadSequence[] | null | undefined,
): boolean {
  if (!sequences?.length) return false;
  const hay = sequenceCopyHay(sequences);
  return hay.some((row) => SIGNATURE_PLACEHOLDER.test(row.text));
}

export function sequenceBodiesContainInsight(
  sequences: SmartleadSequence[] | null | undefined,
): boolean {
  if (!sequences?.length) return false;
  for (const sequence of sequences) {
    if (bodyContainsInsight(sequence.email_body)) return true;
    for (const list of [
      sequence.sequence_variants,
      sequence.seq_variants,
      sequence.variants,
    ]) {
      if (!list) continue;
      for (const variant of list) {
        if (bodyContainsInsight(variant.email_body)) return true;
      }
    }
  }
  return false;
}

export function sequencesNeedInsightClose(
  sequences: SmartleadSequence[] | null | undefined,
): boolean {
  if (!sequences?.length) return false;
  if (sequencesHaveSignaturePlaceholder(sequences)) return true;
  for (const sequence of sequences) {
    const bodies: Array<string | undefined> = [sequence.email_body];
    for (const list of [
      sequence.sequence_variants,
      sequence.seq_variants,
      sequence.variants,
    ]) {
      if (!list) continue;
      for (const variant of list) bodies.push(variant.email_body);
    }
    for (const body of bodies) {
      const text = String(body ?? "");
      if (!text.replace(/<[^>]+>/g, " ").trim()) continue;
      if (!bodyHasInsightClose(text)) return true;
    }
  }
  return false;
}

export function stripSignaturePlaceholders(html: string): string {
  let out = String(html ?? "");
  out = out.replace(
    /<(div|p|span)(\s[^>]*)?>\s*(?:%signature%|\{\{\s*Signature\s*\}\})\s*<\/\1>/gi,
    "",
  );
  out = out.replace(
    /(?:<br\s*\/?\s*>\s*){1,2}(?:%signature%|\{\{\s*Signature\s*\}\})/gi,
    "",
  );
  out = out.replace(/%signature%|\{\{\s*Signature\s*\}\}/gi, "");
  return out;
}

/**
 * D177 — drop `%signature%` / `{{Signature}}` from every step / variant
 * body. Subjects are untouched. Bodies without a placeholder stay as-is.
 */
export function stripSignatureTags(sequences: SmartleadSequence[]): {
  sequences: SmartleadSequence[];
  changed: string[];
} {
  const changed: string[] = [];
  const fixBody = (body: string | undefined, label: string): string | undefined => {
    const text = String(body ?? "");
    if (!SIGNATURE_PLACEHOLDER.test(text)) return body;
    changed.push(label);
    return stripSignaturePlaceholders(text);
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

/**
 * D178 — strip SalesGlider mailbox placeholders, then put
 * `Josh Osborn` / `Insight` in the body before any P.S. lines.
 * Does not touch mailbox / email-account fields.
 */
export function ensureInsightClose(html: string): string {
  const stripped = stripSignaturePlaceholders(html);
  if (!stripped.replace(/<[^>]+>/g, " ").trim()) return stripped;
  if (bodyHasInsightClose(stripped)) return stripped;
  const close = `<br><br>${INSIGHT_CLOSE_HTML}`;
  const match = stripped.match(PS_START);
  if (!match || match.index == null) return `${stripped}${close}`;
  const before = stripped
    .slice(0, match.index)
    .replace(/(?:<br\s*\/?>|\s)+$/gi, "");
  const ps = stripped.slice(match.index);
  return `${before}${close}<br><br>${ps}`;
}

/**
 * D178 — write the Josh Osborn / Insight close onto every step /
 * variant body. Subjects are untouched. Empty bodies stay empty.
 * Placeholders are stripped even when the close is already present.
 */
export function ensureInsightCloseOnSequences(sequences: SmartleadSequence[]): {
  sequences: SmartleadSequence[];
  changed: string[];
} {
  const changed: string[] = [];
  const fixBody = (body: string | undefined, label: string): string | undefined => {
    const text = String(body ?? "");
    if (!text.replace(/<[^>]+>/g, " ").trim()) return body;
    const next = ensureInsightClose(text);
    if (next === text) return body;
    changed.push(label);
    return next;
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
