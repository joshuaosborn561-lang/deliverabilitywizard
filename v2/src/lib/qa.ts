import { STEP2_DELAY_DAYS } from "../canon/constants.js";

/** D180 — pages merge_tag_blank; never rewrites live copy or lead fields. */
export function mergeTagHoles(sample: {
  body?: string;
  customFields?: Record<string, string | null | undefined>;
}): string[] {
  const holes: string[] = [];
  const body = sample.body ?? "";
  const tags = [...body.matchAll(/\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g)].map((m) => m[1]!);
  for (const tag of tags) {
    if (tag.toLowerCase() === "signature") continue;
    const value = sample.customFields?.[tag];
    if (value == null || String(value).trim() === "") holes.push(tag);
  }
  return holes;
}

export function step2DelayWrong(delayInDays: number | null | undefined): boolean {
  if (delayInDays == null) return false;
  return delayInDays !== STEP2_DELAY_DAYS;
}
