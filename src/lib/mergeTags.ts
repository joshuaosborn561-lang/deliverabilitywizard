/**
 * D180 — merge tags / custom fields cannot silently send blank.
 *
 * Port of `scripts/check_merge_tags.py` (the pre-launch hard gate) into
 * the live campaign-check. System fields are allowlisted; everything
 * else must be a `custom_fields` key with a value on enough sampled
 * leads. Sent `email_message` bodies are a cheap second signal:
 * leftover `{{tag}}` or an obvious hole next to known merge context.
 *
 * Does not write sequence copy. Does not rewrite lead custom fields.
 */

import type { SmartleadSequence } from "../types/index.js";
import { sequenceCopyHay } from "./signatureQa.js";

export const MERGE_TAG_SYSTEM_FIELDS = [
  "email",
  "first_name",
  "last_name",
  "company_name",
  "phone_number",
  "website",
  "location",
  "linkedin_profile",
  "company_url",
] as const;

export const MERGE_TAG_SYSTEM_FIELD_SET: ReadonlySet<string> = new Set(
  MERGE_TAG_SYSTEM_FIELDS,
);

/** Smartlead mailbox / unsubscribe tokens — not lead custom fields. */
export const MERGE_TAG_BUILTINS: ReadonlySet<string> = new Set([
  "Signature",
  "signature",
  "unsubscribe",
  "Unsubscribe",
  "unSubscribe",
]);

/** A custom field must appear (non-empty) on at least this share. */
export const MIN_CUSTOM_COVERAGE = 0.8;

/** Lead-inventory growth that forces a resample before the next hourly. */
export const MERGE_TAG_LEAD_GROW_ABS = 50;
export const MERGE_TAG_LEAD_GROW_RATIO = 0.1;

export const MERGE_TAG_SAMPLE_PAGE = 40;
export const MERGE_TAG_SAMPLE_PAGES = 4;
export const MERGE_TAG_SENT_SAMPLE = 8;

const TAG_RE = /\{\{\s*([^{}]+?)\s*\}\}/g;

export function extractMergeTags(text: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  TAG_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = TAG_RE.exec(text)) !== null) {
    const name = match[1]!.trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    out.push(name);
  }
  return out;
}

export function isSystemMergeTag(tag: string): boolean {
  return MERGE_TAG_SYSTEM_FIELD_SET.has(tag);
}

export function isBuiltinMergeTag(tag: string): boolean {
  return MERGE_TAG_BUILTINS.has(tag);
}

export function isLeadCustomMergeTag(tag: string): boolean {
  return !isSystemMergeTag(tag) && !isBuiltinMergeTag(tag);
}

export function customMergeTags(tags: readonly string[]): string[] {
  return tags.filter(isLeadCustomMergeTag);
}

export function extractSequenceMergeTags(
  sequences: SmartleadSequence[] | null | undefined,
): { tags: string[]; customTags: string[]; bodies: Array<{ label: string; text: string }> } {
  const bodies = sequences?.length ? sequenceCopyHay(sequences) : [];
  const tags: string[] = [];
  const seen = new Set<string>();
  for (const row of bodies) {
    for (const tag of extractMergeTags(row.text)) {
      if (seen.has(tag)) continue;
      seen.add(tag);
      tags.push(tag);
    }
  }
  return { tags, customTags: customMergeTags(tags), bodies };
}

export function asObjectList(payload: unknown, ...keys: string[]): unknown[] {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== "object") return [];
  const row = payload as Record<string, unknown>;
  for (const key of keys) {
    const value = row[key];
    if (Array.isArray(value)) return value;
  }
  return [];
}

export function flattenCampaignLead(row: Record<string, unknown>): Record<string, unknown> {
  const nested =
    row.lead && typeof row.lead === "object" && !Array.isArray(row.lead)
      ? (row.lead as Record<string, unknown>)
      : null;
  if (!nested) return row;
  return {
    ...nested,
    ...row,
    custom_fields: nested.custom_fields ?? row.custom_fields,
  };
}

export function extractCampaignLeads(payload: unknown): Record<string, unknown>[] {
  return asObjectList(payload, "data", "leads", "results")
    .filter((row): row is Record<string, unknown> =>
      Boolean(row && typeof row === "object" && !Array.isArray(row)),
    )
    .map(flattenCampaignLead);
}

export function extractLeadTotal(payload: unknown): number {
  if (!payload || typeof payload !== "object") return 0;
  const row = payload as Record<string, unknown>;
  const nested =
    row.data && typeof row.data === "object" && !Array.isArray(row.data)
      ? (row.data as Record<string, unknown>)
      : null;
  for (const value of [
    row.total_leads,
    row.total,
    row.totalLeads,
    row.total_count,
    nested?.total_leads,
    nested?.total,
    nested?.totalLeads,
  ]) {
    const n = Number(value);
    if (Number.isFinite(n) && n > 0) return n;
  }
  const listed = extractCampaignLeads(payload);
  return listed.length;
}

export function customFieldKeys(lead: Record<string, unknown>): Set<string> {
  const fields = lead.custom_fields;
  if (!fields || typeof fields !== "object" || Array.isArray(fields)) {
    return new Set();
  }
  const out = new Set<string>();
  for (const [key, value] of Object.entries(fields as Record<string, unknown>)) {
    if (value == null) continue;
    if (typeof value === "string" && value.trim() === "") continue;
    out.add(key);
  }
  return out;
}

export function closeMergeKeyMatches(tag: string, keys: Iterable<string>): string[] {
  const needle = tag.toLowerCase().replace(/[_ ]/g, "");
  const hits: string[] = [];
  for (const key of [...keys].sort()) {
    const compact = key.toLowerCase().replace(/[_ ]/g, "");
    if (needle === compact || needle.includes(compact) || compact.includes(needle)) {
      hits.push(key);
    }
    if (hits.length >= 5) break;
  }
  return hits;
}

export function sampleLeadOffsets(
  total: number,
  pageSize = MERGE_TAG_SAMPLE_PAGE,
  pages = MERGE_TAG_SAMPLE_PAGES,
): number[] {
  if (total <= 0 || pages <= 1) return [0];
  const span = Math.max(0, total - pageSize);
  const offsets = new Set<number>();
  for (let i = 0; i < pages; i++) {
    offsets.add(Math.floor((span * i) / (pages - 1)));
  }
  return [...offsets].sort((a, b) => a - b);
}

export function leadInventoryGrew(
  previous: number | null | undefined,
  next: number,
): boolean {
  if (previous == null || previous <= 0) return next > 0;
  const delta = next - previous;
  if (delta < MERGE_TAG_LEAD_GROW_ABS) return false;
  return delta / previous >= MERGE_TAG_LEAD_GROW_RATIO || delta >= MERGE_TAG_LEAD_GROW_ABS * 2;
}

export interface MergeTagFill {
  tag: string;
  present: number;
  sampled: number;
  share: number;
  status: "ok" | "thin" | "absent";
  closest: string[];
  firstSeenIn?: string;
}

export function judgeMergeTagFill(input: {
  tags: readonly string[];
  leads: Array<Record<string, unknown>>;
  firstSeenIn?: Record<string, string>;
}): MergeTagFill[] {
  const sampled = input.leads.length;
  const coverage = new Map<string, number>();
  const allKeys = new Set<string>(MERGE_TAG_SYSTEM_FIELDS);
  for (const lead of input.leads) {
    const keys = customFieldKeys(lead);
    for (const key of keys) {
      allKeys.add(key);
      coverage.set(key, (coverage.get(key) ?? 0) + 1);
    }
  }

  const out: MergeTagFill[] = [];
  const seen = new Set<string>();
  for (const tag of input.tags) {
    if (seen.has(tag) || isSystemMergeTag(tag) || isBuiltinMergeTag(tag)) continue;
    seen.add(tag);
    const present = coverage.get(tag) ?? 0;
    const share = sampled > 0 ? present / sampled : 0;
    const status: MergeTagFill["status"] =
      present === 0 ? "absent" : share < MIN_CUSTOM_COVERAGE ? "thin" : "ok";
    out.push({
      tag,
      present,
      sampled,
      share,
      status,
      closest: closeMergeKeyMatches(tag, allKeys),
      firstSeenIn: input.firstSeenIn?.[tag],
    });
  }
  return out;
}

export function visibleCopyText(html: string): string {
  return String(html ?? "")
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<\/(?:div|p|span)>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    // Keep a double space — that is the blank-merge hole. Collapse
    // everything else so tags and newlines do not invent extras.
    .replace(/[ \t]*\n[ \t]*/g, " ")
    .replace(/ {3,}/g, "  ")
    .replace(/\t/g, " ")
    .trim();
}

export interface MergeTagHole {
  tag: string;
  kind: "literal" | "blank";
  sample: string;
}

/**
 * Cheap sent-body QA. Literal leftover `{{tag}}` is always a miss.
 * A blank hole is the left/right context of a custom tag with the
 * value gone ("shop with  on top" / "which  covers").
 */
export function detectSentMergeHoles(input: {
  sentBodies: readonly string[];
  customTags: readonly string[];
  sequenceTexts?: readonly string[];
}): MergeTagHole[] {
  const holes: MergeTagHole[] = [];
  const custom = new Set(input.customTags.filter(isLeadCustomMergeTag));
  if (!custom.size || !input.sentBodies.length) return holes;

  for (const body of input.sentBodies) {
    for (const tag of extractMergeTags(body)) {
      if (!custom.has(tag)) continue;
      holes.push({
        tag,
        kind: "literal",
        sample: clipSample(visibleCopyText(body), `{{${tag}}}`),
      });
    }
  }

  const contexts = blankHoleContexts(input.sequenceTexts ?? [], [...custom]);
  for (const body of input.sentBodies) {
    const visible = visibleCopyText(body);
    for (const ctx of contexts) {
      if (!visible.includes(ctx.hole)) continue;
      holes.push({
        tag: ctx.tag,
        kind: "blank",
        sample: clipSample(visible, ctx.hole),
      });
    }
  }
  return uniqueHoles(holes);
}

function blankHoleContexts(
  sequenceTexts: readonly string[],
  customTags: readonly string[],
): Array<{ tag: string; hole: string }> {
  const out: Array<{ tag: string; hole: string }> = [];
  const seen = new Set<string>();
  for (const text of sequenceTexts) {
    const visible = visibleCopyText(text);
    for (const tag of customTags) {
      const token = `{{${tag}}}`;
      let from = 0;
      for (;;) {
        const at = visible.indexOf(token, from);
        if (at < 0) break;
        const left = visible.slice(Math.max(0, at - 40), at);
        const right = visible.slice(at + token.length, at + token.length + 40);
        from = at + token.length;
        const leftWords = lastWords(left, 2);
        const rightWords = firstWords(right, 2);
        if (!leftWords || !rightWords) continue;
        // Immediate neighbors only — spintax after the tag must not
        // poison the hole ("on top..." vs "on top... Defender").
        const hole = `${leftWords}  ${rightWords}`;
        const key = `${tag}:${hole}`;
        if (seen.has(key) || hole.length < 10) continue;
        seen.add(key);
        out.push({ tag, hole });
      }
    }
  }
  return out;
}

function wordsOf(text: string): string[] {
  return text
    .trim()
    .split(/\s+/)
    .filter((word) => /[A-Za-z0-9]{2,}/.test(word));
}

function lastWords(text: string, n: number): string {
  return wordsOf(text).slice(-n).join(" ");
}

function firstWords(text: string, n: number): string {
  return wordsOf(text).slice(0, n).join(" ");
}

function clipSample(text: string, needle: string): string {
  const at = text.indexOf(needle);
  if (at < 0) return text.slice(0, 96);
  const start = Math.max(0, at - 24);
  const end = Math.min(text.length, at + needle.length + 24);
  return text.slice(start, end).trim();
}

function uniqueHoles(holes: MergeTagHole[]): MergeTagHole[] {
  const seen = new Set<string>();
  const out: MergeTagHole[] = [];
  for (const hole of holes) {
    const key = `${hole.kind}:${hole.tag}:${hole.sample}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(hole);
  }
  return out;
}

export function formatMergeTagFinding(input: {
  fills: MergeTagFill[];
  holes: MergeTagHole[];
}): string | null {
  const bad = input.fills.filter((row) => row.status !== "ok");
  if (!bad.length && !input.holes.length) return null;
  const parts: string[] = [];
  for (const row of bad) {
    const pct = `${Math.round(row.share * 100)}%`;
    const where = row.firstSeenIn ? `; first in ${row.firstSeenIn}` : "";
    const hint = row.closest.length ? `; closest: ${row.closest.join(", ")}` : "";
    if (row.status === "absent") {
      parts.push(
        `{{${row.tag}}} absent ${row.present}/${row.sampled} (${pct})${hint}${where}`,
      );
    } else {
      parts.push(
        `{{${row.tag}}} thin ${row.present}/${row.sampled} (${pct} < ${Math.round(MIN_CUSTOM_COVERAGE * 100)}%)${hint}${where}`,
      );
    }
  }
  if (input.holes.length) {
    const hole = input.holes[0]!;
    parts.push(
      `sent ${hole.kind} {{${hole.tag}}}: "${hole.sample}"`,
    );
  }
  return parts.join(" · ");
}

export function extractSentBodies(payload: unknown): string[] {
  const rows = asObjectList(payload, "data", "stats", "results");
  const out: string[] = [];
  for (const row of rows) {
    if (!row || typeof row !== "object" || Array.isArray(row)) continue;
    const rec = row as Record<string, unknown>;
    const body = rec.email_message ?? rec.emailMessage ?? rec.message ?? rec.body;
    if (typeof body === "string" && body.trim()) out.push(body);
  }
  return out;
}
