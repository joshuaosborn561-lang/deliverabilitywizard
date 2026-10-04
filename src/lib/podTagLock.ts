/**
 * D234 — an already-tagged POD-A or POD-B seat is immutable.
 * Only an untagged seat may receive a first POD tag. Dual-tagged
 * seats stay flagged (D223); this lock does not pick a side.
 */

import { podFromMailboxTags, type GenericAssignedPod } from "./genericPool.js";

export type PodSide = GenericAssignedPod;

export function existingPodTag(
  tags:
    | Array<{ tag_name?: unknown; name?: unknown }>
    | string[]
    | null
    | undefined,
): PodSide | null {
  return podFromMailboxTags(tags);
}

/** True only when this seat has no POD-A/POD-B tag yet. */
export function seatIsUntaggedForPod(
  tags:
    | Array<{ tag_name?: unknown; name?: unknown }>
    | string[]
    | null
    | undefined,
): boolean {
  return existingPodTag(tags) == null;
}

/**
 * A write is legal only when the seat is untagged (first tag) or
 * already carries exactly `want`. Never A→B or B→A.
 */
export function mayWritePodTag(
  tags:
    | Array<{ tag_name?: unknown; name?: unknown }>
    | string[]
    | null
    | undefined,
  want: PodSide,
): boolean {
  const existing = existingPodTag(tags);
  if (existing == null) return true;
  return existing === want;
}
