/**
 * D303 — per-variant spam tests. Every A/B variant of a campaign's
 * tested sequence step gets its own placement test and its own
 * canary-copy test, instead of one test per campaign.
 */

import type { SmartleadSequence, SmartleadSequenceVariant } from "../types/index.js";

export interface SequenceVariantTarget {
  /** Stable key used for coverage and test names (variant label, else id, else index). */
  key: string;
  /** Human label shown in the test name, e.g. "A". */
  label: string;
  /** SmartDelivery sequence_mapping_id for this variant. */
  mappingId: number;
  subject: string;
  body: string;
  /** 0-based position in the step's variant list. */
  index: number;
}

function variantList(sequence: SmartleadSequence): SmartleadSequenceVariant[] {
  const lists = [sequence.sequence_variants, sequence.variants, sequence.seq_variants];
  for (const list of lists) {
    if (Array.isArray(list) && list.length) return list;
  }
  return [];
}

function letter(index: number): string {
  return index < 26 ? String.fromCharCode(65 + index) : String(index + 1);
}

/**
 * Variants of one sequence step. A step without A/B variants yields one
 * target that uses the step's own id, so single-copy campaigns are tested
 * exactly as before.
 */
export function sequenceVariantTargets(
  sequence: SmartleadSequence,
  fallbackMappingId?: number,
): SequenceVariantTarget[] {
  const variants = variantList(sequence);
  const out: SequenceVariantTarget[] = [];
  const seen = new Set<string>();
  variants.forEach((variant, index) => {
    const mappingId =
      typeof variant.id === "number" && variant.id > 0 ? variant.id : undefined;
    if (mappingId === undefined) return;
    const label = String(variant.variant_label ?? "").trim() || letter(index);
    let key = label.toUpperCase();
    if (seen.has(key)) key = `${key}-${mappingId}`;
    seen.add(key);
    out.push({
      key,
      label,
      mappingId,
      subject: String(variant.subject ?? sequence.subject ?? "").trim(),
      body: String(variant.email_body ?? sequence.email_body ?? ""),
      index,
    });
  });
  if (out.length) return out;
  const mappingId =
    typeof sequence.id === "number" && sequence.id > 0 ? sequence.id : fallbackMappingId;
  if (mappingId === undefined) return [];
  return [
    {
      key: "A",
      label: "A",
      mappingId,
      subject: String(sequence.subject ?? "").trim(),
      body: String(sequence.email_body ?? ""),
      index: 0,
    },
  ];
}

/** Test-name suffix. Single-variant campaigns keep their old names. */
export function variantTestSuffix(
  target: Pick<SequenceVariantTarget, "label">,
  total: number,
): string {
  return total > 1 ? ` [variant ${target.label}]` : "";
}

const VARIANT_SUFFIX_RE = /\[variant ([^\]]+)\]/;

export function variantLabelFromTestName(name: string | undefined): string | undefined {
  const match = String(name ?? "").match(VARIANT_SUFFIX_RE);
  return match ? match[1]!.trim() : undefined;
}

/**
 * Variants still owed a placement test. Legacy campaign-level coverage
 * (a record with no variant keys) counts as covering the first variant.
 */
export function uncoveredVariants(
  targets: SequenceVariantTarget[],
  covered: { keys?: string[] | null; legacyCampaignCovered?: boolean },
): SequenceVariantTarget[] {
  const keys = new Set((covered.keys ?? []).map((k) => k.toUpperCase()));
  return targets.filter((target) => {
    if (keys.has(target.key.toUpperCase())) return false;
    if (!covered.keys && covered.legacyCampaignCovered && target.index === 0) return false;
    return true;
  });
}
