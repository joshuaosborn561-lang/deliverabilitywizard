/**
 * D216 — fingerprint live campaign copy so the 7am America/New_York
 * brief can name new campaigns and new sequence variants for Cayden.
 * Shells stay off the list. An edit of an existing variant id is not
 * a new variant.
 */

import { isAnyShellCampaign } from "./canaryShell.js";
import { isWordHuntShellCampaign } from "./wordHuntShell.js";
import type { SmartleadCampaign, SmartleadSequence } from "../types/index.js";

export interface CopyNoticeCampaignBook {
  name: string;
  status: string;
  variantKeys: string[];
}

export type CopyNoticeBook = Record<string, CopyNoticeCampaignBook>;

export interface CopyNoticeNewCampaign {
  id: number;
  name: string;
  status: string;
}

export interface CopyNoticeNewVariant {
  campaignId: number;
  campaignName: string;
  label: string;
}

export interface CopyNoticeDiff {
  newCampaigns: CopyNoticeNewCampaign[];
  newVariants: CopyNoticeNewVariant[];
}

export function isCopyNoticeCampaign(
  campaign: { id?: number | null; name?: string | null; status?: string | null },
  pinnedPodControlId?: number,
): boolean {
  if (isAnyShellCampaign(campaign, pinnedPodControlId)) return false;
  if (isWordHuntShellCampaign(campaign)) return false;
  const status = String(campaign.status ?? "").toUpperCase();
  if (status === "COMPLETED" || status === "STOPPED") return false;
  return typeof campaign.id === "number";
}

export function sequencesFromPayload(payload: unknown): SmartleadSequence[] {
  if (Array.isArray(payload)) return payload as SmartleadSequence[];
  if (!payload || typeof payload !== "object") return [];
  const rec = payload as { data?: unknown; sequences?: unknown };
  if (Array.isArray(rec.sequences)) return rec.sequences as SmartleadSequence[];
  if (Array.isArray(rec.data)) return rec.data as SmartleadSequence[];
  return [];
}

function variantRows(step: SmartleadSequence): Array<{
  id?: number;
  subject?: string;
  email_body?: string;
  variant_label?: string;
}> {
  if (step.sequence_variants?.length) return step.sequence_variants;
  if (step.seq_variants?.length) return step.seq_variants;
  if (step.variants?.length) return step.variants;
  return [];
}

export function variantMarks(sequences: SmartleadSequence[]): Array<{
  key: string;
  label: string;
}> {
  const marks: Array<{ key: string; label: string }> = [];
  const seen = new Set<string>();
  for (const step of sequences) {
    const n = Number(step.seq_number);
    const stepNo = Number.isFinite(n) && n > 0 ? n : 1;
    const rows = variantRows(step);
    if (!rows.length) {
      const key = `step:${stepNo}:solo`;
      if (!seen.has(key)) {
        seen.add(key);
        marks.push({ key, label: `step ${stepNo}` });
      }
      continue;
    }
    rows.forEach((row, index) => {
      const letter =
        String(row.variant_label ?? "").trim() ||
        String.fromCharCode(65 + index);
      const key =
        typeof row.id === "number"
          ? `step:${stepNo}:id:${row.id}`
          : `step:${stepNo}:label:${letter}`;
      if (seen.has(key)) return;
      seen.add(key);
      marks.push({ key, label: `step ${stepNo} ${letter}` });
    });
  }
  return marks;
}

export function bookFromCampaign(
  campaign: Pick<SmartleadCampaign, "id" | "name" | "status">,
  sequences: SmartleadSequence[],
): CopyNoticeCampaignBook {
  return {
    name: String(campaign.name ?? campaign.id),
    status: String(campaign.status ?? ""),
    variantKeys: variantMarks(sequences).map((row) => row.key),
  };
}

export function diffCopyNotice(
  previous: CopyNoticeBook,
  current: CopyNoticeBook,
  marksByCampaign: Record<string, Array<{ key: string; label: string }>>,
): CopyNoticeDiff {
  const newCampaigns: CopyNoticeNewCampaign[] = [];
  const newVariants: CopyNoticeNewVariant[] = [];
  for (const [idKey, now] of Object.entries(current)) {
    const id = Number(idKey);
    const was = previous[idKey];
    if (!was) {
      newCampaigns.push({
        id,
        name: now.name,
        status: now.status,
      });
      continue;
    }
    const known = new Set(was.variantKeys);
    for (const mark of marksByCampaign[idKey] ?? []) {
      if (known.has(mark.key)) continue;
      newVariants.push({
        campaignId: id,
        campaignName: now.name,
        label: mark.label,
      });
    }
  }
  return { newCampaigns, newVariants };
}

export function caydenMentionPrefix(userIds: string[]): string {
  const mentions = userIds
    .map((id) => id.trim())
    .filter(Boolean)
    .map((id) => `<@${id}>`);
  return mentions.length ? mentions.join(" ") : "Cayden";
}

export function copyNoticeSlackText(
  diff: CopyNoticeDiff,
  userIds: string[],
): string | null {
  if (!diff.newCampaigns.length && !diff.newVariants.length) return null;
  const lines = [
    `${caydenMentionPrefix(userIds)}: new campaigns / variants overnight (America/New_York).`,
  ];
  if (diff.newCampaigns.length) {
    lines.push("", "*New campaigns*");
    for (const row of diff.newCampaigns) {
      const status = row.status ? ` (${row.status})` : "";
      lines.push(`• ${row.name} #${row.id}${status}`);
    }
  }
  if (diff.newVariants.length) {
    lines.push("", "*New variants*");
    for (const row of diff.newVariants) {
      lines.push(`• ${row.campaignName} #${row.campaignId}: ${row.label}`);
    }
  }
  lines.push("", "I have not changed the live email.");
  return lines.join("\n");
}
