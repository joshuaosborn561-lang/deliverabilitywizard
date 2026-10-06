/**
 * D223 / D236 / D237 — mechanical POD A/B rotation. Goliath stays
 * out of the fortnight swap. Active POC-engagement clients (Deep
 * Roots and later name-list matches except Goliath) are also
 * exempt — they have no PODs. PowerGRYD 592842 is a full client
 * and rotates. A seat tagged both POD-A and POD-B is a dual-POD
 * miss (flag only; do not guess which tag to keep).
 */

import { chicagoWallClock } from "./canonOpsHours.js";
import { GOLIATH_CLIENT_ID } from "./holdPolicy.js";

export const POWERGRYD_CLIENT_ID = 592842;
export { GOLIATH_CLIENT_ID };

export const POD_ROTATION_SKIP_CLIENT_IDS = [GOLIATH_CLIENT_ID] as const;

export const POD_TAG_A = "POD-A";
export const POD_TAG_B = "POD-B";

export function isPodRotationSkippedClient(
  clientId: number | null | undefined,
  extraSkipIds: Iterable<number> = [],
): boolean {
  if (clientId == null) return false;
  if (clientId === GOLIATH_CLIENT_ID) return true;
  return [...extraSkipIds].includes(clientId);
}

export function clientIdFromRestGroupKey(
  groupKey: string | null | undefined,
): number | null {
  const match = /^id:(\d+)$/.exec(String(groupKey ?? ""));
  if (!match) return null;
  const id = Number(match[1]);
  return Number.isFinite(id) && id > 0 ? id : null;
}

export function tagNamesUpper(
  tags: Array<{ tag_name?: unknown; name?: unknown }> | string[] | null | undefined,
): string[] {
  return (tags ?? []).map((tag) =>
    typeof tag === "string"
      ? tag.trim().toUpperCase()
      : String(tag.tag_name ?? tag.name ?? "").trim().toUpperCase(),
  );
}

export function hasDualPodTags(
  tags: Array<{ tag_name?: unknown; name?: unknown }> | string[] | null | undefined,
): boolean {
  const names = tagNamesUpper(tags);
  return names.includes(POD_TAG_A) && names.includes(POD_TAG_B);
}

export function podRotationIdleReason(
  now: Date = new Date(),
): string | undefined {
  const clock = chicagoWallClock(now);
  if (clock.weekday === 0 || clock.weekday === 6) {
    return "weekend (POD dual-tag flag is weekdays only)";
  }
  return undefined;
}

export function formatDualPodSlack(
  rows: Array<{ email: string; clientName: string; clientId: number | null }>,
): string | null {
  if (!rows.length) return null;
  const byClient = new Map<string, typeof rows>();
  for (const row of rows) {
    const key = `${row.clientName}::${row.clientId ?? "none"}`;
    const list = byClient.get(key) ?? [];
    list.push(row);
    byClient.set(key, list);
  }
  const blocks = [
    "POD rotation flag: seats tagged both POD-A and POD-B. I did not pick a side.",
  ];
  for (const group of byClient.values()) {
    const first = group[0]!;
    const heading =
      first.clientId != null
        ? `*${first.clientName}* (${first.clientId})`
        : `*${first.clientName}*`;
    blocks.push(heading);
    for (const row of group) {
      blocks.push(`  ${row.email} has POD-A and POD-B`);
    }
  }
  return blocks.join("\n");
}
